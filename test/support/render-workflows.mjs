#!/usr/bin/env node
/**
 * Render the fixture answers in several variants into `<out>/<variant>/` (CI runs actionlint on the GitHub workflows and
 * parses the GitLab CI files as YAML; GitLab's own lint runs against a real instance in M6).
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
  "claude-en": { ...raw, language: "en", reviewer: "claude" },
  "gitlab-zh": {
    ...raw,
    forge: "gitlab",
    gitlab: { url: "https://gitlab.example.com", tier: "free" },
    reviewer: "claude",
    repo: "grp/sub/app",
    ci: { ...raw.ci, setup: [{ run: "npm ci" }], checks: [{ run: "npm run lint" }], tests: [{ run: "npm test" }], releaseGate: { name: "release-gate", steps: [{ run: "npm run e2e" }], runner: "self-hosted", timeoutMin: 40 }, testsRunner: "self-hosted", selfHostedLabels: ["mac"] },
  },
  "gitlab-en-premium": {
    ...raw,
    language: "en",
    forge: "gitlab",
    gitlab: { url: "https://gitlab.example.com", tier: "premium" },
    reviewer: "claude",
    repo: "grp/app",
    ci: { ...raw.ci, setup: [], checks: [{ run: "make lint" }], tests: [{ run: "make test" }], releaseGate: null, testsRunner: "hosted", selfHostedLabels: [] },
  },
};
for (const [name, a] of Object.entries(variants)) {
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  apply(dir, plan(dir, validateAnswers(a)));
  console.log(`rendered ${name}`);
}
