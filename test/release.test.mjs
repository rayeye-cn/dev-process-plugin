// Release detection: which base the versions are compared with (ported from the reference implementation's
// detect-release cases), the release rule from the policy, and the CLI against fake git / forge and a real repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { detectRelease, labelsFromEnv, readVersions } from "../engine/cli/detect-release.mjs";
import { baseRefFor, changedVersions, hasLabel, isRelease, readField } from "../engine/core/release.mjs";
import { policy } from "./helpers.mjs";

const BASE = "0123456789abcdef0123456789abcdef01234567";

describe("which base the versions are compared with", () => {
  it("a PR event compares with the PR's base; the merge queue (and its post-merge re-run) with the base it passes", () => {
    assert.equal(baseRefFor({ event: "pull_request", prBaseSha: BASE }), BASE);
    // No PR base ⇒ still detect (default branch, the label counts), not "skip".
    assert.equal(baseRefFor({ event: "pull_request", prBaseSha: "", defaultBranch: "main" }), "origin/main");
    assert.equal(baseRefFor({ event: "workflow_dispatch", queuePr: "130", baseInput: BASE, defaultBranch: "main" }), BASE);
    // No base passed (a manual re-run by PR number) ⇒ the default branch.
    assert.equal(baseRefFor({ event: "workflow_dispatch", queuePr: "130", baseInput: "", defaultBranch: "trunk" }), "origin/trunk");
  });

  it("a manual run without a PR number ⇒ no detection; a malformed base or PR number throws", () => {
    assert.equal(baseRefFor({ event: "workflow_dispatch", queuePr: "", defaultBranch: "main" }), null);
    assert.equal(baseRefFor({ event: "push" }), null);
    assert.throws(() => baseRefFor({ event: "workflow_dispatch", queuePr: "130", baseInput: "main; rm -rf /" }), /40-character/);
    assert.throws(() => baseRefFor({ event: "workflow_dispatch", queuePr: "13 0", baseInput: BASE }), /PR number/);
  });
});

describe("the release rule", () => {
  it("a changed version or the release label ⇒ release", () => {
    assert.equal(isRelease({ versions: [{ base: "0.0.6", head: "0.0.7" }], labeled: false }), true);
    assert.equal(isRelease({ versions: [{ base: "0.0.7", head: "0.0.7" }], labeled: true }), true);
    assert.equal(isRelease({ versions: [{ base: "0.0.7", head: "0.0.7" }], labeled: false }), false);
    assert.equal(isRelease({}), false);
  });

  it("any of several version files counts; a file added or removed counts as a change", () => {
    const versions = [
      { file: "package.json", field: "version", base: "1.0.0", head: "1.0.0" },
      { file: "app/manifest.json", field: "meta.version", base: "3", head: "4" },
      { file: "new.json", field: "version", base: undefined, head: "1" },
    ];
    assert.deepEqual(
      changedVersions(versions).map((v) => v.file),
      ["app/manifest.json", "new.json"],
    );
    assert.equal(isRelease({ versions: versions.slice(0, 1) }), false);
    assert.equal(isRelease({ versions }), true);
  });

  it("fields are read by dotted path; labels by name from the policy", () => {
    assert.equal(readField({ version: "1" }, "version"), "1");
    assert.equal(readField({ tool: { version: "2" } }, "tool.version"), "2");
    assert.equal(readField({ tool: "x" }, "tool.version"), undefined);
    assert.equal(hasLabel(["bug", "release"], "release"), true);
    assert.equal(hasLabel([{ name: "ship" }], "ship"), true);
    assert.equal(hasLabel(["release"], ""), false);
    assert.equal(hasLabel(null, "release"), false);
  });

  it("pull_request labels come from PR_LABELS (JSON) or the reference's PR_HAS_RELEASE_LABEL", () => {
    assert.deepEqual(labelsFromEnv({ PR_LABELS: '["release","bug"]' }, "release"), ["release", "bug"]);
    assert.deepEqual(labelsFromEnv({ PR_HAS_RELEASE_LABEL: "true" }, "ship"), ["ship"]);
    assert.deepEqual(labelsFromEnv({ PR_HAS_RELEASE_LABEL: "false" }, "ship"), []);
    assert.throws(() => labelsFromEnv({ PR_LABELS: "{}" }, "release"), /JSON array/);
  });
});

/** Fake git: `files` maps `<ref>:<path>` to content; `refs` lists known refs. */
function fakeGit({ refs = [BASE], files = {} } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    const [cmd, ...rest] = args;
    const target = rest.at(-1);
    if (cmd === "rev-parse") {
      if (!refs.includes(target.replace(/\^\{commit\}$/, ""))) throw new Error("unknown revision");
      return `${BASE}\n`;
    }
    if (cmd === "cat-file" || cmd === "show") {
      if (!(target in files)) throw new Error(`path does not exist in ${target}`);
      return cmd === "show" ? files[target] : "";
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  git.calls = calls;
  return git;
}

function headDir(files) {
  const root = mkdtempSync(join(tmpdir(), "dp-release-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

describe("detect-release CLI", () => {
  const quiet = () => {};
  const pkg = (version) => JSON.stringify({ name: "x", version });

  it("a PR that bumps the version ⇒ release; the job summary is in the project's language", async () => {
    const root = headDir({ "package.json": pkg("1.0.1") });
    try {
      const git = fakeGit({ files: { [`${BASE}:package.json`]: pkg("1.0.0") } });
      const env = { EVENT: "pull_request", PR_BASE_SHA: BASE, PR_LABELS: "[]", DEFAULT_BRANCH: "main" };
      const out = await detectRelease({ policy, env, root, git, log: quiet });
      assert.equal(out.release, true);
      assert.equal(out.ref, BASE);
      assert.deepEqual(out.versions, [{ file: "package.json", field: "version", base: "1.0.0", head: "1.0.1" }]);
      assert.equal(out.summary, `发版检测（基线 \`${BASE}\`）：\`package.json\` version: 1.0.0 → 1.0.1；\`release\` 标签：无 ⇒ 跑发版门禁`);
      const enOut = await detectRelease({ policy: { ...policy, language: "en" }, env, root, git, log: quiet });
      assert.equal(enOut.summary, `Release detection (base \`${BASE}\`): \`package.json\` version: 1.0.0 → 1.0.1; \`release\` label: no ⇒ release gate runs`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("same version: only the label from the policy makes it a release", async () => {
    const root = headDir({ "package.json": pkg("1.0.0") });
    try {
      const git = fakeGit({ files: { [`${BASE}:package.json`]: pkg("1.0.0") } });
      const env = { EVENT: "pull_request", PR_BASE_SHA: BASE, DEFAULT_BRANCH: "main" };
      assert.equal((await detectRelease({ policy, env: { ...env, PR_LABELS: '["bug"]' }, root, git, log: quiet })).release, false);
      assert.equal((await detectRelease({ policy, env: { ...env, PR_LABELS: '["release"]' }, root, git, log: quiet })).release, true);
      const shipPolicy = { ...policy, release: { ...policy.release, label: "ship" } };
      assert.equal((await detectRelease({ policy: shipPolicy, env: { ...env, PR_LABELS: '["release"]' }, root, git, log: quiet })).release, false);
      assert.equal((await detectRelease({ policy: shipPolicy, env: { ...env, PR_LABELS: '["ship"]' }, root, git, log: quiet })).release, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a merge-queue run compares with the base it passes and reads the PR's labels through the forge", async () => {
    const root = headDir({ "package.json": pkg("2.0.0") });
    try {
      const git = fakeGit({ files: { [`${BASE}:package.json`]: pkg("2.0.0") } });
      const asked = [];
      const ops = { defaultBranch: async () => "main", prLabels: async (n) => (asked.push(n), ["release"]) };
      const env = { EVENT: "workflow_dispatch", QUEUE_PR: "130", BASE_INPUT: BASE, DEFAULT_BRANCH: "main", PR_LABELS: "[]" };
      const out = await detectRelease({ policy, env, root, git, ops, log: quiet });
      assert.equal(out.ref, BASE);
      assert.equal(out.labeled, true);
      assert.equal(out.release, true);
      assert.deepEqual(asked, ["130"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no DEFAULT_BRANCH ⇒ the default branch comes from the forge", async () => {
    const root = headDir({ "package.json": pkg("1.0.0") });
    try {
      const git = fakeGit({ refs: ["origin/trunk"], files: { "origin/trunk:package.json": pkg("0.9.0") } });
      const ops = { defaultBranch: async () => "trunk", prLabels: async () => [] };
      const out = await detectRelease({ policy, env: { EVENT: "pull_request", PR_BASE_SHA: "" }, root, git, ops, log: quiet });
      assert.equal(out.ref, "origin/trunk");
      assert.equal(out.release, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("other events ⇒ release=false without git or forge", async () => {
    const git = fakeGit();
    const ops = {
      defaultBranch: async () => assert.fail("no forge call"),
      prLabels: async () => assert.fail("no forge call"),
    };
    const out = await detectRelease({ policy, env: { EVENT: "workflow_dispatch", QUEUE_PR: "" }, root: "/nonexistent", git, ops, log: quiet });
    assert.equal(out.release, false);
    assert.deepEqual(git.calls, []);
    assert.equal(out.summary, "发版检测：workflow_dispatch 事件且不是合并队列的运行 ⇒ 不跑发版门禁");
  });

  it("a base missing from the checkout is an error (shallow clone), not a silent release", () => {
    assert.throws(() => readVersions({ ref: "deadbeef", files: [{ file: "package.json", field: "version" }], root: "/x", git: fakeGit() }), /fetch-depth/);
  });

  it("reads the base from a real git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "dp-release-git-"));
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", stdio: "pipe" });
    try {
      git("init", "-q");
      writeFileSync(join(root, "package.json"), pkg("1.0.0"));
      writeFileSync(join(root, "meta.json"), JSON.stringify({ app: { version: "7" } }));
      git("add", ".");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD").trim();
      writeFileSync(join(root, "package.json"), pkg("1.1.0"));
      const files = [
        { file: "package.json", field: "version" },
        { file: "meta.json", field: "app.version" },
        { file: "added.json", field: "version" },
      ];
      writeFileSync(join(root, "added.json"), pkg("0.1.0"));
      assert.deepEqual(readVersions({ ref: base, files, root }), [
        { file: "package.json", field: "version", base: "1.0.0", head: "1.1.0" },
        { file: "meta.json", field: "app.version", base: "7", head: "7" },
        { file: "added.json", field: "version", base: undefined, head: "0.1.0" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GitLab labels", () => {
  it("comma lists: the MR pipeline's CI_MERGE_REQUEST_LABELS and the queue's DEV_PROCESS_LABELS", () => {
    assert.deepEqual(labelsFromEnv({ PR_LABELS_CSV: "release, risk:low" }, "release"), ["release", "risk:low"]);
    assert.deepEqual(labelsFromEnv({ PR_LABELS_CSV: "" }, "release"), []);
  });
});

