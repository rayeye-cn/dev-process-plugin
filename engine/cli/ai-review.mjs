#!/usr/bin/env node
/**
 * The Claude review job (I/O). Decisions in core/ai-review.mjs; the reviewer adapter in reviewer/claude.mjs.
 *
 *   node .dev-process/engine/cli/ai-review.mjs should-review --pr N --head-sha SHA   # review=true|false, reason, key
 *   node .dev-process/engine/cli/ai-review.mjs prompt --pr N --head-sha SHA          # the prompt (text=… multi-line output)
 *   node .dev-process/engine/cli/ai-review.mjs verify --pr N --head-sha SHA --outcome <step outcome>
 *                                                                                     # notice=true|false; posts the notice
 *   (each takes --repo owner/name; outputs go to GITHUB_OUTPUT, or stdout when it is not set)
 *
 * Environment: GH_TOKEN, GITHUB_REPOSITORY; BASE_CHANGED_AT (the event's own base-change time, as for the gate);
 * KEY_SET ("true" when the ANTHROPIC_API_KEY secret is set); GITHUB_STEP_SUMMARY.
 *
 * The prompt reads the review instructions from the checkout (the PR head under `pull_request`). A PR that edits them
 * is reviewed by its own version; those files are on high-tier paths, so such a PR needs a human anyway.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import { hasNotice, reviewDecision, verifyDecision } from "../core/ai-review.mjs";
import { reviewInstructions } from "../core/findings.mjs";
import { t, tr } from "../core/messages/index.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { createForge } from "../forge/index.mjs";
import { claudeMarker, claudeNoticeMarker } from "../reviewer/claude.mjs";
import { reviewerFor } from "../reviewer/index.mjs";
import { parseArgs, repoRoot, runIfMain } from "./args.mjs";

/** Write `key=value` lines (a multi-line value with a random delimiter) to GITHUB_OUTPUT, or print them. */
export function output(env, values, print = console.log) {
  const lines = [];
  for (const [k, v] of Object.entries(values)) {
    const s = String(v);
    if (s.includes("\n")) {
      const d = `EOF_${randomUUID()}`;
      lines.push(`${k}<<${d}`, s, d);
    } else lines.push(`${k}=${s}`);
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  else print(lines.join("\n"));
}

const summary = (env, text) => {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
};

/** Load the PR with the event's base-change hint. */
const load = (forge, number, env) => forge.loadChange(number, { baseHint: env.BASE_CHANGED_AT || null });

export async function shouldReview({ forge, policy, reviewer, number, eventHead, env = process.env, log = console.log }) {
  const change = await load(forge, number, env);
  const d = reviewDecision({ reviewer, change, eventHead });
  const text = tr(policy.language, d);
  log(text);
  summary(env, text);
  return { ...d, key: env.KEY_SET === "true" };
}

/** `root` relative to the working directory when it is a subdirectory of it (the CI's copy beside the PR head), else "". */
export function sideCopy(root, cwd = process.cwd()) {
  const rel = relative(cwd, root);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : "";
}

/**
 * The review prompt for one head (pure apart from reading the instruction files under `root`).
 * @param ignore  a directory in the checkout that is not part of the PR (the CI's copy of the process files)
 */
export function buildPrompt({ policy, root, repo, number, sha, ignore = "" }) {
  return t(policy.language, "aiReview.prompt", {
    ignore,
    repo,
    pr: number,
    sha,
    marker: claudeMarker(sha),
    instructions: reviewInstructions(root, policy),
    maxComments: policy.aiReview.maxComments,
    replyTags: policy.threadReplyTags,
    signoff: policy.commands.signoff,
    waiver: policy.commands.waiver,
  });
}

/** After the review step: post a notice when no review of the head came out. Returns `{ notice: boolean, reason }`. */
export async function verifyReview({ forge, policy, reviewer, number, eventHead, outcome, keySet, env = process.env, log = console.log }) {
  const change = await load(forge, number, env);
  const d = verifyDecision({ reviewer, change, eventHead, outcome, keySet });
  if (!d.notice) {
    log(`[ai-review] #${number}: ${d.reason}; no notice`);
    return { notice: false, reason: d.reason };
  }
  const text = tr(policy.language, d.notice);
  const body = `${claudeNoticeMarker(change.headSha)}\n${text}`;
  summary(env, text);
  if (hasNotice(change.comments, forge.ciIdentity, body, change.baseChangedAt)) {
    log(`[ai-review] #${number}: the same notice is already on ${change.headSha}`);
    return { notice: false, reason: "posted" };
  }
  try {
    await forge.postComment(number, body);
  } catch (e) {
    // e.g. a bot's PR (Dependabot) whose run gets a read-only token: the job summary still says what happened.
    log(`::warning::#${number}: could not post the notice (${String(e.message ?? e).slice(0, 120)})`);
    return { notice: false, reason: "unwritable" };
  }
  log(`[ai-review] #${number}: posted a notice (${d.notice.code})`);
  return { notice: true, reason: d.reason };
}

const USAGE = "usage: ai-review.mjs (should-review | prompt | verify --outcome <outcome>) --pr <number> --head-sha <sha> [--repo owner/name]";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd] = args._;
  const number = typeof args.pr === "string" ? args.pr : "";
  const sha = typeof args["head-sha"] === "string" ? args["head-sha"].toLowerCase() : "";
  if (!["should-review", "prompt", "verify"].includes(cmd) || !/^\d+$/.test(number) || !/^[0-9a-f]{40}$/.test(sha)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const root = repoRoot();
  const policy = loadPolicy(root);
  const env = process.env;
  const repo = typeof args.repo === "string" ? args.repo : env.GITHUB_REPOSITORY;
  if (cmd === "prompt") {
    const text = buildPrompt({ policy, root, repo, number, sha, ignore: sideCopy(root) });
    if (env.GITHUB_OUTPUT) output(env, { text });
    else console.log(text);
    return;
  }
  const forge = createForge(policy, { repo });
  const reviewer = reviewerFor(policy.reviewer, { ciIdentity: forge.ciIdentity, accounts: policy.aiReview.accounts });
  if (reviewer.id !== "claude") throw new Error(`ai-review.mjs is the Claude review job; the policy's reviewer is "${reviewer.id}"`);
  if (cmd === "should-review") {
    const d = await shouldReview({ forge, policy, reviewer, number, eventHead: sha, env });
    output(env, { review: d.review, reason: d.reason, key: d.key });
    return;
  }
  const outcome = typeof args.outcome === "string" ? args.outcome : "";
  const v = await verifyReview({ forge, policy, reviewer, number, eventHead: sha, outcome, keySet: env.KEY_SET === "true", env });
  output(env, { notice: v.notice });
}

runIfMain(import.meta.url, "ai-review", main);
