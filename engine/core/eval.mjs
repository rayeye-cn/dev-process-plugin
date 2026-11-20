/**
 * Review eval, pure parts (I/O in cli/review-eval.mjs). After the Claude Code team's practice: the PRs that caused
 * incidents are the eval set, and the review is scored against it every week.
 *
 * Cases live in `policy.paths.evalCases` (a JSON array):
 * - `kind: "bug"`: the PR that introduced a problem (`introducingPr`, `baseSha` / `headSha`), the file and line range of
 *   the problem (`file`, `lines: [from, to]`, in the head version) and the PR that fixed it (`fixPr`). Hit = the AI
 *   reported the same file with a line inside the range ± `policy.eval.lineSlack`; the right file alone is a "file hit".
 * - `kind: "clean"`: a PR known to be fine; every finding on it counts as a false positive.
 *
 * What this measures: an AI CLI given the SAME repository instructions as the AI code review on PRs, reviewing the diff —
 * whether "instructions + model" catch the problem. It is not the hosted PR review product itself (a workflow token cannot
 * request that by name). After changing the review instructions, check here first that the score did not drop.
 * Like a real review, the reviewer sees the whole repository (a read-only checkout of the PR head, read-only tools only):
 * many problems only show against files outside the diff (retired-symbol lists, counts and allow-lists in guard tests).
 * Pointers to such project files come from `policy.eval.promptHints`.
 * When the AI CLI did not run it leaves no output file; scoring counts that as "no usable output", never as "missed".
 */
import { readFileSync } from "node:fs";

import { assertCli, FINDING_TOKEN, findingFormat, NONE_TOKEN, parseFindings, saysNone } from "./findings.mjs";
import { t } from "./messages/index.mjs";
import { DEFAULTS } from "./policy.mjs";

/** At most this many findings are asked for per case. */
export const EVAL_MAX_FINDINGS = 10;
/** Where new cases come from (the incident review template rendered into the repository). */
export const INCIDENT_TEMPLATE = "docs/incident-review-template.md";
/** Where the scoring method is documented in the vendored engine (this file's header). */
export const METHOD_DOC = ".dev-process/engine/core/eval.mjs";

/** The diff helpers are shared with the classifier (same truncation and docs-last ordering). */
export { orderDiff, truncateBytes } from "./classify.mjs";

/** The cases file: a JSON array (an empty one is fine — a new project has no incidents yet). */
export function loadCases(file) {
  const cases = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(cases)) throw new Error(`${file}: expected a JSON array of cases`);
  return cases;
}

/**
 * The prompt for one case.
 * @param opts.cli           "copilot" | "claude": which read-only tools the model is told it may use
 * @param opts.hints         policy.eval.promptHints: project-specific lines (files worth checking outside the diff)
 * @param opts.maxDiffBytes  the diff budget (named in the truncation note)
 * @param opts.pr            "PR" | "MR" (wording only)
 */
export function buildEvalPrompt(instructions, c, diff, truncated, { lang, cli, hints = [], maxDiffBytes = DEFAULTS.eval.maxDiffBytes, pr = "PR" }) {
  assertCli(cli);
  return [
    t(lang, "eval.prompt.task", { pr }),
    t(lang, "eval.prompt.repo", { pr, cli }),
    ...hints,
    t(lang, "eval.prompt.lines", { pr, max: EVAL_MAX_FINDINGS }),
    t(lang, "eval.prompt.untrusted"),
    "",
    t(lang, "eval.prompt.criteria"),
    instructions,
    "",
    findingFormat(lang),
    "",
    t(lang, "eval.prompt.header", { pr, number: c.introducingPr, truncated, maxBytes: maxDiffBytes }),
    "```diff",
    diff,
    "```",
  ].join("\n");
}

/**
 * Can the AI's output be scored: at least one valid FINDING ⇒ those findings; an explicit NONE line ⇒ [];
 * anything else (an error, a refusal, "cannot read the repository", a wrong format) ⇒ null: no usable output, which
 * counts neither as "missed" nor as "no false positives".
 */
export function usableFindings(raw) {
  const findings = parseFindings(raw);
  if (findings.length) return findings;
  return saysNone(raw) ? [] : null;
}

/** The score of one case. */
export function scoreCase(c, findings, lineSlack = DEFAULTS.eval.lineSlack) {
  if (c.kind === "clean") return { id: c.id, kind: "clean", falsePositives: findings.length, findings: findings.length };
  const sameFile = findings.filter((f) => f.file === c.file);
  const [start, end] = c.lines;
  const hit = sameFile.some((f) => f.line >= start - lineSlack && f.line <= end + lineSlack);
  return { id: c.id, kind: "bug", hit, fileHit: sameFile.length > 0, findings: findings.length };
}

export function summarize(scores) {
  // Cases without output (the AI CLI did not run) are counted apart: neither "missed" nor "no false positives".
  const bugs = scores.filter((s) => s.kind === "bug" && !s.missing);
  const clean = scores.filter((s) => s.kind === "clean" && !s.missing);
  return {
    bugCases: bugs.length,
    hits: bugs.filter((s) => s.hit).length,
    fileHits: bugs.filter((s) => s.fileHit).length,
    cleanCases: clean.length,
    falsePositives: clean.reduce((n, s) => n + s.falsePositives, 0),
    missingOutput: scores.filter((s) => s.missing).length,
  };
}

/**
 * Does this round count as a result: no case with usable output ⇒ no, and the previous report is not overwritten.
 * That happened in the reference project: with the organization's AI budget at $0, every case answered "budget limit
 * reached", the job still showed green, and it overwrote the last real result with an empty report.
 * Whenever any case has no output the job fails (see the CLI): a partial failure must be seen too, and the report names
 * the cases that were not scored.
 */
export function evalUsable(scores) {
  return scores.some((s) => !s.missing);
}

/**
 * The report (markdown).
 * @param ctx `{ lang, pr, casesFile, template, method }`
 */
export function renderEval(cases, scores, sum, when, { lang, pr = "PR", casesFile = DEFAULTS.paths.evalCases, template = INCIDENT_TEMPLATE, method = METHOD_DOC }) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const rows = scores.map((s) => {
    const c = byId.get(s.id);
    if (s.missing) return `| ${s.id} | ${c.kind} | #${c.introducingPr} | ${t(lang, "eval.row.missing")} | — |`;
    if (s.kind === "clean") return `| ${s.id} | clean | #${c.introducingPr} | ${t(lang, "eval.row.clean", { n: s.falsePositives })} | ${s.findings} |`;
    return `| ${s.id} | bug | #${c.introducingPr} | ${t(lang, "eval.row.bug", { hit: s.hit, fileHit: s.fileHit, file: c.file, lines: c.lines })} | ${s.findings} |`;
  });
  return [
    t(lang, "eval.report.title", { when }),
    "",
    t(lang, "eval.report.summary", { ...sum, finding: FINDING_TOKEN, none: NONE_TOKEN }),
    "",
    t(lang, "eval.report.columns", { pr }),
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    t(lang, "eval.report.footer", { method, template, cases: casesFile }),
  ].join("\n");
}

/** The report when there are no cases yet (a new project): not a failure, nothing to score. */
export function renderNoCases(when, { lang, pr = "PR", casesFile = DEFAULTS.paths.evalCases, template = INCIDENT_TEMPLATE }) {
  return [t(lang, "eval.report.title", { when }), "", t(lang, "eval.noCases", { pr, cases: casesFile, template })].join("\n");
}
