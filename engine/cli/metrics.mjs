#!/usr/bin/env node
/**
 * Weekly review metrics CLI (I/O): collect the PRs merged into the default branch within the window, compute the
 * metrics (core/metrics.mjs documents what is measured and why) and append the report as a comment on the open issue
 * labelled `names.metricsLabel` (created, with the label, when missing). The report is in the project's language.
 *
 *   node .dev-process/engine/cli/metrics.mjs [--repo owner/name] [--days 7] [--dry-run]
 *
 * `--repo` defaults to GITHUB_REPOSITORY; `--dry-run` prints the report and writes nothing.
 * GitHub only for now (search API, default-branch commits, merge commits): a GitLab adapter would need its own
 * "merged changes since" and "labelled issue" calls.
 */
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregate, prMetrics, renderReport, reportIssue } from "../core/metrics.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { createForge } from "../forge/index.mjs";
import { reviewerFor } from "../reviewer/index.mjs";
import { parseArgs, repoRoot, runIfMain } from "./args.mjs";

const DAY = 24 * 3_600_000;
const day = (d) => d.toISOString().slice(0, 10);
const LABEL_COLOR = "5319e7";

/** Process items with bounded concurrency (a weekly run handles dozens of PRs: neither serial nor a rate-limit burst). */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** All pages of a search (the search API returns at most 1,000 results). */
export async function searchAll(rest, q) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const r = await rest.get(`/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
    items.push(...(r.items ?? []));
    if (items.length >= (r.total_count ?? 0) || !(r.items ?? []).length) break;
  }
  return items;
}

/**
 * What the metrics need about one merged PR: reviews, comments, threads and the merge commit's message. No files,
 * statuses or write access (the gate's loadChange would be wasted here).
 * @param mergeMessages  sha → message of the default-branch commits already fetched
 */
export async function loadForMetrics(forge, pr, mergeMessages) {
  const { rest } = forge;
  const base = `/repos/${forge.owner}/${forge.name}`;
  const threads = await forge.loadReviewThreads(pr.number);
  const [reviews, comments] = await Promise.all([rest.paginate(`${base}/pulls/${pr.number}/reviews`), rest.paginate(`${base}/issues/${pr.number}/comments`)]);
  // The merge commit's message (the merge queue records an AI review waiver there): look in the default-branch commits
  // already fetched, else fetch it. A failure fails the report instead of silently reading as "not waived": the waiver
  // count is the only record of people standing in for the AI review.
  let mergeMessage = "";
  if (pr.merge_commit_sha) {
    mergeMessage = mergeMessages.get(pr.merge_commit_sha) ?? (await rest.get(`${base}/commits/${pr.merge_commit_sha}`)).commit?.message ?? "";
  }
  return {
    mergeMessage,
    author: pr.user?.login,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at,
    labels: pr.labels ?? [],
    reviews: reviews.map((r) => ({ login: r.user?.login, type: r.user?.type, state: r.state, submittedAt: r.submitted_at, body: r.body, commitId: r.commit_id })),
    comments: comments.map((c) => ({ login: c.user?.login, type: c.user?.type, body: c.body, createdAt: c.created_at, updatedAt: c.updated_at })),
    threads,
  };
}

/**
 * Metrics of the last `days` days, ending at `now`.
 * @returns `{ body, aggregate, list, since, until }` (since / until as YYYY-MM-DD)
 */
export async function collectMetrics({ forge, policy, reviewer, days = 7, now = new Date(), concurrency = 4 }) {
  if (forge.id !== "github") throw new Error(`metrics: forge "${forge.id}" is not supported yet`);
  const { rest } = forge;
  const base = `/repos/${forge.owner}/${forge.name}`;
  const until = now;
  const since = new Date(until.getTime() - days * DAY);
  const branch = (await rest.get(base)).default_branch;

  // The search filters by day only: refetch each PR and keep those merged inside the window (fix PRs count from these too).
  const found = await searchAll(rest, `repo:${forge.owner}/${forge.name} is:pr is:merged base:${branch} merged:>=${day(since)}`);
  const prs = (await mapLimit(found, concurrency, (i) => rest.get(`${base}/pulls/${i.number}`))).filter(
    (p) => p.merged_at && Date.parse(p.merged_at) >= since.getTime(),
  );
  const commits = await rest.paginate(`${base}/commits?sha=${encodeURIComponent(branch)}&since=${since.toISOString()}`);
  const mergeMessages = new Map(commits.map((c) => [c.sha, c.commit?.message ?? ""]));
  const list = await mapLimit(prs, concurrency, async (p) => prMetrics({ ...(await loadForMetrics(forge, p, mergeMessages)), policy, reviewer }));

  const revert = new RegExp(policy.patterns.revert, "i");
  const fix = new RegExp(policy.patterns.fix, "i");
  const reverts = commits.filter((c) => revert.test(c.commit?.message ?? "")).length;
  const fixPrs = prs.filter((p) => fix.test(p.title ?? "")).length;
  const agg = aggregate(list, { reverts, fixPrs });
  const window = { since: day(since), until: day(until) };
  const body = renderReport(agg, { ...window, lang: policy.language, ai: reviewer.displayName, pr: forge.prTerm ?? "PR" });
  return { body, aggregate: agg, list, ...window };
}

/** Append the report to the open issue labelled names.metricsLabel; create the label and the issue when missing. Returns the issue number. */
export async function publishReport({ forge, policy, body, doc }) {
  const { rest } = forge;
  const base = `/repos/${forge.owner}/${forge.name}`;
  const label = policy.names.metricsLabel;
  const issues = await rest.get(`${base}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=1`);
  let number = issues?.[0]?.number;
  if (!number) {
    await rest.post(`${base}/labels`, { name: label, color: LABEL_COLOR }).catch(() => {}); // usually: already exists
    const issue = reportIssue(policy.language, { doc });
    number = (await rest.post(`${base}/issues`, { title: issue.title, labels: [label], body: issue.body })).number;
  }
  await rest.post(`${base}/issues/${number}/comments`, { body });
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
  const forge = createForge(policy, { repo });
  const reviewer = reviewerFor(policy.reviewer, { ciIdentity: forge.ciIdentity, accounts: policy.aiReview.accounts });
  const { body, aggregate: agg } = await collectMetrics({ forge, policy, reviewer, days });
  console.log(body);
  if (args["dry-run"]) return;
  const number = await publishReport({ forge, policy, body, doc: definitionsPath(root) });
  console.log(`[metrics] ${agg.prs} merged ${forge.prTerm ?? "PR"}(s); report appended to issue #${number}`);
}

runIfMain(import.meta.url, "metrics", main);
