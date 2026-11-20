#!/usr/bin/env node
/**
 * GitLab: the Claude review job's preparation (docs/design/gitlab.md, "The Claude review"). Runs in the bot pipeline on
 * the default branch WITHOUT the bot token: only git and the files of this checkout (the default branch's engine,
 * configuration and review instructions).
 *
 *   node .dev-process/engine/cli/gitlab-review.mjs prepare --out <dir>
 *
 * Env (set by the pipeline that gitlab-run started): DEV_PROCESS_PR, DEV_PROCESS_SHA, DEV_PROCESS_TARGET.
 * Writes into <dir>:
 *   state                 ready | no-key | superseded (the template runs Claude only when "ready")
 *   mr/                   a worktree of the MR head (Claude's working directory; its file tools stay inside it)
 *   review-prompt.txt, review-schema.json   the review run's input
 *   classify-prompt.txt   the classifier's input (when the classifier is on)
 *   meta.json             { pr, sha, target, keySet, truncated } for the posting job
 * The template then runs `claude --bare --restricted --strict-mcp-config` in mr/ with a cleaned environment, writes
 * review.json / classify.json and `outcome` (success | failure), and the posting job (cli/post-review.mjs --dir) posts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildPrompt as classifyPrompt, orderDiff, truncateBytes } from "../core/classify.mjs";
import { asCodeBlock, reviewInstructions } from "../core/findings.mjs";
import { changeRef, t } from "../core/messages/index.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { REVIEW_SCHEMA } from "../core/post-review.mjs";
import { parseArgs, repoRoot, runIfMain } from "./args.mjs";

const USAGE = "usage: gitlab-review.mjs prepare --out <dir>   (env: DEV_PROCESS_PR, DEV_PROCESS_SHA, DEV_PROCESS_TARGET)";

/** Only plain values from the pipeline's variables: an MR number, a full sha, a branch name git accepts. */
export function reviewInputs(env, git) {
  const pr = String(env.DEV_PROCESS_PR ?? "");
  const sha = String(env.DEV_PROCESS_SHA ?? "").toLowerCase();
  const target = String(env.DEV_PROCESS_TARGET ?? "");
  if (!/^\d+$/.test(pr)) throw new Error(`bad DEV_PROCESS_PR "${pr}"`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`bad DEV_PROCESS_SHA "${sha}"`);
  try {
    if (!target || target.startsWith("-")) throw new Error("empty");
    git(["check-ref-format", "--branch", target]);
  } catch {
    throw new Error(`bad DEV_PROCESS_TARGET "${target}"`);
  }
  return { pr, sha, target };
}

/**
 * Fetch the MR head and the target branch, check the head is still the commit to review, make the worktree, write the
 * inputs. Returns the state written.
 */
export function prepare({ root, out, env = process.env, policy, git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }) {
  const { pr, sha, target } = reviewInputs(env, git);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const state = (s, extra = {}) => {
    writeFileSync(join(out, "state"), `${s}\n`);
    writeFileSync(join(out, "meta.json"), `${JSON.stringify({ pr, sha, target, keySet: Boolean(env.ANTHROPIC_API_KEY), ...extra })}\n`);
    return s;
  };
  if (!env.ANTHROPIC_API_KEY) return state("no-key");
  git(["fetch", "--no-tags", "origin", `+refs/merge-requests/${pr}/head:refs/dev-process/mr`, `+refs/heads/${target}:refs/dev-process/target`]);
  const head = git(["rev-parse", "refs/dev-process/mr"]).trim();
  if (head !== sha) return state("superseded", { head });
  git(["worktree", "add", "--force", "--detach", join(out, "mr"), sha]);
  const raw = git(["diff", "--no-color", "--no-ext-diff", `refs/dev-process/target...${sha}`]);
  const { text, truncated } = truncateBytes(orderDiff(raw, policy.lowOnlyPaths), policy.eval?.maxDiffBytes ?? 68000);
  const lang = policy.language;
  const prompt = t(lang, "aiReview.gitlab.prompt", {
    repo: env.CI_PROJECT_PATH ?? "",
    pr: changeRef(pr, "MR"),
    sha,
    instructions: reviewInstructions(root, policy),
    maxComments: policy.aiReview.maxComments,
    diffBlock: asCodeBlock(text, "diff"),
    truncated,
  });
  writeFileSync(join(out, "review-prompt.txt"), prompt);
  writeFileSync(join(out, "review-schema.json"), JSON.stringify(REVIEW_SCHEMA));
  if (policy.classifier?.enabled) {
    const c = truncateBytes(orderDiff(raw, policy.lowOnlyPaths), policy.classifier.maxDiffBytes);
    writeFileSync(join(out, "classify-prompt.txt"), classifyPrompt(policy, c.text, { truncated: c.truncated, pr: "MR" }));
  }
  return state("ready", { truncated });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] !== "prepare" || typeof args.out !== "string") {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const root = repoRoot();
  const s = prepare({ root, out: resolve(args.out), policy: loadPolicy(root) });
  console.log(`[gitlab-review] ${s}`);
}

runIfMain(import.meta.url, "gitlab-review", main);
