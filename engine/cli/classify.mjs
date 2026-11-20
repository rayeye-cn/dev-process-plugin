#!/usr/bin/env node
/**
 * AI second-classifier CLI (I/O). The decision rules and the prompt live in core/classify.mjs; the result can only
 * raise the gate's tier.
 *
 *   node .dev-process/engine/cli/classify.mjs prompt --pr 123 [--repo owner/name] > "$RUNNER_TEMP/prompt.txt"
 *   <AI CLI, no tools allowed, prompt read from that file or stdin> > "$RUNNER_TEMP/out.txt"
 *   node .dev-process/engine/cli/classify.mjs parse [--sha <head sha>] < "$RUNNER_TEMP/out.txt"
 *
 * `prompt` fetches the diff through the forge, moves docs-only files to the end, cuts it to
 * `classifier.maxDiffBytes` UTF-8 bytes and prints the prompt in the project's language.
 * Deliver the prompt to the AI CLI through a file or stdin, never as a command-line argument: the diff is PR content
 * (no shell interpolation of it), and a single argument is capped at 128 KB on Linux. Reading from a file lifts that
 * cap; the byte cap stays anyway to bound the cost and the model's context.
 *
 * `parse` reads the AI CLI's output on stdin (Copilot plain text or Claude `--output-format json`) and writes
 * `tier=`, `reason=` and, with `--sha`, `sha=` (the head the diff belongs to; the gate uses the result only for that
 * head) to `$GITHUB_OUTPUT` when set, else to stdout. No TIER line ⇒ writes nothing (the gate uses the path-based
 * tier). The reason is stripped of line breaks and shell-special characters, so it is safe as a single output line.
 */
import { appendFileSync, readFileSync } from "node:fs";

import { buildPrompt, orderDiff, parseOutput, truncateBytes } from "../core/classify.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { createForge } from "../forge/index.mjs";
import { parseArgs, repoRoot, runIfMain } from "./args.mjs";

const USAGE = "usage: classify.mjs prompt --pr <number> [--repo owner/name] | classify.mjs parse [--sha <head sha>] < out.txt";

/**
 * The change's diff and title. Uses `forge.loadDiff(number)` when the forge has one; otherwise the GitHub REST calls
 * (diff media type + the PR itself).
 * @returns `{ diff, title, headSha }`
 */
export async function loadDiff(forge, number) {
  if (typeof forge.loadDiff === "function") return forge.loadDiff(number);
  if (forge.id !== "github") throw new Error(`classify: forge "${forge.id}" has no loadDiff yet`);
  const path = `/repos/${forge.owner}/${forge.name}/pulls/${number}`;
  const [diff, meta] = await Promise.all([forge.rawGet(path, "application/vnd.github.diff"), forge.rest.get(path)]);
  return { diff, title: meta?.title ?? "", headSha: meta?.head?.sha ?? null };
}

/** `prompt`: the full prompt for one change, plus what was sent (for the log). */
export async function promptFor({ forge, policy, number }) {
  const { diff, title, headSha } = await loadDiff(forge, number);
  const { text, truncated } = truncateBytes(orderDiff(diff, policy.lowOnlyPaths), policy.classifier.maxDiffBytes);
  return { prompt: buildPrompt(policy, text, { title, truncated, pr: forge.prTerm ?? "PR" }), truncated, bytes: Buffer.byteLength(text, "utf8"), headSha };
}

/**
 * `parse`: AI output → `tier=` / `reason=` / `sha=` lines, appended to `env.GITHUB_OUTPUT` when set, else written
 * with `out`. Returns the parsed result or null.
 */
export function parseCommand({ input, sha = null, env = process.env, out = (s) => process.stdout.write(s), log = console.error }) {
  const result = parseOutput(input);
  if (!result) {
    log("[classify] no TIER line in the AI output; the path-based tier applies");
    return null;
  }
  const lines = `tier=${result.tier}\nreason=${result.reason}\n${sha ? `sha=${sha}\n` : ""}`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
  else out(lines);
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === "parse") {
    const sha = typeof args.sha === "string" ? args.sha : null;
    if (args.sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(sha ?? "")) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    parseCommand({ input: readFileSync(0, "utf8"), sha });
    return;
  }
  if (cmd === "prompt") {
    const pr = typeof args.pr === "string" ? args.pr : "";
    if (!/^\d+$/.test(pr)) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    const policy = loadPolicy(repoRoot());
    const forge = createForge(policy, { repo: typeof args.repo === "string" ? args.repo : undefined });
    const { prompt, truncated, bytes } = await promptFor({ forge, policy, number: pr });
    process.stdout.write(prompt);
    console.error(`[classify] prompt for #${pr}: ${bytes} diff bytes${truncated ? ` (truncated to ${policy.classifier.maxDiffBytes})` : ""}`);
    return;
  }
  console.error(USAGE);
  process.exitCode = 2;
}

runIfMain(import.meta.url, "classify", main);
