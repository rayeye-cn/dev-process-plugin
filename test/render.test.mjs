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
    const native = { ...answers, queue: { mode: "native" }, loops: { ...answers.loops, metrics: false } };
    writeFileSync(join(d, ".github/workflows/review-metrics.yml"), "# edited\n");
    const p = plan(d, native);
    assert.equal(statusOf(p, ".github/workflows/merge-queue.yml"), "remove");
    assert.equal(statusOf(p, ".github/workflows/review-metrics.yml"), "orphan");
    apply(d, p);
    assert.equal(existsSync(join(d, ".github/workflows/merge-queue.yml")), false);
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
