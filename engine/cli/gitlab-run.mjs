#!/usr/bin/env node
/**
 * GitLab: the entry of the process bot's pipeline on the default branch (docs/design/gitlab.md). One job, in environment
 * `dev-process-bot` (the only place DEV_PROCESS_TOKEN exists), decides what an event calls for and does it:
 *
 *   node .dev-process/engine/cli/gitlab-run.mjs
 *
 * - source `trigger` (the project webhook): TRIGGER_PAYLOAD names the event; core/gitlab-events.mjs maps it to tasks;
 * - source `api` / `web` with DEV_PROCESS_TASK=risk-gate and DEV_PROCESS_PR: re-judge that MR (the queue asks for it);
 * - source `schedule` with DEV_PROCESS_TASK=poll: re-judge every open MR, start reviews the webhook missed, wake the queue.
 * Tasks: `gate` runs here; `review` and `queue` start their own pipelines on the default branch (the review job must not
 * share a pipeline with the token, and the queue may wait for CI for hours under its own resource group).
 *
 * Refused: any other source — in particular `pipeline`, which a job token can start, and the queue's candidate pipelines
 * hand developer code the bot's job token — and a token that is not a bot user's. Nothing from the payload or a variable is
 * trusted beyond an MR number: everything is read again from the API.
 */
import { readFileSync } from "node:fs";

import { reviewDecision, reviewedNow } from "../core/ai-review.mjs";
import { eventTasks } from "../core/gitlab-events.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { openForge, queueOpsFor } from "../forge/index.mjs";
import { reviewerOn } from "../reviewer/index.mjs";
import { repoName, repoRoot, runIfMain } from "./args.mjs";
import { judgeChange } from "./risk-gate.mjs";

export const BOT_SOURCES = Object.freeze(["trigger", "schedule", "api", "web"]);
/** How long a head may wait for its review before the poll starts one (a review the webhook started may still run). */
export const REVIEW_GRACE_MIN = 25;

/** Is this pipeline one the bot may act in? `{ ok, why }`. */
export function botPipeline(env) {
  if (!BOT_SOURCES.includes(env.CI_PIPELINE_SOURCE)) return { ok: false, why: `pipeline source "${env.CI_PIPELINE_SOURCE ?? "?"}" is not one the process bot acts on` };
  if (!env.CI_DEFAULT_BRANCH || env.CI_COMMIT_BRANCH !== env.CI_DEFAULT_BRANCH) return { ok: false, why: `not the default branch (${env.CI_COMMIT_BRANCH ?? "?"})` };
  return { ok: true, why: "" };
}

/** What this pipeline was started for: `{ mode: "event" | "poll" | "gate" | "none", mr, head, tasks, baseChangedAt, why }`. */
export function whatToDo(env, { bot, queueLabel, readPayload = (p) => readFileSync(p, "utf8") }) {
  const task = env.DEV_PROCESS_TASK ?? "";
  if (env.CI_PIPELINE_SOURCE === "trigger") {
    let payload = null;
    try {
      payload = env.TRIGGER_PAYLOAD ? JSON.parse(readPayload(env.TRIGGER_PAYLOAD)) : null;
    } catch {
      payload = null;
    }
    return { mode: "event", ...eventTasks(payload, { bot, queueLabel }) };
  }
  if (task === "poll") return { mode: "poll", mr: null, head: null, tasks: [], baseChangedAt: null, why: "scheduled poll" };
  if (task === "risk-gate" && /^\d+$/.test(env.DEV_PROCESS_PR ?? "")) return { mode: "gate", mr: Number(env.DEV_PROCESS_PR), head: null, tasks: ["gate"], baseChangedAt: null, why: "re-judge requested" };
  return { mode: "none", mr: null, head: null, tasks: [], baseChangedAt: null, why: `nothing to do for task "${task}"` };
}

/** Start a review pipeline for this MR's head when it needs one. */
async function startReview(ctx, mr, { change = null, grace = false } = {}) {
  const { forge, policy, reviewer, ops, branch, log, now } = ctx;
  const c = change ?? (await forge.loadChange(mr));
  const d = reviewDecision({ reviewer, change: c, eventHead: c.headSha, forks: true });
  if (!d.review) return log(`  !${mr}: no review (${d.reason})`);
  const notice = reviewer.aiReviews({ reviews: c.reviews, comments: c.comments }).some((r) => !r.real && r.commitId === c.headSha);
  if (grace) {
    // The poll: leave heads that have a notice (someone must act) or are still young (a review may be running).
    if (notice) return log(`  !${mr}: a notice is on the head; not starting a review`);
    const pushedAt = Date.parse(c.headPushedAt ?? "");
    if (Number.isFinite(pushedAt) && now() - pushedAt < REVIEW_GRACE_MIN * 60_000) return log(`  !${mr}: the head is younger than ${REVIEW_GRACE_MIN} min; its review may still run`);
  }
  await ops.dispatchWorkflow(forge, policy.names.aiReviewWorkflow, branch, { pr: String(mr), sha: c.headSha, target: c.baseRef });
  log(`  !${mr}: review pipeline started for ${c.headSha.slice(0, 12)}`);
}

/**
 * Run what the pipeline was started for. Returns what was done (for tests and the job log).
 * @param ctx `{ forge, policy, reviewer, env, log, now, readPayload }`
 */
export async function runBot({ forge, policy, reviewer, env = process.env, log = console.log, now = Date.now, readPayload } = {}) {
  const gate = botPipeline(env);
  if (!gate.ok) throw new Error(`gitlab-run: ${gate.why}; refusing to act`);
  if (forge.tokenIsBot === false) throw new Error(`gitlab-run: DEV_PROCESS_TOKEN belongs to ${forge.ciIdentity}, not to a bot user (a project access token); refusing to act`);
  const ops = queueOpsFor(forge);
  const branch = env.CI_DEFAULT_BRANCH;
  const ctx = { forge, policy, reviewer, ops, branch, log, now };
  const plan = whatToDo(env, { bot: forge.ciIdentity, queueLabel: policy.names.queueLabel, readPayload });
  log(`[gitlab-run] ${plan.why}${plan.mr ? ` (!${plan.mr})` : ""}: ${plan.tasks.join(", ") || (plan.mode === "poll" ? "poll" : "nothing")}`);
  const done = { judged: [], reviews: [], queue: false };

  if (plan.mode === "poll") {
    const open = await ops.openChanges(forge, branch);
    for (const mr of open) {
      try {
        const { data } = await judgeChange({ forge, policy, reviewer, number: mr.number, env: {}, log: () => {} });
        done.judged.push(mr.number);
        if (!reviewedNow({ reviewer, change: data })) {
          await startReview(ctx, mr.number, { change: data, grace: true });
        }
      } catch (e) {
        log(`::warning::!${mr.number}: ${String(e.message ?? e).slice(0, 160)}`);
      }
    }
    if (open.some((m) => m.labels.some((l) => l.name === policy.names.queueLabel))) {
      await ops.dispatchWorkflow(forge, policy.names.queueWorkflow, branch);
      done.queue = true;
    }
    return { plan, done };
  }

  if (plan.tasks.includes("gate") && plan.mr) {
    const { result, data } = await judgeChange({ forge, policy, reviewer, number: plan.mr, baseHint: plan.baseChangedAt, env: {} });
    done.judged.push(plan.mr);
    // A passing gate on a queued MR wakes the queue now (as on GitHub), not at the next poll.
    if (result.ok && data.labels.some((l) => l.name === policy.names.queueLabel) && !plan.tasks.includes("queue")) plan.tasks.push("queue");
  }
  if (plan.tasks.includes("review") && plan.mr) {
    await startReview(ctx, plan.mr);
    done.reviews.push(plan.mr);
  }
  if (plan.tasks.includes("queue")) {
    await ops.dispatchWorkflow(forge, policy.names.queueWorkflow, branch);
    done.queue = true;
  }
  return { plan, done };
}

async function main() {
  const env = process.env;
  const root = repoRoot();
  const policy = loadPolicy(root);
  const forge = await openForge(policy, { repo: repoName({}, root) });
  await runBot({ forge, policy, reviewer: reviewerOn(policy, forge), env });
}

runIfMain(import.meta.url, "gitlab-run", main);
