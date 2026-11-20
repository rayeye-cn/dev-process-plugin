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
 * GitLab (`GITLAB_TOKEN` = your own token, Maintainer or Owner; `--repo group/…/name`): the whole setup, see applyGitlab.
 *
 * ORDER MATTERS: merge the workflows first and see every required check report on a test PR, then run this;
 * otherwise every PR is blocked.
 */
import { BOT_ENVIRONMENT, GITLAB_MARK, gitlabPlan, githubRuleset, RULESET_NAME } from "../core/protection.mjs";
import { apiBase, createGitlab, DEVELOPER } from "../forge/gitlab.mjs";
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


const TOKEN_BOT = /^(project|group)_\d+_bot(_[0-9a-f]+)?$/i;
const enc = encodeURIComponent;
const notFound = (e) => (e.status === 404 ? null : Promise.reject(e));
const levels = (list) => (list ?? []).map((a) => a.access_level).sort();
const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * GitLab: make the project match core/protection.mjs `gitlabPlan`, with YOUR token (Maintainer or Owner), idempotently.
 * `dryRun` only reads. Returns `{ actions: [{ code, action: "ok" | "create" | "update" | "warn", params }] }`; doctor
 * reads the same list from a dry run.
 * 1. The default branch: no pushes, merges by Maintainers, no force push (+ Code Owner approval from Premium). Changing
 *    the access levels on Free means unprotecting and protecting again.
 * 2. Project settings (pipelines must succeed, threads resolved, pipeline variables need Maintainer) and, from Premium,
 *    approval settings (reset on push, no author or committer approval).
 * 3. The bot: a project access token (`api`, Maintainer, a year), stored as DEV_PROCESS_TOKEN — protected, masked,
 *    scoped to environment `dev-process-bot`. ANTHROPIC_API_KEY: protected, masked (taken from your environment if set).
 * 4. As the bot (so its pipelines run as the bot): the pipeline trigger and the schedules (poll every 10 minutes, the
 *    nightly sweep, the weekly metrics).
 * 5. The webhook: merge request, comment and pipeline events → the trigger on the default branch. Self-managed GitLab
 *    refuses webhooks to its own address unless an admin allows requests to the local network: then this warns and the
 *    poll alone keeps things moving.
 * 6. People with Maintainer or more besides the bot: warned (on Free they can merge past the gate).
 */
export async function applyGitlab(forge, policy, { dryRun = false, env = process.env, log = console.log, fetch: fetchImpl = globalThis.fetch, today = new Date() } = {}) {
  const { rest } = forge;
  const P = `/projects/${enc(forge.repo)}`;
  const actions = [];
  const act = (code, action, params = {}) => {
    actions.push({ code, action, params });
    const word = { ok: "ok", warn: "WARN", create: dryRun ? "would create" : "created", update: dryRun ? "would update" : "updated" }[action];
    log(`${word.padEnd(12)} ${code}${Object.keys(params).length ? ` ${JSON.stringify(params)}` : ""}`);
  };
  const project = await rest.get(P);
  const branch = project.default_branch;
  const plan = gitlabPlan(policy, { defaultBranch: branch });

  // 1. The default branch.
  const pb = await rest.get(`${P}/protected_branches/${enc(branch)}`).catch(notFound);
  const want = plan.protectedBranch;
  const same =
    pb &&
    levels(pb.push_access_levels).join() === String(want.push_access_level) &&
    levels(pb.merge_access_levels).join() === String(want.merge_access_level) &&
    !pb.allow_force_push &&
    (want.code_owner_approval_required === undefined || pb.code_owner_approval_required === true);
  if (same) act("gitlab.branch", "ok", { branch });
  else {
    act("gitlab.branch", pb ? "update" : "create", { branch, push: "no one", merge: "Maintainer" });
    if (!dryRun) {
      if (pb) await rest.delete(`${P}/protected_branches/${enc(branch)}`);
      try {
        await rest.post(`${P}/protected_branches`, want);
      } catch (e) {
        throw new Error(`${branch} is NOT protected now (re-protecting failed: ${e.message}); protect it by hand: push No one, merge Maintainer`);
      }
    }
  }

  // 2. Settings.
  const changed = Object.fromEntries(Object.entries(plan.project).filter(([k, v]) => project[k] !== v));
  if (!Object.keys(changed).length) act("gitlab.settings", "ok");
  else {
    act("gitlab.settings", "update", changed);
    if (!dryRun) await rest.put(P, changed);
  }
  if (project.protect_merge_request_pipelines === true) act("gitlab.mrPipelinesProtected", "warn");
  if (project.ci_push_repository_for_job_token_allowed === true) act("gitlab.jobTokenPush", "warn");
  if (plan.approvals) {
    const cur = (await rest.get(`${P}/approvals`).catch(notFound)) ?? {};
    const diff = Object.fromEntries(Object.entries(plan.approvals).filter(([k, v]) => cur[k] !== v));
    if (!Object.keys(diff).length) act("gitlab.approvals", "ok");
    else {
      act("gitlab.approvals", "update", diff);
      if (!dryRun) await rest.post(`${P}/approvals`, diff);
    }
  }

  // 3. The bot token and the API key.
  const tokenVar = await rest.get(`${P}/variables/DEV_PROCESS_TOKEN?filter[environment_scope]=${BOT_ENVIRONMENT}`).catch(notFound);
  let botToken = tokenVar?.value ?? null;
  const varFlags = { protected: true, masked: true, environment_scope: BOT_ENVIRONMENT, raw: true };
  if (!tokenVar) {
    act("gitlab.botToken", "create", { scope: BOT_ENVIRONMENT });
    if (!dryRun) {
      const expires = new Date(today.getTime() + 364 * 86_400_000);
      const t = await rest.post(`${P}/access_tokens`, { name: `${GITLAB_MARK}-bot`, scopes: ["api"], access_level: 40, expires_at: isoDay(expires) });
      botToken = t.token;
      await rest.post(`${P}/variables`, { key: "DEV_PROCESS_TOKEN", value: botToken, ...varFlags });
    }
  } else if (!tokenVar.protected || !tokenVar.masked || tokenVar.environment_scope !== BOT_ENVIRONMENT) {
    act("gitlab.botTokenFlags", "update", { protected: true, masked: true, scope: BOT_ENVIRONMENT });
    if (!dryRun) await rest.put(`${P}/variables/DEV_PROCESS_TOKEN?filter[environment_scope]=${enc(tokenVar.environment_scope)}`, { value: tokenVar.value, ...varFlags });
  } else act("gitlab.botToken", "ok");
  if (policy.reviewer === "claude") {
    const key = await rest.get(`${P}/variables/ANTHROPIC_API_KEY`).catch(notFound);
    if (key) act("gitlab.apiKey", key.protected ? "ok" : "warn", key.protected ? {} : { protected: false });
    else if (env.ANTHROPIC_API_KEY) {
      act("gitlab.apiKey", "create");
      if (!dryRun) await rest.post(`${P}/variables`, { key: "ANTHROPIC_API_KEY", value: env.ANTHROPIC_API_KEY, protected: true, masked: true, environment_scope: "*", raw: true });
    } else act("gitlab.apiKeyMissing", "warn");
  }

  // 4–5. As the bot: the trigger and the schedules; then the webhook to the trigger.
  const bot = botToken ? await createGitlab({ repo: forge.repo, url: policy.gitlab?.url, env: { GITLAB_TOKEN: botToken, CI_API_V4_URL: env.CI_API_V4_URL }, fetch: fetchImpl }).ready() : null;
  let triggerToken = null;
  let triggerCreated = false;
  if (!bot) act("gitlab.trigger", "create", { as: "the bot (after its token exists)" });
  else {
    const triggers = await bot.rest.get(`${P}/triggers`);
    const mine = (triggers ?? []).find((x) => x.description === `${GITLAB_MARK}: webhook` && x.owner?.username === bot.ciIdentity);
    if (mine?.token) {
      triggerToken = mine.token;
      act("gitlab.trigger", "ok");
    } else {
      act("gitlab.trigger", "create", { owner: bot.ciIdentity });
      triggerCreated = true;
      if (!dryRun) triggerToken = (await bot.rest.post(`${P}/triggers`, { description: `${GITLAB_MARK}: webhook` })).token;
    }
    const schedules = (await bot.rest.get(`${P}/pipeline_schedules?per_page=100`)) ?? [];
    for (const sc of plan.schedules) {
      const have = schedules.find((x) => x.description === sc.description);
      if (have && have.owner?.username === bot.ciIdentity && have.cron === sc.cron && have.active) {
        act("gitlab.schedule", "ok", { task: sc.task });
        continue;
      }
      act("gitlab.schedule", have ? "update" : "create", { task: sc.task, cron: sc.cron });
      if (dryRun) continue;
      if (have) await rest.delete(`${P}/pipeline_schedules/${have.id}`);
      const made = await bot.rest.post(`${P}/pipeline_schedules`, { description: sc.description, ref: branch, cron: sc.cron, cron_timezone: "UTC", active: true });
      await bot.rest.post(`${P}/pipeline_schedules/${made.id}/variables`, { key: "DEV_PROCESS_TASK", value: sc.task });
    }
  }
  const api = apiBase(policy.gitlab?.url, env);
  const hookUrl = `${api}/projects/${project.id}/ref/${enc(branch)}/trigger/pipeline?token={token}`;
  const hooks = (await rest.get(`${P}/hooks`).catch(notFound)) ?? [];
  const hook = hooks.find((h) => String(h.url ?? "").startsWith(`${api}/projects/${project.id}/ref/`));
  const events = plan.hookEvents;
  const hookOk = hook && Object.entries(events).every(([k, v]) => hook[k] === v);
  // A new trigger has a new token: the webhook must be rewritten even when its events are right.
  if (hookOk && !triggerCreated) act("gitlab.webhook", "ok");
  else {
    act("gitlab.webhook", hook ? "update" : "create", { events: Object.keys(events).filter((k) => events[k] === true) });
    if (!dryRun && triggerToken) {
      const body = { url: hookUrl, url_variables: [{ key: "token", value: triggerToken }], ...events };
      try {
        if (hook) await rest.put(`${P}/hooks/${hook.id}`, body);
        else await rest.post(`${P}/hooks`, body);
      } catch (e) {
        if (e.status === 422 || e.status === 400) act("gitlab.webhookBlocked", "warn", { message: String(e.message).slice(0, 160) });
        else throw e;
      }
    }
  }

  // 6. The queue label; who can merge past the gate.
  for (const name of plan.labels) {
    if (!dryRun) await rest.post(`${P}/labels`, { name, color: "#5319e7" }).catch((e) => (e.status === 409 ? null : Promise.reject(e)));
  }
  const members = (await rest.paginate(`${P}/members/all`).catch(() => [])) ?? [];
  const mergers = members.filter((m) => (m.access_level ?? 0) >= 40 && !m.bot && !TOKEN_BOT.test(m.username ?? "") && m.username !== bot?.ciIdentity).map((m) => m.username);
  if (mergers.length) act("gitlab.humanMaintainers", "warn", { logins: mergers });
  const devs = members.filter((m) => (m.access_level ?? 0) >= DEVELOPER && (m.access_level ?? 0) < 40).length;
  log(`${devs} Developer(s); ${mergers.length} human Maintainer(s) or more`);
  return { actions };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadPolicy(repoRoot());
  const forge = await openForge(policy, { repo: repoName(args, repoRoot()) });
  const dryRun = Boolean(args["dry-run"]);
  if (forge.id === "github") await applyGithubRuleset(forge, policy, { dryRun });
  else if (forge.id === "gitlab") await applyGitlab(forge, policy, { dryRun });
  else throw new Error(`apply-protection: forge "${forge.id}" is not supported yet`);
}

runIfMain(import.meta.url, "apply-protection", main);
