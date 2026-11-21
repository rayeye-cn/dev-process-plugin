// Role agents in the renderer: the team file and the role instructions (seeded once); a bad team fails at validation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AnswersError, validateAnswers } from "../tools/answers.mjs";
import { apply, plan } from "../tools/render.mjs";

const raw = JSON.parse(readFileSync(new URL("./fixtures/answers.json", import.meta.url), "utf8"));
const TEAM = {
  version: 1,
  people: [
    { login: "lead-a", roles: ["product", "ops"], lead: true },
    { login: "dev-b", roles: ["dev"] },
  ],
  roles: {
    product: { instructions: ".dev-process/agents/product.md", next: ["dev"], paths: [".prd/**"], tools: ["Read", "Grep", "Glob", "Edit", "Write"], triage: true },
    dev: { instructions: ".dev-process/agents/dev.md", next: ["product"], paths: ["**"], tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"], allow: ["Bash(npm test *)"] },
    ops: { instructions: ".dev-process/agents/ops.md", paths: ["ops/**"] },
  },
  neverNotify: ["quiet-x"],
};
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), "agents-render-"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  return d;
};

test("a team renders team.json (with the language) and seeds each role's instructions", () => {
  const d = repo();
  const a = validateAnswers({ ...raw, language: "en", team: TEAM });
  apply(d, plan(d, a));
  const team = JSON.parse(readFileSync(join(d, ".dev-process/team.json"), "utf8"));
  assert.equal(team.language, "en");
  assert.deepEqual(team.neverNotify, ["quiet-x"]);
  assert.match(readFileSync(join(d, ".dev-process/agents/dev.md"), "utf8"), /^# Engineering role agent/);
  assert.match(readFileSync(join(d, ".dev-process/agents/ops.md"), "utf8"), /"ops" role agent/);
  // the team edits its instructions: a re-render keeps them
  writeFileSync(join(d, ".dev-process/agents/dev.md"), "# ours\n");
  const again = plan(d, a);
  assert.equal(again.entries.find((e) => e.path === ".dev-process/agents/dev.md").status, "keep");
  apply(d, again);
  assert.equal(readFileSync(join(d, ".dev-process/agents/dev.md"), "utf8"), "# ours\n");
});

test("no team, no agent files", () => {
  const d = repo();
  const p = plan(d, validateAnswers(raw));
  assert.ok(!p.entries.some((e) => e.path.startsWith(".dev-process/agents/") || e.path === ".dev-process/team.json"));
});

test("a bad team fails validation naming the field", () => {
  assert.throws(() => validateAnswers({ ...raw, team: { ...TEAM, neverNotify: ["dev-b"] } }), (e) => e instanceof AnswersError && /answers\.team: people\[1\]\.login/.test(e.message));
});
