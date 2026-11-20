#!/usr/bin/env node
/**
 * Merge queue, mode "self" (I/O): for forges/plans without a native merge queue, the same idea built on the API —
 * re-run CI on "latest target branch + this change" and merge only when green, so two changes that each passed on
 * their own cannot break the target branch together. Decisions are in core/queue.mjs.
 *
 *   node .dev-process/engine/cli/merge-queue.mjs [--repo owner/name] [--dry-run]   # in CI (the queue workflow)
 *
 * Queue modes "native" (the forge's merge queue) and "train" (GitLab merge trains) need no script: it exits 0.
 *
 * A change enters the queue with the `names.queueLabel` label. Each run takes the FIRST READY change by number and
 * merges only that one; when more are queued it dispatches another run (one run never waits for more than one CI run):
 *   0. Changes whose head has a queue status of success but are still open are reset to pending (a previous run was
 *      killed between writing success and merging; nobody may merge that untested combination by hand).
 *   1. Readiness: a branch of this repository (forks never enter: their code would run in CI with the repository's
 *      permissions), not a draft, no conflict, the change's own required checks (`checks.required` succeeded,
 *      `checks.skippable` succeeded or skipped). When those pass, the full gate decision is re-run read-only for THIS
 *      change (judgeChange with dryRun). The stored gate status on the head is not enough: statuses are stored per commit,
 *      so two changes on one commit share one result and a signed/approved change could let the other bypass its own
 *      people; a re-judge triggered by the AI review may also be stuck, leaving the status stale.
 *      Both must hold: the queue's re-judge passes AND the stored status written by the CI identity agrees with it (the
 *      branch protection reads the status). They disagree ⇒ dispatch the gate workflow for this change (the queue never
 *      writes the gate status itself: the gate workflow serializes the decisions for a change, and the queue could
 *      overwrite a newer result with old data) and come back after it ran.
 *      Not ready ⇒ stays queued for a later run; a failed required check ⇒ ejected with a comment.
 *   2. A temporary branch (`<queueContext>/pr-<number>`) at the current target branch; the head is merged into it.
 *      Conflict ⇒ ejected with a comment.
 *   3. The CI workflow is dispatched on the temporary branch (only workflow_dispatch starts a new run from events the CI
 *      token causes), with the target-branch commit the candidate is based on (detect-release compares versions with it),
 *      and the queue waits for it (at most `queue.ciTimeoutMin`).
 *   4. Green, the target branch did not move, the change is still open, still labeled, same target branch, same head,
 *      and the gate still passes on a second re-judge (approvals may have been withdrawn while CI ran) ⇒ the queue
 *      status on the head is set to success and the change is merged right away (`queue.mergeMethod`), with a
 *      Conventional-Commits title `<type>(<scope>)!: merge PR #N <title>`.
 *      The target branch moved ⇒ another run re-tests it (one CI wait per run, never a loop inside one job).
 *      The same change on the same head tested `queue.maxAttempts` times in a row without merging ⇒ stop re-testing and
 *      eject (don't hold the CI runners forever). The count lives in the head's queue status description
 *      (`#<number> (<n>/<cap>) …`, language-neutral), so it survives across runs: runs voided by a moving target branch and
 *      runs killed half-way both count; ejecting, merging, a new push and a failed pre-merge check ("not merged: …",
 *      which needs someone to act) all reset it. After waiting for CI, merged or not, this run ends and dispatches
 *      another when more changes are queued (afterProcessing). Label removed ⇒ not merged, left alone. Red ⇒ ejected
 *      with the run link.
 *   5. After merging, the merged commit's base (first parent; for a rebase, the parent of the replayed commits) must be
 *      the tested target-branch commit. Not so (it moved between writing success and merging) ⇒ CI is dispatched on the
 *      target branch (with the pre-merge commit as the base) and the change gets a comment, for someone on duty.
 * The branch protection requires the queue status (from the CI identity), so the merge button stays disabled (except
 * for an admin bypass). One queue run at a time (the workflow's concurrency group).
 */
import { setTimeout as delay } from "node:timers/promises";

import { tr, t } from "../core/messages/index.mjs";
import { loadPolicy } from "../core/policy.mjs";
import {
  afterCi,
  afterProcessing,
  attemptNote,
  attemptsSoFar,
  candidateBranch,
  gateVerdict,
  issuesToClose,
  mergeBlocker,
  mergeCommitMessage,
  mergeCommitTitle,
  mergedBaseDepth,
  queueOrder,
  readiness,
} from "../core/queue.mjs";
import { createForge, queueOpsFor } from "../forge/index.mjs";
import { reviewerFor } from "../reviewer/index.mjs";
import { parseArgs, repoName, repoRoot, runIfMain } from "./args.mjs";
import { judgeChange } from "./risk-gate.mjs";

const item = (code, params = {}) => ({ code, params });
const short = (sha) => String(sha ?? "?").slice(0, 7);

/* ───────────────────────────── actions ───────────────────────────── */

async function eject(ctx, pr, why) {
  const { forge, policy, ops, lang, log } = ctx;
  log(`  ejecting #${pr.number}: ${tr(lang, why)}`);
  if (ctx.dryRun) return;
  const label = policy.names.queueLabel;
  await ops.removeLabel(forge, pr.number, label).catch(() => {});
  await forge.setStatus(pr.headSha, policy.names.queueContext, "failure", t(lang, "queue.status.ejected", { why }), forge.runUrl());
  await forge.postComment(pr.number, t(lang, "queue.comment.ejected", { why, label, run: forge.runUrl() }));
}

/** Check runs on the head and the head's latest queue status (it carries the attempt counter). */
async function headState(ctx, sha) {
  const { forge, ops, policy } = ctx;
  const [checkRuns, queueStatus] = await Promise.all([ops.checkRuns(forge, sha), ops.latestStatus(forge, sha, policy.names.queueContext)]);
  return { checkRuns, queueStatus };
}

/**
 * Re-run the full gate decision for this change, read-only. When the stored gate status is stale, dispatch the gate
 * workflow for it (that workflow wakes the queue when it passes: a run started with the CI token does not trigger
 * workflow_run). An error counts as not satisfied; a later run tries again.
 */
async function rejudge(ctx, pr, dryRun) {
  const { forge, policy, reviewer, ops, branch, env, log } = ctx;
  const gate = policy.names.gateContext;
  let verdict;
  try {
    const judged = await judgeChange({ forge, policy, reviewer, number: pr.number, dryRun: true, env, log });
    verdict = gateVerdict(judged, pr, branch, { policy, prTerm: forge.prTerm, now: ctx.now() });
  } catch (e) {
    return { ok: false, ...item("queue.gate.error", { gate, message: String(e.message ?? e).slice(0, 80) }), refresh: false };
  }
  if (verdict.refresh && !dryRun) {
    log(`  #${pr.number}: the stored ${gate} status disagrees with the re-evaluation; dispatching ${policy.names.gateWorkflow}`);
    await ops.dispatchWorkflow(forge, policy.names.gateWorkflow, branch, { pr: String(pr.number) }).catch((e) => log(`  could not dispatch ${policy.names.gateWorkflow}: ${e.message}`));
  }
  return verdict;
}

/** Temporary branch = target branch, then the head merged into it; `{ ref, sha }`, or null on a conflict. */
async function buildCandidate(ctx, base, pr) {
  const { forge, ops, policy, branch, lang } = ctx;
  const ref = candidateBranch(policy, pr.number);
  await ops.deleteBranch(forge, ref).catch(() => {}); // left over by a killed run
  await ops.createBranch(forge, ref, base);
  try {
    const message = t(lang, "queue.commit.trial", { queue: policy.names.queueContext, branch, sha: base, number: pr.number });
    const sha = await ops.mergeIntoBranch(forge, ref, pr.headSha, message);
    if (sha) return { ref, sha };
  } catch (e) {
    await ops.deleteBranch(forge, ref).catch(() => {});
    throw e;
  }
  await ops.deleteBranch(forge, ref).catch(() => {});
  return null;
}

/** Dispatch CI on the candidate branch and wait for that run; `{ conclusion, url }`. `base`: for detect-release. */
async function runCi(ctx, candidate, number, base) {
  const { forge, ops, policy } = ctx;
  const workflow = policy.names.ciWorkflow;
  const started = ctx.now();
  await ops.dispatchWorkflow(forge, workflow, candidate.ref, { pr: String(number), base });
  let run = null;
  while (ctx.now() - started < policy.queue.ciTimeoutMin * 60_000) {
    await ctx.sleep(policy.queue.pollSeconds * 1000);
    if (!run) {
      run = await ops.findDispatchedRun(forge, workflow, candidate.ref, candidate.sha, started - 60_000);
      continue;
    }
    run = await ops.getRun(forge, run.id);
    if (run.status === "completed") return { conclusion: run.conclusion, url: run.url };
  }
  return { conclusion: "timed_out", url: run?.url };
}

/** A success left by an earlier run on a change that is still open goes back to pending (nobody merges it by hand). */
async function resetStale(ctx, open) {
  const { forge, ops, policy, lang, log } = ctx;
  for (const pr of open) {
    const mine = await ops.latestStatus(forge, pr.headSha, policy.names.queueContext);
    if (mine?.state !== "success") continue;
    log(`resetting #${pr.number}: ${policy.names.queueContext} is success but the ${forge.prTerm} is still open`);
    if (!ctx.dryRun) await forge.setStatus(pr.headSha, policy.names.queueContext, "pending", t(lang, "queue.status.needsQueue", { label: policy.names.queueLabel }), forge.runUrl());
  }
}

/**
 * Close the issues the change links with `Closes #n`: when the queue merges with the CI token, GitHub does not close
 * them. Errors are only logged by the caller: the merge already happened.
 */
async function closeLinkedIssues(ctx, number, mergeSha) {
  const { forge, ops, lang, log } = ctx;
  for (const n of issuesToClose(await ops.closingIssues(forge, number), forge.repo)) {
    await forge.postComment(n, t(lang, "queue.comment.issueClosed", { number, sha: mergeSha }));
    await ops.closeIssue(forge, n);
    log(`  closed linked issue #${n}`);
  }
}

/** The merged commit's base is not the tested commit ⇒ that combination was never tested: re-run CI and comment. */
async function verifyMergeBase(ctx, pr, testedBase, mergeSha, depth) {
  const { forge, ops, policy, branch, lang, log } = ctx;
  if (!mergeSha) return;
  let parent = mergeSha;
  for (let i = 0; i < depth && parent; i++) parent = await ops.parentOf(forge, parent);
  if (parent === testedBase) return;
  log(`  ⚠ merge base ${short(parent)} ≠ tested ${short(testedBase)}; re-running CI on ${branch}`);
  // HEAD and the target branch both contain the change now: pass the pre-merge commit so detect-release can compare.
  await ops.dispatchWorkflow(forge, policy.names.ciWorkflow, branch, { pr: String(pr.number), ...(parent ? { base: parent } : {}) });
  await forge.postComment(pr.number, t(lang, "queue.comment.untested", { pr: forge.prTerm, branch, tested: testedBase, parent }));
}

/** One change: `{ outcome: 'merged' | 'retry' | 'ejected' | 'waiting', ranCi }`. */
export async function processOne(ctx, pr) {
  const { forge, policy, ops, branch, lang, log } = ctx;
  const { names, queue } = policy;
  const { checkRuns, queueStatus } = await headState(ctx, pr.headSha);
  const full = await ops.getChange(forge, pr.number);
  const facts = {
    fromFork: full.fromFork,
    draft: full.draft,
    conflicted: full.conflicted,
    checkRuns,
    required: policy.checks.required,
    skippable: policy.checks.skippable,
    branch,
    gateContext: names.gateContext,
    prTerm: forge.prTerm,
  };
  // Cheap checks first (fork, draft, conflict, required checks); only then spend dozens of API calls on the re-judge.
  let r = readiness({ ...facts, gate: { ok: true } });
  if (r.state === "ready") r = readiness({ ...facts, gate: await rejudge(ctx, pr, ctx.dryRun) });
  log(`#${pr.number} ${pr.title}: ${tr(lang, r)}`);
  if (r.state === "eject") {
    await eject(ctx, pr, item(r.code, r.params));
    return { outcome: "ejected", ranCi: false };
  }
  if (r.state === "wait" || ctx.dryRun) return { outcome: "waiting", ranCi: false };

  const attempt = attemptsSoFar(queueStatus, pr.number) + 1;
  const base = await ops.branchSha(forge, branch);
  const candidate = await buildCandidate(ctx, base, pr);
  if (!candidate) {
    await eject(ctx, pr, item("queue.eject.trialConflict", { branch }));
    return { outcome: "ejected", ranCi: false };
  }
  const note = (text) => attemptNote(pr.number, attempt, text, queue.maxAttempts);
  await forge.setStatus(pr.headSha, names.queueContext, "pending", note(t(lang, "queue.status.testing", { branch, sha: base })), forge.runUrl());
  const ci = await runCi(ctx, candidate, pr.number, base);
  await ops.deleteBranch(forge, candidate.ref).catch(() => {});
  const baseMoved = ci.conclusion === "success" && (await ops.branchSha(forge, branch)) !== base;
  const next = afterCi({ conclusion: ci.conclusion, baseMoved, attempt, cap: queue.maxAttempts });
  if (next === "eject") {
    await eject(ctx, pr, item("queue.eject.ciFailed", { branch, conclusion: ci.conclusion, url: ci.url }));
    return { outcome: "ejected", ranCi: true };
  }
  if (next === "give-up") {
    await eject(ctx, pr, item("queue.eject.giveUp", { attempts: attempt, branch }));
    return { outcome: "ejected", ranCi: true };
  }
  if (next === "retry") {
    log(`  ${branch} moved during the test (attempt ${attempt}/${queue.maxAttempts}): another run re-tests it`);
    await forge.setStatus(pr.headSha, names.queueContext, "pending", note(t(lang, "queue.status.voided", { branch })), forge.runUrl());
    return { outcome: "retry", ranCi: true };
  }
  // Check again before merging: while CI ran the change may have new commits, lost its label, changed its target branch
  // or been closed, and approvals may have been withdrawn.
  const latest = await ops.getChange(forge, pr.number);
  let why = mergeBlocker(latest, pr.headSha, branch, { label: names.queueLabel, prTerm: forge.prTerm });
  let waiver = null;
  if (!why) {
    const gate = await rejudge(ctx, pr, false);
    if (!gate.ok) why = item(gate.code, gate.params);
    else waiver = gate.waiver ?? null;
  }
  if (why) {
    log(`  not merging: ${tr(lang, why)}`);
    await forge.setStatus(pr.headSha, names.queueContext, "pending", t(lang, "queue.status.notMerged", { why }), forge.runUrl());
    return { outcome: "waiting", ranCi: true };
  }
  await forge.setStatus(pr.headSha, names.queueContext, "success", t(lang, "queue.status.verified", { branch, sha: base }), ci.url);
  let mergeSha;
  try {
    mergeSha = await ops.mergeChange(forge, pr.number, {
      sha: pr.headSha,
      method: queue.mergeMethod,
      title: mergeCommitTitle(pr.title, pr.number, { lang, pr: forge.prTerm }),
      message: mergeCommitMessage({ branch, base, ciUrl: ci.url, waiver, waiverCommand: policy.commands.waiver, lang }),
    });
  } catch (e) {
    await eject(ctx, pr, item("queue.eject.mergeRejected", { message: String(e.message ?? e) }));
    return { outcome: "ejected", ranCi: true };
  }
  await ops.removeLabel(forge, pr.number, names.queueLabel).catch(() => {});
  log(`  merged #${pr.number} (${short(mergeSha)})`);
  await closeLinkedIssues(ctx, pr.number, mergeSha).catch((e) => log(`  linked issues not closed: ${e.message}`));
  await verifyMergeBase(ctx, pr, base, mergeSha, mergedBaseDepth(queue.mergeMethod, latest.commits));
  return { outcome: "merged", ranCi: true };
}

/**
 * One queue run. Returns `{ branch, results: [{ number, outcome, ranCi, step }] }`.
 * @param sleep / now  injectable for tests (the CI poll loop).
 */
export async function runQueue({ forge, policy, reviewer, dryRun = false, env = process.env, log = console.log, sleep = delay, now = Date.now }) {
  const ops = queueOpsFor(forge);
  const branch = await ops.defaultBranch(forge);
  const ctx = { forge, policy, reviewer, ops, branch, dryRun, env, log, sleep, now, lang: policy.language };
  const open = await ops.openChanges(forge, branch);
  await resetStale(ctx, open);
  const queued = queueOrder(open, policy.names.queueLabel);
  log(`${queued.length} ${forge.prTerm}(s) in the queue${dryRun ? " (dry run: nothing is changed)" : ""}`);
  const results = [];
  for (const [i, pr] of queued.entries()) {
    const res = await processOne(ctx, pr);
    const step = afterProcessing(res, queued.length - i - 1);
    results.push({ number: pr.number, ...res, step });
    if (step === "next") continue;
    // One CI wait per run: this run ends here; another run continues (a dispatch from the CI token starts a new run,
    // the workflow's concurrency group keeps runs serial).
    if (step === "dispatch" && !dryRun) await ops.dispatchWorkflow(forge, policy.names.queueWorkflow, branch);
    break;
  }
  return { branch, results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // The policy comes from this checkout: the queue workflow checks out the default branch only, so a change cannot alter it.
  const policy = loadPolicy(repoRoot());
  if (policy.queue.mode !== "self") {
    console.log(`[merge-queue] queue mode "${policy.queue.mode}": the forge's own merge queue is used; nothing to do`);
    return;
  }
  let forge;
  try {
    forge = createForge(policy, { repo: repoName(args, repoRoot()) });
  } catch (e) {
    console.error(`usage: merge-queue.mjs [--repo owner/name] [--dry-run] (or set GITHUB_REPOSITORY): ${e.message}`);
    process.exitCode = 2;
    return;
  }
  await runQueue({ forge, policy, reviewer: reviewerFor(policy.reviewer, { ciIdentity: forge.ciIdentity, accounts: policy.aiReview.accounts }), dryRun: Boolean(args["dry-run"]) });
}

runIfMain(import.meta.url, "merge-queue", main);
