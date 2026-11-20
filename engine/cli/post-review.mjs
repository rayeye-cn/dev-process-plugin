#!/usr/bin/env node
/**
 * GitLab: post Claude's review of one merge request as the process bot (core/post-review.mjs says what is posted), then
 * re-run the gate for it. Runs only in the bot's job (it needs DEV_PROCESS_TOKEN); the review itself ran elsewhere and
 * left its answer in a file.
 *
 *   node .dev-process/engine/cli/post-review.mjs --pr <iid> --head-sha <sha> --review-file <file> [--outcome <outcome>]
 *
 * --head-sha: the commit that was reviewed. When the MR has moved on, nothing is posted (that push gets its own review).
 * --outcome: how the review run ended (success | failure | skipped | cancelled); with no usable answer the bot leaves a
 * notice instead (no key, the run failed, or it finished without an answer), which the gate quotes and never counts.
 * Nothing is posted twice: a head that already has a review (after the latest target change) is left alone.
 */
import { existsSync, readFileSync } from "node:fs";

import { reviewDecision, verifyDecision, hasNotice } from "../core/ai-review.mjs";
import { tr } from "../core/messages/index.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { parseReview, planReview } from "../core/post-review.mjs";
import { openForge } from "../forge/index.mjs";
import { claudeNoticeMarker } from "../reviewer/claude.mjs";
import { reviewerOn } from "../reviewer/index.mjs";
import { parseArgs, repoName, repoRoot, runIfMain } from "./args.mjs";
import { judgeChange } from "./risk-gate.mjs";

const USAGE = "usage: post-review.mjs --pr <iid> --head-sha <40-hex sha> --review-file <file> [--outcome success|failure|skipped|cancelled] [--repo group/name]";

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
  const number = typeof args.pr === "string" ? args.pr : "";
  const sha = typeof args["head-sha"] === "string" ? args["head-sha"] : "";
  const file = typeof args["review-file"] === "string" ? args["review-file"] : "";
  if (!/^\d+$/.test(number) || !/^[0-9a-f]{40}$/.test(sha) || !file) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const root = repoRoot();
  const policy = loadPolicy(root);
  const forge = await openForge(policy, { repo: repoName(args, root) });
  const reviewer = reviewerOn(policy, forge);
  const raw = existsSync(file) ? readFileSync(file, "utf8") : null;
  const outcome = typeof args.outcome === "string" ? args.outcome : raw ? "success" : "failure";
  const env = process.env;
  const out = await postReview({ forge, policy, reviewer, number, sha, raw, outcome, keySet: env.KEY_SET !== "false", env });
  // The gate sees the review (or the notice) now, not at the next event.
  if (out.posted) await judgeChange({ forge, policy, reviewer, number, baseHint: env.BASE_CHANGED_AT || null });
}

runIfMain(import.meta.url, "post-review", main);
