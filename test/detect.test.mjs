// Repository detection: remotes, language, stack-specific CI proposals, risky paths.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { cjkShare, detectLocal, hostOf, nodeCi, repoFromRemote } from "../tools/detect.mjs";
import { validateAnswers } from "../tools/answers.mjs";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const repo = (files) => {
  const d = mkdtempSync(join(tmpdir(), "dp-detect-"));
  dirs.push(d);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, ".."), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("remote", "add", "origin", "git@github.com:acme/sample-app.git");
  g("-c", "user.name=Alice", "-c", "user.email=alice@example.com", "add", "-A");
  g("-c", "user.name=Alice", "-c", "user.email=alice@example.com", "commit", "-q", "-m", "init");
  return d;
};

describe("helpers", () => {
  it("remotes", () => {
    assert.equal(repoFromRemote("git@github.com:acme/app.git"), "acme/app");
    assert.equal(repoFromRemote("https://github.com/acme/app"), "acme/app");
    assert.equal(repoFromRemote("https://gitlab.example.com/a/b.git"), null);
    assert.equal(hostOf("git@gitlab.example.com:a/b.git"), "gitlab.example.com");
    assert.equal(hostOf("https://user@ghe.corp.com/a/b"), "ghe.corp.com");
    assert.equal(hostOf("https://github.com/a/b"), "github.com");
  });

  it("language share", () => {
    assert.ok(cjkShare("这是一个中文的说明文档 with a few words") > 0.4);
    assert.equal(cjkShare("plain English only"), 0);
  });

  it("node CI: package manager, real checks, the default test placeholder is no test", () => {
    const files = new Set(["package.json", "pnpm-lock.yaml"]);
    const ci = nodeCi({ scripts: { lint: "eslint .", typecheck: "tsc", dev: "vite", test: "echo \"Error: no test specified\" && exit 1" } }, files);
    assert.deepEqual(ci.checks.map((c) => c.run), ["pnpm lint", "pnpm typecheck"]);
    assert.deepEqual(ci.tests, []);
    assert.equal(ci.setup.at(-1).run, "pnpm install --frozen-lockfile");
    assert.equal(nodeCi({ scripts: { test: "vitest run" } }, new Set(["package-lock.json"])).tests[0].run, "npm test");
  });
});

describe("detectLocal", () => {
  it("a Node repository: proposal validates once people are added", () => {
    const d = repo({
      "package.json": JSON.stringify({ name: "sample-app", description: "demo", scripts: { lint: "eslint .", test: "vitest run" } }),
      "package-lock.json": "{}",
      "README.md": "# Sample\n\nA sample app.\n",
      "CHANGELOG.md": "x",
      "CLAUDE.md": "x",
      "docs/a.md": "x",
      "src/auth/login.ts": "x",
      "db/migrations/001.sql": "x",
    });
    const { facts, proposal } = detectLocal(d);
    assert.deepEqual(facts.stack, ["node"]);
    assert.equal(facts.language, "en");
    assert.equal(facts.existing.claudeMd, true);
    assert.equal(proposal.repo, "acme/sample-app");
    assert.equal(proposal.defaultBranch, "main");
    assert.ok(proposal.paths.high.includes("src/auth/**"));
    assert.ok(proposal.paths.high.includes("db/migrations/**"));
    assert.ok(proposal.paths.high.includes("package.json"));
    assert.ok(proposal.paths.security.includes("src/auth/**"));
    assert.deepEqual(proposal.paths.lowOnly, ["docs/**", "CHANGELOG.md", "README.md"]); // CLAUDE.md never low
    assert.equal(facts.authors[0].email, "alice@example.com");
    const a = validateAnswers({ ...proposal, people: { trustedAuthors: ["alice"] } });
    assert.equal(a.ci.checks[0].run, "npm run lint");
  });

  it("a Chinese Go repository", () => {
    const d = repo({ "go.mod": "module x", "README.md": "# 示例\n\n这是一个用来演示的中文项目说明。\n" });
    const { facts, proposal } = detectLocal(d);
    assert.deepEqual(facts.stack, ["go"]);
    assert.equal(proposal.language, "zh");
    assert.equal(proposal.ci.tests[0].run, "go test ./...");
  });
});

describe("GitLab", async () => {
  const { detectGitlab, projectFromRemote } = await import("../tools/detect.mjs");
  it("nested project paths from https and ssh remotes", () => {
    assert.equal(projectFromRemote("https://gl.example.com/grp/sub/app.git"), "grp/sub/app");
    assert.equal(projectFromRemote("git@gl.example.com:grp/app.git"), "grp/app");
    assert.equal(projectFromRemote("ssh://git@gl.example.com:2222/grp/sub/app"), "grp/sub/app");
    assert.equal(projectFromRemote("https://gl.example.com/app"), null);
  });
  const fake = (codes) => async (url) => {
    const path = new URL(url).pathname.replace(/^\/api\/v4/, "");
    const hit = Object.entries(codes).find(([k]) => path.endsWith(k));
    const [status, body] = hit ? hit[1] : [404, { message: "404" }];
    return new Response(JSON.stringify(body), { status });
  };
  const base = { "/metadata": [200, { version: "17.11.2-ee", enterprise: true }], "/projects/grp%2Fapp": [200, { default_branch: "main" }], "/members/all": [200, [{ username: "alice", access_level: 30 }, { username: "guest", access_level: 10 }, { username: "project_1_bot_x", access_level: 40, bot: true }]] };
  it("tier by probing: CE 404 / EE without a license 403 ⇒ free; approval rules 200 ⇒ premium; status checks 200 ⇒ ultimate", async () => {
    const run = (extra) => detectGitlab("https://gl.example.com", "grp/app", { token: "t", fetch: fake({ ...base, ...extra }) });
    const free = await run({ "/approval_rules": [403, {}], "/external_status_checks": [401, {}] });
    assert.deepEqual([free.tier, free.versionOk, free.edition, free.members], ["free", true, "ee", ["alice"]]);
    assert.equal((await run({ "/approval_rules": [200, []], "/external_status_checks": [401, {}] })).tier, "premium");
    assert.equal((await run({ "/approval_rules": [200, []], "/external_status_checks": [200, []] })).tier, "ultimate");
    const old = await detectGitlab("https://gl.example.com", "grp/app", { token: "t", fetch: fake({ ...base, "/metadata": [200, { version: "17.10.0", enterprise: false }] }) });
    assert.deepEqual([old.versionOk, old.edition], [false, "ce"]);
  });
});

