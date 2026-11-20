/**
 * Forge adapters. Each one returns the same normalized shapes (see forge/github.mjs `loadChange`) and the same write
 * operations, so the core and the CLIs don't know which forge they talk to.
 */
import { createGithub, githubQueueOps } from "./github.mjs";
import { createGitlab, gitlabQueueOps } from "./gitlab.mjs";

export function createForge(policy, opts = {}) {
  switch (policy.forge) {
    case "github":
      return createGithub(opts);
    case "gitlab":
      return createGitlab({ url: policy.gitlab?.url, ...opts });
    default:
      throw new Error(`forge "${policy.forge}" is not supported yet`);
  }
}

/** createForge, then whatever the forge must look up before use (GitLab: the bot's username, from the token). */
export async function openForge(policy, opts = {}) {
  const forge = createForge(policy, opts);
  if (typeof forge.ready === "function") await forge.ready();
  return forge;
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
    case "gitlab":
      return gitlabQueueOps;
    default:
      throw new Error(`merge queue mode "self" is not supported on forge "${forge.id}" yet`);
  }
}

/** The forge's issue calls (see forge/github.mjs `issues`); a clear error when the forge has none. */
export function issuesOf(forge) {
  if (!forge.issues) throw new Error(`forge "${forge.id}": issues are not supported yet`);
  return forge.issues;
}
