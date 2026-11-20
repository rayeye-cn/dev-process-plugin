#!/usr/bin/env node
/**
 * risk-gate CLI (I/O): load one PR/MR, decide (core/gate.mjs), write back the status, the risk label and the sticky
 * comment. The decision rules are documented in core/gate.mjs.
 *
 *   node .dev-process/engine/cli/risk-gate.mjs --pr 123             # in CI
 *   node .dev-process/engine/cli/risk-gate.mjs --pr 123 --dry-run   # locally: print the decision, write nothing
 *   node .dev-process/engine/cli/risk-gate.mjs --head-sha <sha>     # events that only carry a head sha
 *
 * The policy is read from the checkout the CI job runs on, which must be the BASE branch (GitHub:
 * pull_request_target / issue_comment / workflow_run triggers), so a PR cannot change its own gate.
 * Result: a commit status named `names.gateContext` (required by the branch protection). Events that are not on the
 * head (comments, approvals) update the same status, which a check run could not do.
 */
import { appendFileSync } from "node:fs";

import { aiReviewState, afterBaseChange, evaluate, isBot, needAiRerequest, pickWaiver, render, statusDescription, trustedClassifier, trustedGateStatus, waiverCommands } from "../core/gate.mjs";
import { t } from "../core/messages/index.mjs";
import { loadPolicy, TIERS } from "../core/policy.mjs";
import { createForge } from "../forge/index.mjs";
import { reviewerFor } from "../reviewer/index.mjs";
import { parseArgs, repoRoot, runIfMain } from "./args.mjs";

const marker = (policy) => `<!-- ${policy.names.gateContext} -->`;
const rethinkMarker = (policy) => `<!-- ${policy.names.gateContext}:rethink -->`;

/**
 * Accounts whose write access must be checked: approvers on the head (after the base change) and, when the AI has not
 * reviewed the head, the authors of waiver commands on the head. Usually one or two people.
 */
export function loginsToCheck({ reviews, author, headSha, baseChangedAt, waiverOnHead, reviewedHead, reviewer }) {
  return new Set([
    ...reviews
      .filter((r) => r.state === "APPROVED" && r.commitId === headSha && r.login && r.login !== author && !isBot(r.login, r.type, reviewer) && afterBaseChange(r.submittedAt, baseChangedAt))
      .map((r) => r.login),
    ...(reviewedHead ? [] : waiverOnHead.map((w) => w.by)),
  ]);
}

/**
 * Full decision for ONE change, and (unless dryRun) write-back. The merge queue calls it with dryRun before testing
 * and before merging (statuses are stored per SHA; two PRs on one commit would share a result).
 * @returns `{ result, data, body }`
 */
export async function judgeChange({ forge, policy, reviewer, number, dryRun = false, baseHint = null, env = process.env, log = console.log }) {
  const data = await forge.loadChange(number, { baseHint });
  const aiReviews = reviewer.aiReviews({ reviews: data.reviews, comments: data.comments });
  const cmds = waiverCommands(data.comments, data.headSha, policy.commands.waiver, data.baseChangedAt, reviewer);
  const { reviewedHead } = aiReviewState(aiReviews, data.headSha, null, data.baseChangedAt);
  const toCheck = loginsToCheck({ ...data, waiverOnHead: cmds.onHead, reviewedHead, reviewer });
  const checked = await Promise.all([...toCheck].map(async (login) => ((await forge.hasWriteAccess(login)) ? login : null)));
  const writers = new Set(checked.filter(Boolean));

  const trust = { creator: forge.ciIdentity };
  // The classify job just produced a second opinion for this head: use it and store it as a status for later events.
  const fresh = env.CLASSIFIER_TIER && env.CLASSIFIER_SHA === data.headSha;
  const classifier = fresh
    ? { tier: env.CLASSIFIER_TIER, reason: String(env.CLASSIFIER_REASON ?? "").slice(0, 120) }
    : trustedClassifier(data.statuses, { ...trust, context: policy.names.classifierContext });

  const result = evaluate({ policy, reviewer, ...data, aiReviews, classifier, writers, waiver: pickWaiver(cmds, writers), pr: forge.prTerm });
  const lang = policy.language;
  const body = render(result, data.headSha, {
    lang,
    gate: policy.names.gateContext,
    ai: reviewer.displayName,
    queueMode: policy.queue.mode,
    queueLabel: policy.names.queueLabel,
    base: data.baseRef,
  });
  data.gateStatus = trustedGateStatus(data.statuses, { ...trust, context: policy.names.gateContext });
  log(body);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${body}\n`);
  if (dryRun) return { result, data, body };

  const url = forge.runUrl();
  if (fresh && TIERS.includes(classifier.tier)) await forge.setStatus(data.headSha, policy.names.classifierContext, "success", `${classifier.tier} — ${classifier.reason}`, url);
  await forge.setStatus(data.headSha, policy.names.gateContext, result.ok ? "success" : "failure", statusDescription(result, { lang, gate: policy.names.gateContext, pr: forge.prTerm }), url);
  await forge.syncRiskLabel(number, result.tier, data.labels, policy.names.riskLabelPrefix);
  await forge.upsertMarkedComment(number, marker(policy), body);
  if (needAiRerequest(result.aiReview, await forge.requestedReviewers(number), reviewer)) {
    try {
      await forge.requestAiReview(number, reviewer.id);
      log(`[risk-gate] #${number}: reviews predate the target-branch change; asked ${reviewer.displayName} to review again`);
    } catch (e) {
      log(`::warning::#${number}: could not re-request ${reviewer.displayName} (${String(e.stderr ?? e.message).trim().slice(0, 120)}); re-request it manually`);
    }
  }
  if (result.rethink && !data.comments.some((c) => c.body?.includes(rethinkMarker(policy)))) {
    await forge.postComment(number, `${rethinkMarker(policy)}\n${t(lang, "rethink.body", { ai: reviewer.displayName, rounds: result.aiRounds, n: result.unanswered.length })}`);
  }
  return { result, data, body };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadPolicy(repoRoot());
  const forge = createForge(policy, { repo: typeof args.repo === "string" ? args.repo : undefined });
  const reviewer = reviewerFor(policy.reviewer, { ciIdentity: forge.ciIdentity, accounts: policy.aiReview.accounts });
  const headSha = typeof args["head-sha"] === "string" ? args["head-sha"] : null;
  const number = typeof args.pr === "string" && args.pr ? args.pr : headSha ? await forge.findOpenPrByHead(headSha) : null;
  if (!number && headSha) {
    console.log(`[risk-gate] ${headSha} is not the head of any open ${forge.prTerm} (closed, or a newer push); skipping`);
    return;
  }
  if (!/^\d+$/.test(String(number ?? ""))) {
    console.error("usage: risk-gate.mjs (--pr <number> | --head-sha <sha>) [--repo owner/name] [--dry-run]");
    process.exitCode = 2;
    return;
  }
  const dryRun = Boolean(args["dry-run"]);
  const lang = policy.language;
  const head = await forge.headOf(number);
  // Mark the head pending first: an error half-way must not leave the previous success standing.
  if (!dryRun) await forge.setStatus(head, policy.names.gateContext, "pending", t(lang, "status.rejudging"), forge.runUrl());
  try {
    const { result } = await judgeChange({ forge, policy, reviewer, number, dryRun, baseHint: process.env.BASE_CHANGED_AT || null });
    if (dryRun) process.exitCode = result.ok ? 0 : 1;
    // The workflow wakes the merge queue only when the gate passes.
    else if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ok=${result.ok}\n`);
  } catch (e) {
    if (!dryRun) await forge.setStatus(head, policy.names.gateContext, "failure", t(lang, "status.error", { message: String(e.message ?? e).slice(0, 80) }), forge.runUrl()).catch(() => {});
    throw e;
  }
}

runIfMain(import.meta.url, "risk-gate", main);
