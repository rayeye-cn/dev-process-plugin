/**
 * Forge adapters. Each one returns the same normalized shapes (see forge/github.mjs `loadChange`) and the same write
 * operations, so the core and the CLIs don't know which forge they talk to.
 */
import { createGithub, githubQueueOps } from "./github.mjs";

export function createForge(policy, opts = {}) {
  switch (policy.forge) {
    case "github":
      return createGithub(opts);
    default:
      throw new Error(`forge "${policy.forge}" is not supported yet`);
  }
}

/**
 * The merge queue's forge calls (mode "self"): plain functions taking the forge first, `{ defaultBranch, openChanges,
 * getChange, checkRuns, latestStatus, removeLabel, branchSha, createBranch, deleteBranch, mergeIntoBranch,
 * dispatchWorkflow, findDispatchedRun, getRun, mergeChange, closingIssues, closeIssue, parentOf }`.
 */
export function queueOpsFor(forge) {
  switch (forge.id) {
    case "github":
      return githubQueueOps;
    default:
      throw new Error(`merge queue mode "self" is not supported on forge "${forge.id}" yet`);
  }
}

/** The forge's issue calls (see forge/github.mjs `issues`); a clear error when the forge has none. */
export function issuesOf(forge) {
  if (!forge.issues) throw new Error(`forge "${forge.id}": issues are not supported yet`);
  return forge.issues;
}
