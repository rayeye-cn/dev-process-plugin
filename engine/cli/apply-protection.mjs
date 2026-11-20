#!/usr/bin/env node
/**
 * Apply the branch protection derived from the policy (core/protection.mjs). The protection is code too: change the
 * policy in a PR, then re-run this.
 *
 *   GH_TOKEN=$(gh auth token) node .dev-process/engine/cli/apply-protection.mjs --dry-run   # print what would be written
 *   GH_TOKEN=$(gh auth token) node .dev-process/engine/cli/apply-protection.mjs             # write (repository admin)
 *
 * The repository is `--repo owner/name`, else GITHUB_REPOSITORY, else the checkout's github.com `origin` remote.
 *
 * ORDER MATTERS: merge the workflows first and see every required check report on a test PR, then run this;
 * otherwise every PR is blocked.
 */
import { githubRuleset, RULESET_NAME } from "../core/protection.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { openForge } from "../forge/index.mjs";
import { parseArgs, repoName, repoRoot, runIfMain } from "./args.mjs";

/** GitHub: create or update the ruleset named RULESET_NAME. Returns `{ action, id, body }`. */
export async function applyGithubRuleset(forge, policy, { dryRun = false, log = console.log } = {}) {
  const want = githubRuleset(policy);
  const base = `/repos/${forge.owner}/${forge.name}`;
  const existing = (await forge.rest.get(`${base}/rulesets?includes_parents=false`)).find((r) => r.name === RULESET_NAME);
  if (dryRun) {
    log(existing ? `would update ruleset #${existing.id} "${RULESET_NAME}" to:` : `would create ruleset "${RULESET_NAME}":`);
    log(JSON.stringify(want, null, 2));
    return { action: existing ? "update" : "create", id: existing?.id ?? null, body: want, dryRun: true };
  }
  const saved = existing ? await forge.rest.put(`${base}/rulesets/${existing.id}`, want) : await forge.rest.post(`${base}/rulesets`, want);
  log(`${existing ? "updated" : "created"} ruleset #${saved.id} "${saved.name}", enforcement=${saved.enforcement}`);
  return { action: existing ? "update" : "create", id: saved.id, body: want };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadPolicy(repoRoot());
  const forge = await openForge(policy, { repo: repoName(args, repoRoot()) });
  const dryRun = Boolean(args["dry-run"]);
  if (forge.id === "github") await applyGithubRuleset(forge, policy, { dryRun });
  else throw new Error(`apply-protection: forge "${forge.id}" is not supported yet`);
}

runIfMain(import.meta.url, "apply-protection", main);
