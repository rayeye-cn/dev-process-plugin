#!/usr/bin/env node
/**
 * Set up the role agent on THIS machine (macOS). The `agent` skill gathers the answers and runs this; nothing here asks
 * for or prints a token. Design: docs/design/agents.md.
 *
 *   node agent-install.mjs check   --repo owner/name [--repo …]
 *   node agent-install.mjs install --repo owner/name [--repo …] [--mode comment|full] [--interval 10]
 *   node agent-install.mjs status | run-now | pause | resume | uninstall
 *
 * install: copies this plugin's engine to ~/.dev-process/agent/engine-<version>/ (the job never runs code from a
 * repository checkout or the plugin cache, which moves on updates), writes ~/.dev-process/agent/config.json and the
 * LaunchAgent ~/Library/LaunchAgents/com.dev-process.agent.plist, and loads it. The Claude token stays in the login
 * keychain (service "dev-process-agent-claude"), stored by the person in their own terminal.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TEAM_FILE, rolesOf, validateTeam } from "../engine/core/team.mjs";
import { renderTemplate } from "./template.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LABEL = "com.dev-process.agent";
export const KEYCHAIN_SERVICE = "dev-process-agent-claude";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The LaunchAgent for these paths (pure). Every value is XML-escaped. */
export function plistFor({ node, script, config, path, intervalMin = 10, out, err }) {
  if (!Number.isInteger(intervalMin) || intervalMin < 5 || intervalMin > 120) throw new Error("interval: 5–120 minutes");
  const tmpl = readFileSync(join(PLUGIN_ROOT, "templates/agent/com.dev-process.agent.plist.tmpl"), "utf8");
  const ctx = { label: LABEL, node: xml(node), script: xml(script), config: xml(config), path: xml(path), intervalMin, intervalSec: intervalMin * 60, out: xml(out), err: xml(err) };
  return renderTemplate(tmpl, ctx, "agent plist");
}

/** The machine config (pure): checked repos, a mode, the keychain service, the tools' paths. */
export function machineConfig({ login, repos, mode = "comment", claude }) {
  if (!login) throw new Error("login: gh must be logged in");
  if (!Array.isArray(repos) || !repos.length || repos.some((r) => !REPO.test(r))) throw new Error("repos: owner/name, at least one");
  if (!["comment", "full"].includes(mode)) throw new Error('mode: "comment" or "full"');
  return { login, repos: [...new Set(repos)], mode, keychainService: KEYCHAIN_SERVICE, claude };
}

const which = (cmd) => {
  try {
    return execFileSync("/usr/bin/which", [cmd], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const pluginVersion = () => JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin/plugin.json"), "utf8")).version;

/** What the machine has; each finding `{ ok, what, detail }`. Never prints a token. */
export function check(repos, { home = join(homedir(), ".dev-process", "agent") } = {}) {
  const out = [];
  const add = (ok, what, detail = "") => out.push({ ok, what, detail });
  add(process.platform === "darwin", "macOS", process.platform);
  add(Number(process.versions.node.split(".")[0]) >= 24, "Node 24+", process.versions.node);
  const claude = which("claude");
  add(Boolean(claude), "Claude Code installed", claude ?? "claude not on PATH");
  const gh = which("gh");
  const login = gh ? run(gh, ["api", "user", "--jq", ".login"]).stdout.trim() : "";
  add(Boolean(login), "gh logged in", login || "run: gh auth login, then gh auth setup-git");
  const tok = run("/usr/bin/security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", KEYCHAIN_SERVICE, "-w"]);
  const shaped = tok.status === 0 && /^sk-ant-oat[A-Za-z0-9_-]+$/.test(tok.stdout.trim());
  add(shaped, "Claude token in the keychain", tok.status !== 0 ? "missing" : shaped ? "ok" : "the stored value is not a token (store it again)");
  for (const repo of repos) {
    const ls = run("git", ["ls-remote", "--heads", `https://github.com/${repo}.git`]);
    add(ls.status === 0, `git can read ${repo} without a prompt`, ls.status === 0 ? "ok" : "run: gh auth setup-git");
    if (gh && login) {
      const raw = run(gh, ["api", `repos/${repo}/contents/${TEAM_FILE}`, "-H", "Accept: application/vnd.github.raw"]);
      let roles = [];
      let detail = "";
      try {
        roles = rolesOf(validateTeam(JSON.parse(raw.stdout)), login);
        detail = roles.length ? roles.join(", ") : `${login} is not in ${TEAM_FILE}`;
      } catch (e) {
        detail = raw.status === 0 ? `bad ${TEAM_FILE}: ${e.message}` : `no ${TEAM_FILE} on the default branch`;
      }
      add(roles.length > 0, `${repo}: roles for ${login}`, detail);
      const perm = run(gh, ["api", `repos/${repo}`, "--jq", ".permissions.push"]).stdout.trim();
      add(perm === "true", `${repo}: ${login} can push branches`, perm === "true" ? "ok" : "needs Write access");
    }
  }
  add(true, "agent home", home);
  return { findings: out, login, claude };
}

function paths(home) {
  return {
    home,
    config: join(home, "config.json"),
    logs: join(home, "logs"),
    plist: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
    domain: `gui/${process.getuid()}`,
  };
}

function install(repos, { mode, intervalMin, home }) {
  const c = check(repos, { home });
  const bad = c.findings.filter((f) => !f.ok);
  if (bad.length) {
    for (const f of bad) console.log(`✗ ${f.what}: ${f.detail}`);
    throw new Error("fix the items above first");
  }
  const P = paths(home);
  const engine = join(home, `engine-${pluginVersion()}`);
  rmSync(engine, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  cpSync(join(PLUGIN_ROOT, "engine"), engine, { recursive: true });
  mkdirSync(P.logs, { recursive: true });
  writeFileSync(P.config, `${JSON.stringify(machineConfig({ login: c.login, repos, mode, claude: c.claude }), null, 2)}\n`, { mode: 0o600 });
  const path = [...new Set([dirname(process.execPath), dirname(c.claude), dirname(which("gh")), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
  mkdirSync(dirname(P.plist), { recursive: true });
  writeFileSync(P.plist, plistFor({ node: process.execPath, script: join(engine, "cli/agent-run.mjs"), config: P.config, path, intervalMin, out: join(P.logs, "agent.log"), err: join(P.logs, "agent.err.log") }));
  run("launchctl", ["bootout", `${P.domain}/${LABEL}`]);
  const boot = run("launchctl", ["bootstrap", P.domain, P.plist]);
  if (boot.status !== 0) throw new Error(`launchctl bootstrap: ${boot.stderr.trim()}`);
  console.log(`installed: ${LABEL} every ${intervalMin} min, mode ${mode}, repos ${repos.join(", ")}`);
  console.log(`engine ${engine}; logs ${P.logs}`);
}

function status(home) {
  const P = paths(home);
  const loaded = run("launchctl", ["print", `${P.domain}/${LABEL}`]).status === 0;
  console.log(`LaunchAgent: ${existsSync(P.plist) ? (loaded ? "loaded" : "installed, paused") : "not installed"}`);
  if (existsSync(P.config)) console.log(`config: ${readFileSync(P.config, "utf8").trim()}`);
  const log = join(P.logs, "agent.log");
  if (existsSync(log)) console.log(`last log lines:\n${readFileSync(log, "utf8").trim().split("\n").slice(-10).join("\n")}`);
}

async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const repos = [];
  const opts = { mode: "comment", intervalMin: 10, home: join(homedir(), ".dev-process", "agent") };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--repo") repos.push(rest[++i]);
    else if (rest[i] === "--mode") opts.mode = rest[++i];
    else if (rest[i] === "--interval") opts.intervalMin = Number(rest[++i]);
    else if (rest[i] === "--home") opts.home = rest[++i];
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  const P = paths(opts.home);
  if (cmd === "check") {
    const c = check(repos, opts);
    for (const f of c.findings) console.log(`${f.ok ? "✓" : "✗"} ${f.what}${f.detail ? `: ${f.detail}` : ""}`);
    process.exitCode = c.findings.every((f) => f.ok) ? 0 : 1;
  } else if (cmd === "install") install(repos, opts);
  else if (cmd === "status") status(opts.home);
  else if (cmd === "run-now") console.log(run("launchctl", ["kickstart", `${P.domain}/${LABEL}`]).status === 0 ? "started" : "not loaded");
  else if (cmd === "pause") console.log(run("launchctl", ["bootout", `${P.domain}/${LABEL}`]).status === 0 ? "paused" : "was not loaded");
  else if (cmd === "resume") console.log(run("launchctl", ["bootstrap", P.domain, P.plist]).status === 0 ? "resumed" : "could not load (installed?)");
  else if (cmd === "uninstall") {
    run("launchctl", ["bootout", `${P.domain}/${LABEL}`]);
    rmSync(P.plist, { force: true });
    console.log(`removed ${LABEL}. Kept: ${opts.home} (logs, the agent's clones). The keychain token stays until you delete it: security delete-generic-password -s ${KEYCHAIN_SERVICE}`);
  } else throw new Error("usage: agent-install.mjs check|install|status|run-now|pause|resume|uninstall [--repo owner/name …] [--mode comment|full] [--interval N]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`agent-install: ${e.message}`);
    process.exit(1);
  });
}
