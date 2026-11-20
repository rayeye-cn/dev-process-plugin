#!/usr/bin/env node
/**
 * Render the fixture answers in several variants into `<out>/<variant>/` (CI runs actionlint on the workflows).
 *   node test/support/render-workflows.mjs <out-dir>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { validateAnswers } from "../../tools/answers.mjs";
import { apply, plan } from "../../tools/render.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: render-workflows.mjs <out-dir>");
const raw = JSON.parse(readFileSync(new URL("../fixtures/answers.json", import.meta.url), "utf8"));
const variants = {
  "fixture-zh": raw,
  en: { ...raw, language: "en" },
  "self-hosted-tests-no-release": { ...raw, ci: { ...raw.ci, testsRunner: "self-hosted", releaseGate: null } },
  "checks-only-no-classifier": { ...raw, classifier: false, ci: { ...raw.ci, tests: [], releaseGate: null } },
};
for (const [name, a] of Object.entries(variants)) {
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  apply(dir, plan(dir, validateAnswers(a)));
  console.log(`rendered ${name}`);
}
