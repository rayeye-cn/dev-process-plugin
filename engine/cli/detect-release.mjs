#!/usr/bin/env node
/**
 * Release detection in CI (I/O): should this run start the heavy release gate? Decisions in core/release.mjs.
 *
 *   node .dev-process/engine/cli/detect-release.mjs   # reads the CI environment, writes release=true|false to GITHUB_OUTPUT
 *
 * Environment (set by the CI workflow):
 *   EVENT                  the event name (pull_request | workflow_dispatch | …)
 *   PR_BASE_SHA            pull_request: the PR's base sha
 *   PR_LABELS              pull_request: JSON array of the PR's label names (preferred), or
 *   PR_HAS_RELEASE_LABEL   pull_request: "true" when the PR carries the release label (the reference's variable)
 *   QUEUE_PR, BASE_INPUT   workflow_dispatch from the merge queue: the PR number and the base to compare with
 *   DEFAULT_BRANCH         the default branch (looked up through the forge when missing)
 *   GITHUB_REPOSITORY, GH_TOKEN   for the forge lookups (queue runs read the PR's labels)
 *   GITHUB_OUTPUT, GITHUB_STEP_SUMMARY
 * The checkout must have the base commit (full history, e.g. fetch-depth: 0).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { t } from "../core/messages/index.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { baseRefFor, changedVersions, hasLabel, isRelease, readField } from "../core/release.mjs";
import { createForge } from "../forge/index.mjs";
import { repoRoot, runIfMain } from "./args.mjs";

/** The calls detectRelease needs from the forge (tests pass their own). */
const releaseOps = (forge) => ({ defaultBranch: () => forge.defaultBranch(), prLabels: (number) => forge.changeLabels(number) });

/* ───────────────────────────── git and files ───────────────────────────── */

/** `git <args>` in the repository; stdout, throws on a non-zero exit. */
export const gitRunner = (root) => (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function parseJson(text, where) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${where} is not valid JSON: ${e.message}`);
  }
}

/**
 * Each version file's field at the base ref and in the working tree: `[{ file, field, base, head }]`. A file missing on
 * one side reads as undefined (it differs from the other side ⇒ release). A base ref not in the checkout throws.
 */
export function readVersions({ ref, files, root, git = gitRunner(root) }) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    throw new Error(`base ${ref} is not in this checkout (fetch the full history, e.g. fetch-depth: 0)`);
  }
  return (files ?? []).map(({ file, field }) => {
    let inBase = true;
    try {
      git(["cat-file", "-e", `${ref}:${file}`]);
    } catch {
      inBase = false;
    }
    const base = inBase ? readField(parseJson(git(["show", `${ref}:${file}`]), `${ref}:${file}`), field) : undefined;
    const path = join(root, file);
    const head = existsSync(path) ? readField(parseJson(readFileSync(path, "utf8"), file), field) : undefined;
    return { file, field, base, head };
  });
}

/** Label names from the pull_request event's environment. */
export function labelsFromEnv(env, label) {
  // GitLab: CI_MERGE_REQUEST_LABELS (MR pipelines) and DEV_PROCESS_LABELS (the queue's candidate pipelines) are comma lists.
  if (env.PR_LABELS_CSV !== undefined && env.PR_LABELS_CSV !== null) return String(env.PR_LABELS_CSV).split(",").map((l) => l.trim()).filter(Boolean);
  if (env.PR_LABELS) {
    const v = parseJson(env.PR_LABELS, "PR_LABELS");
    if (!Array.isArray(v)) throw new Error("PR_LABELS must be a JSON array of label names");
    return v.map((l) => (typeof l === "string" ? l : l?.name));
  }
  return env.PR_HAS_RELEASE_LABEL === "true" && label ? [label] : [];
}

/**
 * The decision for this run: `{ release, ref, versions, labeled, summary }` (summary: localized, for the job summary).
 * @param ops  `{ defaultBranch(), prLabels(number) }`; default: the forge's, created only when needed.
 */
export async function detectRelease({ policy, env = process.env, root, git = gitRunner(root), ops = null, log = console.log }) {
  let forgeOps = ops;
  const lazy = () => (forgeOps ??= releaseOps(createForge(policy, { env })));
  const lang = policy.language;
  const label = policy.release?.label || null;
  const event = env.EVENT;
  const detecting = event === "pull_request" || (event === "workflow_dispatch" && Boolean(env.QUEUE_PR));
  const defaultBranch = env.DEFAULT_BRANCH || (detecting ? await lazy().defaultBranch() : undefined);
  const ref = baseRefFor({ event, prBaseSha: env.PR_BASE_SHA, queuePr: env.QUEUE_PR, baseInput: env.BASE_INPUT, defaultBranch });
  if (!ref) {
    log(`${event} event and not a merge-queue run ⇒ release=false`);
    return { release: false, ref: null, versions: [], labeled: false, summary: t(lang, "release.summary.skip", { event }) };
  }
  const versions = readVersions({ ref, files: policy.release?.versionFiles ?? [], root, git });
  // A queue run has no PR in its event: read the labels of the PR it tests (GitLab passes them along, its candidate
  // pipeline has no token to read them).
  const labels = event === "workflow_dispatch" && env.PR_LABELS_CSV === undefined ? await lazy().prLabels(env.QUEUE_PR) : labelsFromEnv(env, label);
  const labeled = hasLabel(labels, label);
  const release = isRelease({ versions, labeled });
  const changed = changedVersions(versions).map((v) => `${v.file}:${v.field}`);
  log(`base ${ref}; versions changed: ${changed.length ? changed.join(", ") : "none"}; label ${label ?? "(none)"}: ${labeled} ⇒ release=${release}`);
  return { release, ref, versions, labeled, summary: t(lang, "release.summary", { ref, versions, label, labeled, release }) };
}

async function main() {
  const root = repoRoot();
  const out = await detectRelease({ policy: loadPolicy(root), root });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `release=${out.release}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out.summary}\n`);
}

runIfMain(import.meta.url, "detect-release", main);
