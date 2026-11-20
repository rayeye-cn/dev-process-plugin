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
import { createForge } from "../forge/index.mjs";
import { parseArgs, repoRoot, runIfMain } from "./args.mjs";

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
      codeowners: read(".github/CODEOWNERS"),
      applyTo: policy.reviewer === "copilot" && policy.securityPaths.length ? read(policy.paths.security) : null,
      claudeMd: read("CLAUDE.md"),
      tracked,
    }),
  ];
  if (!read(".dev-process/VERSION")) out.push(f("warn", "doctor.noVersion"));
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

/** GitHub: ruleset and secrets. `forge` from createForge. */
export async function remoteFindings(forge, policy) {
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
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const policy = loadPolicy(root);
  const lang = policy.language;
  const local = localFindings(root, policy);
  let remote = [];
  if (args.remote) remote = await remoteFindings(createForge(policy, { repo: typeof args.repo === "string" ? args.repo : undefined }), policy);
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
