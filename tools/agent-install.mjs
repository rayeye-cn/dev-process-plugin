#!/usr/bin/env node
/**
 * Set up the role agent on THIS machine (macOS or Windows). The `agent` skill gathers the answers and runs this; nothing
 * here asks for or prints a token. Design: docs/design/agents.md.
 *
 *   node agent-install.mjs check   --repo owner/name [--repo …]
 *   node agent-install.mjs store-token      (the token copied from `claude setup-token`, read from the clipboard)
 *   node agent-install.mjs install --repo owner/name [--repo …] [--mode comment|full] [--interval 10] [--unsandboxed]
 *     (--unsandboxed, native Windows only: Bash roles run without the sandbox; the person must accept that risk first)
 *   node agent-install.mjs status | run-now | pause | resume | uninstall | forget-token
 *
 * install: copies this plugin's engine to ~/.dev-process/agent/engine-<version>/ (the job never runs code from a
 * repository checkout or the plugin cache, which moves on updates), writes ~/.dev-process/agent/config.json and the
 * scheduled job — macOS: the LaunchAgent ~/Library/LaunchAgents/com.dev-process.agent.plist; Windows: the Task Scheduler
 * task "dev-process-agent" (every N minutes while logged on) — and loads it. The Claude token is stored by
 * engine/cli/agent-platform.mjs: the macOS login keychain, or a DPAPI-encrypted file on Windows.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { platformOf, readToken, roleRunsHere, TOKEN_SHAPE, tokenCommand } from "../engine/cli/agent-platform.mjs";
import { TEAM_FILE, rolesOf, validateTeam } from "../engine/core/team.mjs";
import { renderTemplate } from "./template.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LABEL = "com.dev-process.agent";
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
export function machineConfig({ login, repos, mode = "comment", claude, unsandboxed = false, gitBash = null }) {
  if (!login) throw new Error("login: gh must be logged in");
  if (!Array.isArray(repos) || !repos.length || repos.some((r) => !REPO.test(r))) throw new Error("repos: owner/name, at least one");
  if (!["comment", "full"].includes(mode)) throw new Error('mode: "comment" or "full"');
  return { login, repos: [...new Set(repos)], mode, keychainService: "dev-process-agent-claude", claude, ...(unsandboxed ? { unsandboxed: true } : {}), ...(gitBash ? { gitBash } : {}) };
}

/** Git for Windows' bash.exe (the Bash tool needs it on Windows), from `git` on PATH, or null (pure). */
export function gitBashFrom(gitPaths, exists = existsSync) {
  for (const g of gitPaths) {
    for (const rel of [["..", "bin", "bash.exe"], ["..", "..", "bin", "bash.exe"]]) {
      const b = win32.join(win32.dirname(g), ...rel);
      if (exists(b)) return b;
    }
  }
  return null;
}

const PLATFORM = platformOf();
export const TASK_NAME = "dev-process-agent";

/** All paths of a command on PATH (`which` / `where.exe`), first first. */
function whichAll(cmd, platform = PLATFORM) {
  const r = spawnSync(platform === "windows" ? "where.exe" : "/usr/bin/which", platform === "windows" ? [cmd] : ["-a", cmd], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
}
const which = (cmd) => whichAll(cmd)[0] ?? null;

/**
 * The Claude executable to spawn (pure). On Windows a `.cmd` / `.ps1` npm shim cannot be spawned without a shell, so
 * the native `claude.exe` is preferred, or the one the npm package ships next to the shim.
 */
export function resolveClaude(platform, candidates, exists = existsSync, profile = process.env.USERPROFILE ?? "") {
  if (platform !== "windows") return candidates[0] ?? null;
  const exe = candidates.find((c) => /\.exe$/i.test(c));
  if (exe) return exe;
  for (const c of candidates) {
    const shipped = win32.join(win32.dirname(c), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (exists(shipped)) return shipped;
  }
  // The native installer puts it here and does not add it to PATH.
  const native = profile ? win32.join(profile, ".local", "bin", "claude.exe") : null;
  return native && exists(native) ? native : null;
}

/** The Task Scheduler definition (pure): every N minutes while the person is logged on, hidden console, one at a time. */
/**
 * How the task starts node without a console window flashing every few minutes (pure):
 * - "conhost": `conhost.exe --headless node …` (no window at all; needs a Windows build that knows --headless and an
 *   interactive session) — the installer tries it on the machine first (pickLauncher);
 * - "powershell": `powershell.exe -WindowStyle Hidden -Command & 'node' …` (works everywhere; a window may flash).
 */
export function taskAction(launcher, { node, script, config, log }) {
  const dq = (x) => `"${String(x).replace(/"/g, "")}"`;
  const sq = (x) => `'${String(x).replace(/'/g, "''")}'`;
  if (launcher === "conhost") return { command: "conhost.exe", arguments: ["--headless", dq(node), dq(script), "--config", dq(config), "--log", dq(log)].join(" ") };
  if (launcher === "powershell") return { command: "powershell.exe", arguments: `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ${[node, script, "--config", config, "--log", log].map((a) => (a.startsWith("--") ? a : sq(a))).join(" ")}"` };
  throw new Error(`unknown launcher ${launcher}`);
}

/** The Task Scheduler definition (pure): every N minutes while the person is logged on, one at a time. */
export function taskXmlFor({ node, script, config, log, workdir, intervalMin = 10, start = new Date(), launcher = "conhost" }) {
  if (!Number.isInteger(intervalMin) || intervalMin < 5 || intervalMin > 120) throw new Error("interval: 5–120 minutes");
  const pad = (n) => String(n).padStart(2, "0");
  const local = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}:00`;
  const tmpl = readFileSync(join(PLUGIN_ROOT, "templates/agent/dev-process-agent.task.xml.tmpl"), "utf8");
  const a = taskAction(launcher, { node, script, config, log });
  const ctx = { intervalMin, start: local, command: xml(a.command), arguments: xml(a.arguments), workdir: xml(workdir) };
  return renderTemplate(tmpl, ctx, "agent task xml");
}

/**
 * Try the windowless launcher on this machine: a probe started through `conhost.exe --headless` must write its mark
 * within ~10 s; otherwise fall back to PowerShell. Returns "conhost" | "powershell".
 */
export function pickLauncher(home, { wait = 10_000 } = {}) {
  const dir = join(home, "launcher-probe");
  mkdirSync(dir, { recursive: true });
  const mark = join(dir, "ran.txt");
  const probe = join(dir, "probe.mjs");
  rmSync(mark, { force: true });
  writeFileSync(probe, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(mark)}, "ok");\n`);
  spawnSync("conhost.exe", ["--headless", process.execPath, probe], { windowsHide: true, timeout: wait });
  const until = Date.now() + wait;
  while (!existsSync(mark) && Date.now() < until) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},250)"]);
  const ok = existsSync(mark);
  rmSync(dir, { recursive: true, force: true });
  return ok ? "conhost" : "powershell";
}

/** The scheduler calls per platform (pure): `{ install, query, runNow, pause, resume, remove }` → `[cmd, args]`. */
export function schedulerCommands(platform, { plist, taskFile, uid }) {
  if (platform === "mac") {
    const domain = `gui/${uid}`;
    return {
      unload: ["launchctl", ["bootout", `${domain}/${LABEL}`]],
      install: ["launchctl", ["bootstrap", domain, plist]],
      query: ["launchctl", ["print", `${domain}/${LABEL}`]],
      runNow: ["launchctl", ["kickstart", `${domain}/${LABEL}`]],
      pause: ["launchctl", ["bootout", `${domain}/${LABEL}`]],
      resume: ["launchctl", ["bootstrap", domain, plist]],
      remove: ["launchctl", ["bootout", `${domain}/${LABEL}`]],
    };
  }
  if (platform === "windows") {
    return {
      unload: ["schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"]],
      install: ["schtasks.exe", ["/Create", "/TN", TASK_NAME, "/XML", taskFile, "/F"]],
      query: ["schtasks.exe", ["/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST"]],
      runNow: ["schtasks.exe", ["/Run", "/TN", TASK_NAME]],
      pause: ["schtasks.exe", ["/Change", "/TN", TASK_NAME, "/DISABLE"]],
      resume: ["schtasks.exe", ["/Change", "/TN", TASK_NAME, "/ENABLE"]],
      remove: ["schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"]],
    };
  }
  throw new Error(`the role agent runs on macOS or Windows, not ${platform}`);
}

const run = (cmd, args, { env, input } = {}) => spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, input: input ?? "", env: env ? { ...process.env, ...env } : process.env });
const pluginVersion = () => JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin/plugin.json"), "utf8")).version;
const userName = () => process.env.USER ?? process.env.USERNAME ?? "";

/** What the machine has; each finding `{ ok, what, detail }`. Never prints a token. */
export function check(repos, { home = join(homedir(), ".dev-process", "agent"), unsandboxed = false } = {}) {
  const out = [];
  const add = (ok, what, detail = "") => out.push({ ok, what, detail });
  add(PLATFORM === "mac" || PLATFORM === "windows", "macOS or Windows", process.platform);
  add(Number(process.versions.node.split(".")[0]) >= 24, "Node 24+", process.versions.node);
  const claude = resolveClaude(PLATFORM, whichAll("claude"));
  add(Boolean(claude), "Claude Code installed", claude ?? (PLATFORM === "windows" ? "claude.exe not found (install Claude Code, then open a new terminal)" : "claude not on PATH"));
  const gh = which("gh");
  const login = gh ? run(gh, ["api", "user", "--jq", ".login"]).stdout.trim() : "";
  add(Boolean(login), "gh logged in", login || "run: gh auth login, then gh auth setup-git");
  const token = PLATFORM === "linux" ? null : readToken(PLATFORM, run, { home, user: userName() });
  add(Boolean(token), "Claude token stored for the agent", token ? "ok" : "missing or not a token: run claude setup-token, copy the token, then run this tool's store-token");
  for (const repo of repos) {
    const ls = run("git", ["ls-remote", "--heads", `https://github.com/${repo}.git`]);
    add(ls.status === 0, `git can read ${repo} without a prompt`, ls.status === 0 ? "ok" : "run: gh auth setup-git");
    if (gh && login) {
      const raw = run(gh, ["api", `repos/${repo}/contents/${TEAM_FILE}`, "-H", "Accept: application/vnd.github.raw"]);
      let roles = [];
      let detail = "";
      let team = null;
      try {
        team = validateTeam(JSON.parse(raw.stdout));
        roles = rolesOf(team, login);
        detail = roles.length ? roles.join(", ") : `${login} is not in ${TEAM_FILE}`;
      } catch (e) {
        detail = raw.status === 0 ? `bad ${TEAM_FILE}: ${e.message}` : `no ${TEAM_FILE} on the default branch`;
      }
      add(roles.length > 0, `${repo}: roles for ${login}`, detail);
      if (team && roles.length) {
        const here = roles.filter((r) => roleRunsHere(team, r, { sandbox: PLATFORM !== "windows" || unsandboxed }));
        const not = roles.filter((r) => !here.includes(r));
        if (not.length) add(here.length > 0, `${repo}: roles this machine can run`, `${here.join(", ") || "none"}; not here (they use Bash, which needs the sandbox: macOS or Linux, or install with --unsandboxed after accepting the risk): ${not.join(", ")}`);
        const bashHere = PLATFORM === "windows" && unsandboxed && here.some((r) => team.roles[r].tools.includes("Bash"));
        if (bashHere) add(Boolean(gitBashFrom(whichAll("git"))), "Git Bash (the Bash tool needs it on Windows)", gitBashFrom(whichAll("git")) ?? "install Git for Windows");
      }
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
    taskFile: join(home, "task.xml"),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
  };
}

/** Copy the token from the clipboard into the agent's store, check it reads back; prints only its length. */
function storeToken(home) {
  const clip = tokenCommand(PLATFORM, "clipboard", { home });
  const token = String(run(clip.cmd, clip.args).stdout ?? "").trim();
  if (!TOKEN_SHAPE.test(token)) throw new Error("the clipboard does not hold a Claude token (it starts with sk-ant-oat): copy what claude setup-token printed, then run this again");
  mkdirSync(home, { recursive: true });
  const st = tokenCommand(PLATFORM, "store", { home, user: userName(), token });
  const r = run(st.cmd, st.args, { env: st.env, input: st.input });
  if (r.status !== 0) throw new Error(`storing the token failed (${r.status})`);
  if (readToken(PLATFORM, run, { home, user: userName() }) !== token) throw new Error("the stored token does not read back");
  console.log(`token stored (${token.length} characters). Copy something else now to clear the clipboard.`);
}

function install(repos, { mode, intervalMin, home, unsandboxed = false }) {
  if (unsandboxed && PLATFORM !== "windows") throw new Error("--unsandboxed is only for native Windows (macOS has the sandbox)");
  if (unsandboxed) console.log("WARNING: Bash roles will run WITHOUT the sandbox on this machine: commands and test scripts the agent edits run as you, can read your credentials and reach the network. Every PR the agent opens says so.");
  const c = check(repos, { home, unsandboxed });
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
  const gitBash = PLATFORM === "windows" ? gitBashFrom(whichAll("git")) : null;
  writeFileSync(P.config, `${JSON.stringify(machineConfig({ login: c.login, repos, mode, claude: c.claude, unsandboxed, gitBash }), null, 2)}\n`, { mode: 0o600 });
  const S = schedulerCommands(PLATFORM, P);
  const script = join(engine, "cli", "agent-run.mjs");
  if (PLATFORM === "mac") {
    const path = [...new Set([dirname(process.execPath), dirname(c.claude), dirname(which("gh")), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
    mkdirSync(dirname(P.plist), { recursive: true });
    writeFileSync(P.plist, plistFor({ node: process.execPath, script, config: P.config, path, intervalMin, out: join(P.logs, "agent.log"), err: join(P.logs, "agent.err.log") }));
  } else {
    // Task Scheduler reads UTF-16 task files most reliably.
    const launcher = pickLauncher(home);
    console.log(launcher === "conhost" ? "launcher: conhost --headless (no window)" : "launcher: hidden PowerShell (conhost --headless did not work here; a window may flash when it starts)");
    writeFileSync(P.taskFile, Buffer.from(`\ufeff${taskXmlFor({ node: process.execPath, script, config: P.config, log: join(P.logs, "agent.log"), workdir: home, intervalMin, launcher })}`, "utf16le"));
  }
  run(...S.unload);
  const r = run(...S.install);
  if (r.status !== 0) throw new Error(`${S.install[0]}: ${(r.stderr || r.stdout).trim()}`);
  console.log(`installed: ${PLATFORM === "mac" ? LABEL : TASK_NAME} every ${intervalMin} min, mode ${mode}, repos ${repos.join(", ")}`);
  console.log(`engine ${engine}; logs ${P.logs}`);
}

function status(home) {
  const P = paths(home);
  const q = run(...schedulerCommands(PLATFORM, P).query);
  if (PLATFORM === "mac") console.log(`LaunchAgent: ${existsSync(P.plist) ? (q.status === 0 ? "loaded" : "installed, paused") : "not installed"}`);
  else console.log(q.status === 0 ? q.stdout.split(/\r?\n/).filter((l) => /^(TaskName|Status|Scheduled Task State|Next Run Time|Last Run Time|Last Result|任务名|状态|计划的任务状态|下次运行时间|上次运行时间|上次结果)/.test(l.trim())).join("\n") : "Task Scheduler: not installed");
  if (existsSync(P.config)) console.log(`config: ${readFileSync(P.config, "utf8").trim()}`);
  const log = join(P.logs, "agent.log");
  if (existsSync(log)) console.log(`last log lines:\n${readFileSync(log, "utf8").trim().split(/\r?\n/).slice(-10).join("\n")}`);
}

async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const repos = [];
  const opts = { mode: "comment", intervalMin: 10, home: join(homedir(), ".dev-process", "agent"), unsandboxed: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--repo") repos.push(rest[++i]);
    else if (rest[i] === "--mode") opts.mode = rest[++i];
    else if (rest[i] === "--interval") opts.intervalMin = Number(rest[++i]);
    else if (rest[i] === "--home") opts.home = rest[++i];
    else if (rest[i] === "--unsandboxed") opts.unsandboxed = true;
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  const P = paths(opts.home);
  const S = () => schedulerCommands(PLATFORM, P);
  const said = (r, ok, no) => console.log(r.status === 0 ? ok : `${no}${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
  if (cmd === "check") {
    const c = check(repos, opts);
    for (const f of c.findings) console.log(`${f.ok ? "✓" : "✗"} ${f.what}${f.detail ? `: ${f.detail}` : ""}`);
    process.exitCode = c.findings.every((f) => f.ok) ? 0 : 1;
  } else if (cmd === "store-token") storeToken(opts.home);
  else if (cmd === "forget-token") {
    const d = tokenCommand(PLATFORM, "delete", { home: opts.home, user: userName() });
    said(run(d.cmd, d.args, { env: d.env }), "token removed", "no token to remove");
  } else if (cmd === "install") install(repos, opts);
  else if (cmd === "status") status(opts.home);
  else if (cmd === "run-now") said(run(...S().runNow), "started", "not installed or paused");
  else if (cmd === "pause") said(run(...S().pause), "paused", "was not running");
  else if (cmd === "resume") said(run(...S().resume), "resumed", "could not resume (installed?)");
  else if (cmd === "uninstall") {
    run(...S().remove);
    if (PLATFORM === "mac") rmSync(P.plist, { force: true });
    rmSync(P.taskFile, { force: true });
    console.log(`removed the scheduled job. Kept: ${opts.home} (logs, the agent's clones). The stored Claude token stays until you run this tool's forget-token.`);
  } else throw new Error("usage: agent-install.mjs check|store-token|forget-token|install|status|run-now|pause|resume|uninstall [--repo owner/name …] [--mode comment|full] [--interval N]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`agent-install: ${e.message}`);
    process.exit(1);
  });
}
