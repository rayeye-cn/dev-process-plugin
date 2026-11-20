#!/usr/bin/env node
/**
 * doctor: is the process installed and wired correctly?
 *
 *   node .dev-process/engine/cli/doctor.mjs            # local checks (files only)
 *   node .dev-process/engine/cli/doctor.mjs --remote   # plus GitHub: branch protection, required checks, secrets
 *   … --json                                           # findings as JSON
 *
 * Local: the consistency checks (core/consistency.mjs), the workflows the configuration needs, and whether the vendored
 * engine was edited by hand (against the render lock). Remote (GitHub): the ruleset exists, is active and requires exactly
 * the checks the configuration produces; the Claude reviewer's API key secret exists.
 * Exit code 1 when any finding is an error.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { checkConsistency } from "../core/consistency.mjs";
import { t, tr } from "../core/messages/index.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { requiredContexts, RULESET_NAME } from "../core/protection.mjs";
import { openForge } from "../forge/index.mjs";
import { parseArgs, repoName, repoRoot, runIfMain } from "./args.mjs";

/** github.com/apps/claude: the App claude-code-action posts as (claude[bot]). */
const CLAUDE_APP_SLUG = "claude";

const LOCK = ".dev-process/render-lock.json";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const f = (level, code, params = {}) => ({ level, code, params });

/** Workflow files the configuration needs (GitHub). */
export function expectedWorkflows(policy) {
  const out = ["ci.yml", "risk-gate.yml", "risk-gate-events.yml"];
  if (policy.queue.mode === "self") out.push("merge-queue.yml");
  if (policy.reviewer === "claude") out.push(policy.names.aiReviewWorkflow);
  return out;
}

export function localFindings(root, policy) {
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);
  let tracked = null;
  try {
    // working tree files that are not ignored: doctor runs before the rendered files are committed
    tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
  } catch {
    tracked = null;
  }
  const out = [
    ...checkConsistency({
      policy,
      codeowners: read(policy.forge === "gitlab" ? ".gitlab/CODEOWNERS" : ".github/CODEOWNERS"),
      applyTo: policy.reviewer === "copilot" && policy.securityPaths.length ? read(policy.paths.security) : null,
      claudeMd: read("CLAUDE.md"),
      tracked,
    }),
  ];
  if (!read(".dev-process/VERSION")) out.push(f("warn", "doctor.noVersion"));
  if (policy.forge === "gitlab") {
    for (const file of [".gitlab-ci.yml", ".gitlab/dev-process.gitlab-ci.yml"]) if (!existsSync(join(root, file))) out.push(f("error", "doctor.workflowMissing", { file }));
  }
  if (policy.forge === "github") {
    for (const w of expectedWorkflows(policy)) if (!existsSync(join(root, ".github/workflows", w))) out.push(f("error", "doctor.workflowMissing", { file: `.github/workflows/${w}` }));
    if (policy.queue.mode !== "self" && existsSync(join(root, ".github/workflows/merge-queue.yml"))) out.push(f("warn", "doctor.workflowExtra", { file: ".github/workflows/merge-queue.yml" }));
  }
  const lockText = read(LOCK);
  if (!lockText) out.push(f("warn", "doctor.noLock"));
  else {
    const lock = JSON.parse(lockText);
    const edited = Object.entries(lock.files ?? {})
      .filter(([p]) => p.startsWith(".dev-process/engine/"))
      .filter(([p, h]) => {
        const text = read(p);
        return text !== null && sha(text) !== h;
      })
      .map(([p]) => p);
    if (edited.length) out.push(f("warn", "doctor.engineEdited", { files: edited }));
  }
  return out;
}

/** Setup actions (apply-protection's dry run) that are findings: anything still to create or update, every warning. */
const GITLAB_LEVEL = { "gitlab.botTokenStray": "error", "gitlab.branch": "error", "gitlab.settings": "error", "gitlab.botToken": "error", "gitlab.botTokenFlags": "error", "gitlab.trigger": "warn", "gitlab.schedule": "error", "gitlab.webhook": "warn", "gitlab.approvals": "warn", "gitlab.apiKey": "warn" };
// Human Maintainers / Owners are warnings, not errors: a project always has an Owner (often whoever runs this).
const GITLAB_ERRORS = new Set(["gitlab.jobTokenPush", "gitlab.apiKeyMissing", "gitlab.wildcardBranch"]);

/**
 * GitLab: the setup's dry run (so doctor and apply-protection cannot disagree), plus what only doctor looks at:
 * wildcard protected branches (17.11 may hand MR pipelines protected variables through them) and the bot token's
 * expiry. Job-token pushes and wildcard protected branches are errors; human Maintainers / Owners and MR pipelines that
 * may read protected variables are warnings that name the risk (a project always has an Owner).
 */
export async function gitlabFindings(forge, policy, { now = new Date(), fetch: fetchImpl = globalThis.fetch } = {}) {
  const { applyGitlab } = await import("./apply-protection.mjs");
  const out = [];
  let actions;
  try {
    ({ actions } = await applyGitlab(forge, policy, { dryRun: true, log: () => {}, fetch: fetchImpl, today: now }));
  } catch (e) {
    return [f("error", "doctor.remoteUnreachable", { repo: forge.repo, message: String(e.message).slice(0, 120) })];
  }
  for (const a of actions) {
    if (a.action === "ok") continue;
    const level = GITLAB_ERRORS.has(a.code) ? "error" : a.action === "warn" ? "warn" : (GITLAB_LEVEL[a.code] ?? "warn");
    out.push(f(level, "doctor.gitlab.setup", { code: a.code, action: a.action, params: a.params }));
  }
  const P = `/projects/${encodeURIComponent(forge.repo)}`;
  const branches = (await forge.rest.get(`${P}/protected_branches?per_page=100`).catch(() => [])) ?? [];
  const wild = branches.map((b) => b.name).filter((n) => /[*]/.test(n));
  if (wild.length) out.push(f("error", "doctor.gitlab.setup", { code: "gitlab.wildcardBranch", action: "warn", params: { names: wild } }));
  const tokens = (await forge.rest.get(`${P}/access_tokens?per_page=100`).catch(() => [])) ?? [];
  const mine = tokens.filter((x) => x.active !== false && !x.revoked && String(x.name ?? "").startsWith("dev-process"));
  for (const x of mine) {
    const days = x.expires_at ? Math.floor((Date.parse(`${x.expires_at}T00:00:00Z`) - now.getTime()) / 86_400_000) : null;
    if (days !== null && days <= 30) out.push(f(days <= 7 ? "error" : "warn", "doctor.gitlab.tokenExpiry", { name: x.name, days }));
  }
  return out;
}

/** GitHub: ruleset and secrets; GitLab: gitlabFindings. `forge` from createForge. */
export async function remoteFindings(forge, policy) {
  if (forge.id === "gitlab") return gitlabFindings(forge, policy);
  const out = [];
  const base = `/repos/${forge.owner}/${forge.name}`;
  let rulesets;
  try {
    rulesets = await forge.rest.get(`${base}/rulesets?includes_parents=false`);
  } catch (e) {
    return [f("error", "doctor.remoteUnreachable", { repo: forge.repo, message: String(e.message).slice(0, 120) })];
  }
  const summary = rulesets.find((r) => r.name === RULESET_NAME);
  if (!summary) out.push(f("warn", "doctor.rulesetMissing", { name: RULESET_NAME, pr: forge.prTerm }));
  else {
    const rs = await forge.rest.get(`${base}/rulesets/${summary.id}`);
    if (rs.enforcement !== "active") out.push(f("error", "doctor.rulesetDisabled", { name: RULESET_NAME, enforcement: rs.enforcement }));
    const have = (rs.rules ?? []).find((r) => r.type === "required_status_checks")?.parameters?.required_status_checks?.map((c) => c.context) ?? [];
    const want = requiredContexts(policy);
    const missing = want.filter((c) => !have.includes(c));
    const extra = have.filter((c) => !want.includes(c));
    if (missing.length || extra.length) out.push(f("error", "doctor.rulesetChecks", { missing, extra }));
  }
  if (policy.reviewer === "claude") {
    try {
      await forge.rest.get(`${base}/actions/secrets/ANTHROPIC_API_KEY`);
    } catch (e) {
      if (e.status === 404) out.push(f("error", "doctor.secretMissing", { name: "ANTHROPIC_API_KEY", why: t(policy.language, "doctor.why.claude") }));
      else out.push(f("warn", "doctor.secretUnknown", { name: "ANTHROPIC_API_KEY" }));
    }
    out.push(...(await claudeAppFindings(forge)));
  }
  return out;
}

/**
 * Is the Claude GitHub App installed? Without it claude-code-action cannot get the App's token and every review job
 * fails. Best effort: an organization's installations can be listed by an organization admin (403 otherwise ⇒ ask to
 * check by hand); a personal account's cannot with a user token (404 ⇒ say nothing). An installation limited to selected
 * repositories may still leave this one out; that is not visible here.
 */
async function claudeAppFindings(forge) {
  let list;
  try {
    list = await forge.rest.get(`/orgs/${forge.owner}/installations?per_page=100`);
  } catch (e) {
    return e.status === 403 ? [f("warn", "doctor.claudeAppUnknown", { owner: forge.owner, repo: forge.repo })] : [];
  }
  const found = (list?.installations ?? []).some((i) => i.app_slug === CLAUDE_APP_SLUG);
  return found ? [] : [f("error", "doctor.claudeAppMissing", { owner: forge.owner, repo: forge.repo })];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const policy = loadPolicy(root);
  const lang = policy.language;
  const local = localFindings(root, policy);
  let remote = [];
  if (args.remote) remote = await remoteFindings(await openForge(policy, { repo: repoName(args, repoRoot()) }), policy);
  const all = [...local, ...remote];
  if (args.json) console.log(JSON.stringify(all, null, 2));
  else {
    const print = (title, list) => {
      console.log(`## ${t(lang, title)}`);
      if (!list.length) console.log(`- ${t(lang, "doctor.ok")}`);
      for (const x of list) console.log(`- ${x.level === "error" ? "ERROR" : "warn"}: ${tr(lang, x)}`);
    };
    print("doctor.header.local", local);
    if (args.remote) print("doctor.header.remote", remote);
  }
  if (all.some((x) => x.level === "error")) process.exitCode = 1;
}

runIfMain(import.meta.url, "doctor", main);
