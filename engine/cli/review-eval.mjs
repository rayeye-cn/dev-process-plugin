#!/usr/bin/env node
/**
 * Review eval CLI (I/O). The scoring method is in core/eval.mjs; the AI output contract in core/findings.mjs.
 *
 *   node .dev-process/engine/cli/review-eval.mjs list                              # case ids (the workflow runs them one by one)
 *   node .dev-process/engine/cli/review-eval.mjs prompt <id> [--cli copilot|claude] > prompt.txt   # diff of the introducing PR, from local git
 *   (cd <read-only checkout of that PR's head> && <AI CLI with read-only tools>) > out/<id>.txt
 *   node .dev-process/engine/cli/review-eval.mjs score --out-dir out [--report-issue [--repo owner/name]]
 *
 * Cases: `policy.paths.evalCases`. Diff budget: `policy.eval.maxDiffBytes` (the instructions take room in the prompt
 * too; one command-line argument is capped at 128 KB on Linux). Line slack: `policy.eval.lineSlack`.
 * `score` exits 1 when any case has no usable output (and leaves the report issue alone when none has); a cases file
 * that is still empty is NOT a failure — a new project has no incidents yet.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildEvalPrompt, evalUsable, loadCases, orderDiff, renderEval, renderNoCases, scoreCase, summarize, truncateBytes, usableFindings } from "../core/eval.mjs";
import { reviewInstructions } from "../core/findings.mjs";
import { t } from "../core/messages/index.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { createForge } from "../forge/index.mjs";
import { parseArgs, repoRoot, runIfMain } from "./args.mjs";

const USAGE = "usage: review-eval.mjs list | prompt <id> [--cli copilot|claude] | score --out-dir <dir> [--report-issue [--repo owner/name]]";
const LABEL_COLOR = "1d76db";

/** "PR" or "MR" without creating a forge (only `score --report-issue` talks to the forge). */
const prTerm = (policy) => (policy.forge === "gitlab" ? "MR" : "PR");

/**
 * Keep one open report issue with the eval label: edit the newest open one, or create it. No forge method covers issues
 * yet, so this goes through the GitHub adapter's REST client.
 */
export async function upsertReportIssue(forge, policy, body) {
  if (forge.id !== "github") throw new Error(`review-eval: report issues on forge "${forge.id}" are not supported yet`);
  const base = `/repos/${forge.owner}/${forge.name}`;
  const label = policy.names.evalLabel;
  const issues = await forge.rest.get(`${base}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=1`);
  if (issues?.[0]) {
    await forge.rest.patch(`${base}/issues/${issues[0].number}`, { body });
    return issues[0].number;
  }
  await forge.rest.post(`${base}/labels`, { name: label, color: LABEL_COLOR }).catch(() => {});
  return (await forge.rest.post(`${base}/issues`, { title: t(policy.language, "eval.issue.title"), labels: [label], body })).number;
}

/**
 * Score the outputs in `outDir` (`<id>.txt`; a missing file = the AI CLI did not run) and report.
 * @param forge  where to keep the report issue, or null (no --report-issue)
 * @returns the exit code: 0, or 1 when any case has no usable output
 */
export async function score({ policy, cases, outDir, forge = null, when = new Date().toISOString().slice(0, 10), env = process.env, log = console.log, warn = console.error }) {
  const ctx = { lang: policy.language, pr: forge?.prTerm ?? prTerm(policy), casesFile: policy.paths.evalCases };
  const summary = (body) => {
    log(body);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${body}\n`);
  };
  if (!cases.length) {
    // A new project: nothing to score and nothing to report. Not a failure, and no empty report issue.
    summary(renderNoCases(when, ctx));
    warn(`[review-eval] no cases yet in ${policy.paths.evalCases}: nothing to score`);
    return 0;
  }
  const scores = cases.map((c) => {
    const f = join(outDir, `${c.id}.txt`);
    const findings = existsSync(f) ? usableFindings(readFileSync(f, "utf8")) : null;
    return findings ? scoreCase(c, findings, policy.eval.lineSlack) : { id: c.id, kind: c.kind, missing: true };
  });
  const body = renderEval(cases, scores, summarize(scores), when, ctx);
  summary(body);
  if (!evalUsable(scores)) {
    // Keep the previous report and fail: an AI CLI that did not run (budget, quota, policy) must not look like a run.
    warn(`[review-eval] none of the ${scores.length} case(s) has usable output (did the AI CLI run? check each case's output); report not updated`);
    return 1;
  }
  if (forge) await upsertReportIssue(forge, policy, body);
  const missing = scores.filter((s) => s.missing).length;
  if (missing) {
    warn(`[review-eval] ${missing}/${scores.length} case(s) have no usable output (not scored, named in the report); failing the job`);
    return 1;
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!["list", "prompt", "score"].includes(cmd)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const root = repoRoot();
  const policy = loadPolicy(root);
  const cases = loadCases(join(root, policy.paths.evalCases));

  if (cmd === "list") {
    for (const c of cases) console.log(c.id);
    return;
  }
  if (cmd === "prompt") {
    const c = cases.find((x) => x.id === args._[1]);
    if (!c) throw new Error(`no such case: ${args._[1]}`);
    // The shas become git arguments: only hex (a value like `--output=…` would be read as an option).
    for (const sha of [c.baseSha, c.headSha]) if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new Error(`case ${c.id}: bad sha "${sha}" (expected hex)`);
    const diff = execFileSync("git", ["diff", "--no-color", c.baseSha, c.headSha], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const { text, truncated } = truncateBytes(orderDiff(diff, policy.lowOnlyPaths), policy.eval.maxDiffBytes);
    const cli = typeof args.cli === "string" ? args.cli : policy.reviewer;
    const opts = { lang: policy.language, cli, hints: policy.eval.promptHints, maxDiffBytes: policy.eval.maxDiffBytes, pr: prTerm(policy) };
    process.stdout.write(buildEvalPrompt(reviewInstructions(root, policy), c, text, truncated, opts));
    return;
  }
  const forge = args["report-issue"] ? createForge(policy, { repo: typeof args.repo === "string" ? args.repo : undefined }) : null;
  const outDir = typeof args["out-dir"] === "string" ? args["out-dir"] : "out";
  process.exitCode = await score({ policy, cases, outDir, forge });
}

runIfMain(import.meta.url, "review-eval", main);
