// The renderer's plan/apply semantics on temporary git repositories (the plan/apply suite needs the real templates).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { validateAnswers } from "../tools/answers.mjs";
import { apply, findSection, LOCK_PATH, plan, SECTION_BEGIN, SECTION_END } from "../tools/render.mjs";

const answers = validateAnswers(JSON.parse(readFileSync(new URL("./fixtures/answers.json", import.meta.url), "utf8")));
const dirs = [];
const tempRepo = () => {
  const d = mkdtempSync(join(tmpdir(), "dp-render-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const statusOf = (p, path) => p.entries.find((e) => e.path === path)?.status;

describe("sections", () => {
  it("finds the marked section", () => {
    const text = `a\n${SECTION_BEGIN}\nx\n${SECTION_END}\nb\n`;
    const s = findSection(text);
    assert.equal(text.slice(0, s.start) + text.slice(s.end), "a\nb\n");
    assert.equal(findSection("no markers"), null);
  });
});

describe("plan and apply", { skip: !existsSync(new URL("../templates/common/zh/CLAUDE.section.md.tmpl", import.meta.url)) && "templates not written yet" }, () => {
  it("a fresh repository: everything is created, then a second render changes nothing", () => {
    const d = tempRepo();
    const p1 = plan(d, answers);
    assert.ok(p1.entries.every((e) => ["create"].includes(e.status)), p1.entries.filter((e) => e.status !== "create").map((e) => `${e.status} ${e.path}`).join("\n"));
    apply(d, p1);
    assert.ok(existsSync(join(d, LOCK_PATH)));
    const p2 = plan(d, answers);
    assert.deepEqual([...new Set(p2.entries.map((e) => e.status))].sort(), ["keep", "unchanged"]);
  });

  it("an untouched generated file updates; an edited one conflicts and blocks until forced", () => {
    const d = tempRepo();
    apply(d, plan(d, answers));
    const en = { ...answers, language: "en" };
    const p = plan(d, en);
    assert.equal(statusOf(p, ".github/pull_request_template.md"), "update");
    writeFileSync(join(d, ".github/pull_request_template.md"), "my own template\n");
    const p2 = plan(d, en);
    assert.equal(statusOf(p2, ".github/pull_request_template.md"), "conflict");
    assert.throws(() => apply(d, p2), /conflicts: .*pull_request_template/);
    apply(d, p2, { force: new Set([".github/pull_request_template.md"]) });
    assert.notEqual(readFileSync(join(d, ".github/pull_request_template.md"), "utf8"), "my own template\n");
  });

  it("CLAUDE.md: an existing file gets our section appended; the rest stays; later renders replace only the section", () => {
    const d = tempRepo();
    writeFileSync(join(d, "CLAUDE.md"), "# Mine\n\nKeep this.\n");
    const p = plan(d, answers);
    assert.equal(statusOf(p, "CLAUDE.md"), "insert");
    apply(d, p);
    const text = readFileSync(join(d, "CLAUDE.md"), "utf8");
    assert.ok(text.startsWith("# Mine\n\nKeep this.\n\n" + SECTION_BEGIN));
    writeFileSync(join(d, "CLAUDE.md"), text.replace("Keep this.", "Keep this, edited."));
    const p2 = plan(d, { ...answers, language: "en" });
    assert.equal(statusOf(p2, "CLAUDE.md"), "update"); // only outside the section changed
    apply(d, p2);
    assert.ok(readFileSync(join(d, "CLAUDE.md"), "utf8").includes("Keep this, edited."));
  });

  it("outputs that are no longer produced are removed when untouched, kept as orphans when edited", () => {
    const d = tempRepo();
    apply(d, plan(d, answers));
    const fewer = { ...answers, loops: { ...answers.loops, eval: false, metrics: false } };
    writeFileSync(join(d, ".github/workflows/review-metrics.yml"), "# edited\n");
    const p = plan(d, fewer);
    assert.equal(statusOf(p, ".github/workflows/review-eval.yml"), "remove");
    assert.equal(statusOf(p, ".github/workflows/review-metrics.yml"), "orphan");
    apply(d, p);
    assert.equal(existsSync(join(d, ".github/workflows/review-eval.yml")), false);
    assert.equal(existsSync(join(d, ".github/workflows/review-metrics.yml")), true);
  });

  it("the eval cases are seeded once and never overwritten", () => {
    const d = tempRepo();
    apply(d, plan(d, answers));
    const cases = join(d, ".dev-process/review-evals/cases.json");
    writeFileSync(cases, '[{"id":"x"}]\n');
    const p = plan(d, answers);
    assert.equal(statusOf(p, ".dev-process/review-evals/cases.json"), "keep");
    apply(d, p);
    assert.equal(readFileSync(cases, "utf8"), '[{"id":"x"}]\n');
  });
});

describe("the CLI, as the init skill runs it", () => {
  const RENDER = new URL("../tools/render.mjs", import.meta.url).pathname;
  const raw = readFileSync(new URL("./fixtures/answers.json", import.meta.url), "utf8");
  const run = (repoDir, ...args) => {
    try {
      const out = execFileSync(process.execPath, [RENDER, "--answers", join(repoDir, ".dev-process/answers.json"), "--target", repoDir, ...args], { encoding: "utf8" });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  const withAnswers = (text) => {
    const d = tempRepo();
    execFileSync("mkdir", ["-p", join(d, ".dev-process")]);
    writeFileSync(join(d, ".dev-process/answers.json"), text);
    return d;
  };

  it("hand-written answers are not a conflict; write; then everything is unchanged (exit 0 throughout)", () => {
    const d = withAnswers(raw);
    assert.equal(run(d).code, 0);
    const w = run(d, "--write");
    assert.equal(w.code, 0, w.out);
    assert.match(readFileSync(join(d, ".dev-process/answers.json"), "utf8"), /"version": 1/);
    const again = run(d, "--json");
    assert.equal(again.code, 0);
    assert.deepEqual([...new Set(JSON.parse(again.out).map((e) => e.status))].sort(), ["keep", "unchanged"]);
  });

  it("exit 2 on bad answers, 3 on a conflict, 4 when the written result is inconsistent", () => {
    assert.equal(run(withAnswers('{"repo":"x"}')).code, 2);
    const d = withAnswers(raw);
    execFileSync("mkdir", ["-p", join(d, ".github")]);
    writeFileSync(join(d, ".github/CODEOWNERS"), "* @someone\n");
    const c = run(d, "--write");
    assert.equal(c.code, 3, c.out);
    assert.match(c.out, /conflict\s+\.github\/CODEOWNERS/);
    const bad = JSON.parse(raw);
    bad.people.codeOwners = ["alice", "dave"]; // dave is not a trusted author
    const e = run(withAnswers(JSON.stringify(bad)), "--write");
    assert.equal(e.code, 4, e.out);
    assert.match(e.out, /ERROR/);
  });
});

describe("options that are not available yet", () => {
  it("plan refuses the native queue with a clear reason", async () => {
    const { AnswersError } = await import("../tools/answers.mjs");
    const d = tempRepo();
    assert.throws(() => plan(d, { ...answers, queue: { mode: "native" } }), (e) => e instanceof AnswersError && /queue\.mode: "native" is not available yet/.test(e.message));
  });

  it("Claude: the review workflow and our instruction files, no Copilot files; the rendered setup passes the local doctor", async () => {
    const { localFindings } = await import("../engine/cli/doctor.mjs");
    const { buildPrompt } = await import("../engine/cli/ai-review.mjs");
    const d = tempRepo();
    const p = plan(d, { ...answers, language: "en", reviewer: "claude" });
    const paths = p.entries.map((e) => e.path);
    for (const f of [".github/workflows/claude-review.yml", ".dev-process/ai-review/instructions.md", ".dev-process/ai-review/security.md"]) assert.ok(paths.includes(f), f);
    assert.deepEqual(paths.filter((f) => !f.startsWith(".dev-process/engine/") && /copilot|\.github\/instructions\//.test(f)), []);
    apply(d, p);
    assert.deepEqual(localFindings(d, p.ctx.policy).filter((f) => f.level === "error"), []);
    const prompt = buildPrompt({ policy: p.ctx.policy, root: d, repo: "o/r", number: "7", sha: "a".repeat(40) });
    assert.match(prompt, /<!-- ai-review:claude sha=a{40} -->/);
    assert.ok(prompt.includes(readFileSync(join(d, ".dev-process/ai-review/instructions.md"), "utf8").trim().split("\n")[0]));
  });

  it("GitLab: .gitlab files only, no .github; the rendered setup passes the local doctor; no template text left", async () => {
    const { localFindings } = await import("../engine/cli/doctor.mjs");
    const d = tempRepo();
    const a = validateAnswers({ ...answers, forge: "gitlab", gitlab: { url: "https://gl.example.com", tier: "free" }, reviewer: "claude", repo: "grp/sub/app", people: { trustedAuthors: ["john.doe", "jane"] }, paths: { high: ["src/auth/**"], security: ["src/auth/**"], lowOnly: ["docs/**"] }, ci: { ...answers.ci, setup: [{ run: "npm ci" }], checks: [{ run: "npm run lint" }], tests: [{ run: "npm test" }], releaseGate: null } });
    const p = plan(d, a);
    const paths = p.entries.map((e) => e.path).filter((f) => !f.startsWith(".dev-process/engine/"));
    for (const f of [".gitlab-ci.yml", ".gitlab/dev-process.gitlab-ci.yml", ".gitlab/CODEOWNERS", ".gitlab/merge_request_templates/Default.md", "docs/dev-process/review-setup.md"]) assert.ok(paths.includes(f), f);
    assert.deepEqual(paths.filter((f) => f.startsWith(".github/")), []);
    apply(d, p);
    assert.deepEqual(localFindings(d, p.ctx.policy).filter((f) => f.level === "error"), []);
    for (const f of [".gitlab-ci.yml", ".gitlab/dev-process.gitlab-ci.yml", "docs/dev-process/review-setup.md", "CLAUDE.md"]) {
      const text = readFileSync(join(d, f), "utf8");
      assert.doesNotMatch(text, /\{\{|\}\}/, f);
      assert.doesNotMatch(text, /GitHub Actions|\.github\//, f);
    }
    const bot = readFileSync(join(d, ".gitlab/dev-process.gitlab-ci.yml"), "utf8");
    assert.match(bot, /claude --bare --restricted --strict-mcp-config/);
    assert.match(bot, /^review-eval:$/m, "the review eval runs on GitLab too");
    assert.ok(paths.includes(".dev-process/review-evals/README.md"));
    assert.match(readFileSync(join(d, ".gitlab/CODEOWNERS"), "utf8"), /^\/\.gitlab-ci\.yml @john\.doe @jane$/m);
  });

  it("Copilot without security paths: no security file, and the instructions still load", async () => {
    const { reviewInstructions } = await import("../engine/core/findings.mjs");
    const d = tempRepo();
    const a = { ...answers, paths: { ...answers.paths, security: [] }, loops: { ...answers.loops, sweep: false } };
    const p = plan(d, a);
    assert.equal(p.entries.some((e) => e.path === ".github/instructions/security.instructions.md"), false);
    apply(d, p);
    assert.ok(reviewInstructions(d, p.ctx.policy).length > 100);
  });
});
