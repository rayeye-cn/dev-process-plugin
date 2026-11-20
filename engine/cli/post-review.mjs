#!/usr/bin/env node
/**
 * GitLab: post Claude's review of one merge request as the process bot (core/post-review.mjs says what is posted), then
 * re-run the gate for it. Runs only in the bot's job (it needs DEV_PROCESS_TOKEN); the review itself ran elsewhere and
 * left its answer in a file.
 *
 *   node .dev-process/engine/cli/post-review.mjs --pr <iid> --head-sha <sha> --review-file <file> [--outcome <outcome>]
 *   node .dev-process/engine/cli/post-review.mjs --dir <dir>     # what cli/gitlab-review.mjs prepared and Claude wrote
 *
 * --head-sha: the commit that was reviewed. When the MR has moved on, nothing is posted (that push gets its own review).
 * --outcome: how the review run ended (success | failure | skipped | cancelled); with no usable answer the bot leaves a
 * notice instead (no key, the run failed, or it finished without an answer), which the gate quotes and never counts.
 * Nothing is posted twice: a head that already has a review (after the latest target change) is left alone.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { reviewDecision, verifyDecision, hasNotice } from "../core/ai-review.mjs";
import { extractText } from "../core/ai-output.mjs";
import { parseOutput as parseClassifier } from "../core/classify.mjs";
import { tr } from "../core/messages/index.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { parseReview, planReview } from "../core/post-review.mjs";
import { openForge } from "../forge/index.mjs";
import { claudeNoticeMarker } from "../reviewer/claude.mjs";
import { reviewerOn } from "../reviewer/index.mjs";
import { parseArgs, repoName, repoRoot, runIfMain } from "./args.mjs";
import { judgeChange } from "./risk-gate.mjs";

const USAGE = "usage: post-review.mjs (--dir <dir> | --pr <iid> --head-sha <40-hex sha> --review-file <file> [--outcome success|failure|skipped|cancelled]) [--repo group/name]";

const readIf = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);

/**
 * The review job's directory → `{ number, sha, raw, outcome, keySet, classifier, skip }`. `skip`: the head moved before
 * the review ran (nothing to post).
 */
export function readReviewDir(dir) {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const state = (readIf(join(dir, "state")) ?? "").trim();
  const outcome = (readIf(join(dir, "outcome")) ?? "").trim() || (state === "no-key" ? "skipped" : "failure");
  const cls = readIf(join(dir, "classify.json"));
  const parsed = cls ? parseClassifier(extractText(cls)) : null;
  return {
    number: String(meta.pr),
    sha: String(meta.sha),
    raw: state === "ready" ? readIf(join(dir, "review.json")) : null,
    outcome,
    keySet: Boolean(meta.keySet),
    classifier: parsed ? { tier: parsed.tier, reason: parsed.reason } : null,
    skip: state === "superseded",
  };
}

/**
 * @returns `{ posted: "review" | "notice" | null, reason, threads? }`
 */
export async function postReview({ forge, policy, reviewer, number, sha, raw, outcome = "success", keySet = true, env = process.env, log = console.log }) {
  const change = await forge.loadChange(number, { baseHint: env.BASE_CHANGED_AT || null });
  const d = reviewDecision({ reviewer, change, eventHead: sha, forks: true });
  if (!d.review) {
    log(`[post-review] !${number}: ${d.reason}; nothing posted`);
    return { posted: null, reason: d.reason };
  }
  const review = raw == null ? null : parseReview(raw);
  if (!review) {
    // No usable answer: the same notices as on GitHub ("success" without an answer ⇒ noSummary).
    const v = verifyDecision({ reviewer, change, eventHead: sha, outcome, keySet });
    if (!v.notice) return { posted: null, reason: v.reason };
    const body = `${claudeNoticeMarker(change.headSha)}\n${tr(policy.language, v.notice)}`;
    if (hasNotice(change.comments, forge.ciIdentity, body, change.baseChangedAt)) return { posted: null, reason: "posted" };
    await forge.postComment(number, body);
    log(`[post-review] !${number}: no usable review (${outcome}); left a notice (${v.notice.code})`);
    return { posted: "notice", reason: v.notice.code };
  }
  const target = await forge.reviewTarget(number);
  if (target.headSha !== sha) {
    log(`[post-review] !${number}: the head moved to ${target.headSha.slice(0, 12)} while reviewing; nothing posted`);
    return { posted: null, reason: "superseded" };
  }
  const secrets = [env.ANTHROPIC_API_KEY, env.DEV_PROCESS_TOKEN, env.GITLAB_TOKEN, env.CI_JOB_TOKEN];
  const plan = planReview(review, target.diffs, { sha, maxComments: policy.aiReview.maxComments, lang: policy.language, pr: forge.prTerm, secrets });
  let onDiff = 0;
  // Threads first, the summary last: the gate counts the review from the summary, and then every thread must be there.
  for (const th of plan.threads) {
    const r = await forge.createThread(number, { ...th, diffRefs: target.diffRefs });
    if (r.onDiff) onDiff++;
  }
  await forge.postComment(number, plan.summary);
  log(`[post-review] !${number}: posted ${plan.threads.length} thread(s) (${onDiff} on diff lines) and the summary for ${sha.slice(0, 12)}`);
  return { posted: "review", reason: "run", threads: plan.threads.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  let job;
  if (typeof args.dir === "string") job = readReviewDir(args.dir);
  else {
    const file = typeof args["review-file"] === "string" ? args["review-file"] : "";
    const raw = file ? readIf(file) : null;
    job = { number: typeof args.pr === "string" ? args.pr : "", sha: typeof args["head-sha"] === "string" ? args["head-sha"] : "", raw, outcome: typeof args.outcome === "string" ? args.outcome : raw ? "success" : "failure", keySet: env.KEY_SET !== "false", classifier: null, skip: false, file };
    if (!file) job.number = "";
  }
  if (!/^\d+$/.test(job.number) || !/^[0-9a-f]{40}$/.test(job.sha)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (job.skip) {
    console.log(`[post-review] !${job.number}: the head moved before the review ran; nothing to post`);
    return;
  }
  const root = repoRoot();
  const policy = loadPolicy(root);
  const forge = await openForge(policy, { repo: repoName(args, root) });
  const reviewer = reviewerOn(policy, forge);
  const out = await postReview({ forge, policy, reviewer, number: job.number, sha: job.sha, raw: job.raw, outcome: job.outcome, keySet: job.keySet, env });
  // The gate sees the review (or the notice) and the classifier's second opinion now, not at the next event.
  const cls = job.classifier ? { CLASSIFIER_TIER: job.classifier.tier, CLASSIFIER_REASON: job.classifier.reason, CLASSIFIER_SHA: job.sha } : {};
  if (out.posted || job.classifier) await judgeChange({ forge, policy, reviewer, number: job.number, env: cls });
}

runIfMain(import.meta.url, "post-review", main);
