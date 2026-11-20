#!/usr/bin/env node
/**
 * Weekly review metrics CLI (I/O): collect the PRs merged into the default branch within the window, compute the
 * metrics (core/metrics.mjs documents what is measured and why) and append the report as a comment on the open issue
 * labelled `names.metricsLabel` (created, with the label, when missing). The report is in the project's language.
 *
 *   node .dev-process/engine/cli/metrics.mjs [--repo owner/name] [--days 7] [--dry-run]
 *
 * `--repo` defaults to GITHUB_REPOSITORY; `--dry-run` prints the report and writes nothing.
 * The forge supplies the merged changes, the default-branch commits and each change's reviews (`forge.metrics`) and the
 * report issue (`forge.issues`).
 */
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregate, prMetrics, renderReport, reportIssue } from "../core/metrics.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { openForge, issuesOf } from "../forge/index.mjs";
import { mapLimit } from "../forge/util.mjs";
import { reviewerOn } from "../reviewer/index.mjs";
import { parseArgs, repoRoot, runIfMain } from "./args.mjs";

const DAY = 24 * 3_600_000;
const day = (d) => d.toISOString().slice(0, 10);
const LABEL_COLOR = "5319e7";

/**
 * Metrics of the last `days` days, ending at `now`.
 * @returns `{ body, aggregate, list, since, until }` (since / until as YYYY-MM-DD)
 */
export async function collectMetrics({ forge, policy, reviewer, days = 7, now = new Date(), concurrency = 4 }) {
  if (!forge.metrics) throw new Error(`metrics: forge "${forge.id}" is not supported yet`);
  const until = now;
  const since = new Date(until.getTime() - days * DAY);
  const branch = await forge.defaultBranch();
  const changes = await forge.metrics.mergedSince(branch, since, concurrency);
  const commits = await forge.metrics.commitsSince(branch, since);
  const mergeMessages = new Map(commits.map((c) => [c.sha, c.message]));
  const list = await mapLimit(changes, concurrency, async (c) => prMetrics({ ...(await forge.metrics.load(c, mergeMessages)), policy, reviewer }));

  const revert = new RegExp(policy.patterns.revert, "i");
  const fix = new RegExp(policy.patterns.fix, "i");
  const reverts = commits.filter((c) => revert.test(c.message)).length;
  const fixPrs = changes.filter((c) => fix.test(c.title)).length;
  const agg = aggregate(list, { reverts, fixPrs });
  const window = { since: day(since), until: day(until) };
  const body = renderReport(agg, { ...window, lang: policy.language, ai: reviewer.displayName, pr: forge.prTerm ?? "PR" });
  return { body, aggregate: agg, list, ...window };
}

/** Append the report to the open issue labelled names.metricsLabel; create the label and the issue when missing. Returns the issue number. */
export async function publishReport({ forge, policy, body, doc }) {
  const issues = issuesOf(forge);
  const label = policy.names.metricsLabel;
  let number = (await issues.newestOpen(label))?.number;
  if (!number) {
    await issues.ensureLabel(label, LABEL_COLOR);
    const issue = reportIssue(policy.language, { doc });
    number = await issues.create({ title: issue.title, labels: [label], body: issue.body });
  }
  await issues.comment(number, body);
  return number;
}

/** Where the metric definitions live, relative to the repository root (quoted in the issue body). */
export function definitionsPath(root) {
  const rel = relative(root, fileURLToPath(new URL("../core/metrics.mjs", import.meta.url))).split(sep).join("/");
  return rel && !rel.startsWith("..") ? rel : "engine/core/metrics.mjs";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = typeof args.repo === "string" ? args.repo : process.env.GITHUB_REPOSITORY;
  const days = typeof args.days === "string" ? Number(args.days) : 7;
  if (!repo || !(days > 0)) {
    console.error("usage: metrics.mjs [--repo owner/name] [--days 7] [--dry-run] (or set GITHUB_REPOSITORY)");
    process.exitCode = 2;
    return;
  }
  const root = repoRoot();
  const policy = loadPolicy(root);
  const forge = await openForge(policy, { repo });
  const reviewer = reviewerOn(policy, forge);
  const { body, aggregate: agg } = await collectMetrics({ forge, policy, reviewer, days });
  console.log(body);
  if (args["dry-run"]) return;
  const number = await publishReport({ forge, policy, body, doc: definitionsPath(root) });
  console.log(`[metrics] ${agg.prs} merged ${forge.prTerm ?? "PR"}(s); report appended to issue #${number}`);
}

runIfMain(import.meta.url, "metrics", main);
