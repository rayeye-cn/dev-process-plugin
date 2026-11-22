#!/usr/bin/env node
/**
 * Windows smoke test for the role agent's machine parts, run by the plugin's CI on a GitHub-hosted Windows runner:
 * 1. the token store: DPAPI round trip through PowerShell (a fake token, never a real one);
 * 2. the scheduler: the task XML registers with schtasks; its exact command line (conhost --headless node "<script>" …)
 *    runs a probe; a scheduler-started run is tried too (needs an interactive session, which hosted runners may lack);
 * 3. the Claude executable: resolved the way the installer does, and `--version` runs.
 *   node test/support/windows-agent-smoke.mjs <work dir>
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { childEnv, readToken, tokenCommand } from "../../engine/cli/agent-platform.mjs";
import { claudeArgs } from "../../engine/cli/agent-run.mjs";
import { validateTeam } from "../../engine/core/team.mjs";
import { gitBashFrom, pickLauncher, resolveClaude, schedulerCommands, TASK_NAME, taskAction, taskXmlFor } from "../../tools/agent-install.mjs";

const work = process.argv[2];
if (!work || process.platform !== "win32") throw new Error("usage (Windows only): windows-agent-smoke.mjs <work dir>");
mkdirSync(work, { recursive: true });
const run = (cmd, args, { env, input } = {}) => spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, input: input ?? "", env: env ? { ...process.env, ...env } : process.env });
const ok = (cond, what, r = null) => {
  if (!cond) throw new Error(`FAIL: ${what}${r ? `\n  status ${r.status}\n  stdout ${String(r.stdout).slice(0, 800)}\n  stderr ${String(r.stderr).slice(0, 1500)}` : ""}`);
  console.log(`ok: ${what}`);
};

// 1. DPAPI
const fake = "sk-ant-oat01-SMOKETESTSMOKETEST";
const st = tokenCommand("windows", "store", { home: work, token: fake });
const stored = run(st.cmd, st.args, { env: st.env, input: st.input });
ok(stored.status === 0, "token stored with DPAPI", stored);
const blob = readFileSync(join(work, "claude-token.dpapi"), "utf8");
ok(!blob.includes("SMOKETEST"), "the stored file is not the token in clear");
const rd = tokenCommand("windows", "read", { home: work });
const back = run(rd.cmd, rd.args, { env: rd.env });
ok(readToken("windows", run, { home: work }) === fake, "token reads back", { ...back, stdout: back.stdout === fake ? "(the fake token)" : back.stdout });
const del = tokenCommand("windows", "delete", { home: work });
run(del.cmd, del.args, { env: del.env });
ok(!existsSync(join(work, "claude-token.dpapi")), "token removed");

// 2. Task Scheduler: a probe in place of the runner, under a path with a space
const dir = join(work, "with space");
mkdirSync(dir, { recursive: true });
const probe = join(dir, "probe.mjs");
const mark = join(dir, "ran.txt");
writeFileSync(probe, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(mark)}, process.argv.slice(2).join("|"));\n`);
const taskFile = join(work, "task.xml");
const launcher = pickLauncher(work);
console.log(`launcher picked on this machine: ${launcher}`);
const paths = { node: process.execPath, script: probe, config: join(dir, "config.json"), log: join(dir, "agent.log") };
const xml = taskXmlFor({ ...paths, workdir: dir, intervalMin: 10, launcher });
writeFileSync(taskFile, Buffer.from(`\ufeff${xml}`, "utf16le"));
const S = schedulerCommands("windows", { taskFile });
run(...S.unload);
const reg = run(...S.install);
ok(reg.status === 0, "task registered", reg);
ok(run(...S.query).status === 0, "task queryable");
const waitMark = () => {
  for (let i = 0; i < 40 && !existsSync(mark); i++) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},500)"]);
  return existsSync(mark);
};
// the action the task runs, started the same way (command + arguments as Task Scheduler passes them)
for (const l of [...new Set(["powershell", launcher])]) {
  const a = taskAction(l, paths);
  rmSync(mark, { force: true });
  const r = spawnSync(`${a.command} ${a.arguments}`, { shell: true, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  const ran = waitMark();
  ok(ran, `the task's action runs with the ${l} launcher (quoted paths with a space)`, ran ? null : r);
  ok(readFileSync(mark, "utf8").includes("--config"), `the runner gets its arguments (${l})`);
}
// a scheduler-started run (best effort)
rmSync(mark, { force: true });
run(...S.runNow);
for (let i = 0; i < 40 && !existsSync(mark); i++) spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"]);
console.log(existsSync(mark) ? "ok: the scheduler started the task" : "note: the scheduler did not start the task here (no interactive session on this runner?)");
ok(run(...S.pause).status === 0, "task disabled");
ok(run(...S.resume).status === 0, "task enabled");
ok(run(...S.remove).status === 0, `task ${TASK_NAME} deleted`);

// 3. Claude Code
const where = run("where.exe", ["claude"]);
const claude = resolveClaude("windows", where.status === 0 ? where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
ok(Boolean(claude), `claude executable resolved (${claude})`);
const v = spawnSync(claude, ["--version"], { encoding: "utf8", windowsHide: true });
ok(v.status === 0, `claude --version runs without a shell (${(v.stdout || v.stderr).trim()})`);
// the production arguments of a role without Bash (no sandbox block), through Windows command-line quoting, with no
// credentials: Claude Code must get as far as authentication (a quoting problem would show as a bad option or JSON).
const team = validateTeam({ version: 1, people: [{ login: "ui-d", roles: ["ui"] }], roles: { ui: { instructions: "u.md", paths: ["design/**"], tools: ["Read", "Grep", "Glob", "Edit", "Write"] } } });
const cfg = join(work, "claude-config");
mkdirSync(cfg, { recursive: true });
const env = childEnv("windows", { configDir: cfg, token: "" });
delete env.CLAUDE_CODE_OAUTH_TOKEN;
const p = spawnSync(claude, claudeArgs(team, "ui", { allowRead: [dir], sandbox: false }), { cwd: dir, input: "Say hello.", encoding: "utf8", windowsHide: true, env, timeout: 120_000 });
const said = `${p.stdout}\n${p.stderr}`;
console.log(`claude -p without credentials: exit ${p.status}: ${said.replace(/\s+/g, " ").slice(0, 300)}`);
ok(!/unknown option|invalid json|unexpected token|is not valid json|error: option/i.test(said), "the production arguments parse on Windows (no option or JSON error)");
// a Bash role with the owner's unsandboxed opt-in, and Git Bash for the Bash tool and npm scripts
const teamDev = validateTeam({ version: 1, people: [{ login: "dev-b", roles: ["dev"] }], roles: { dev: { instructions: "d.md", paths: ["**"], tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"], allow: ["Bash(npm test -- *)"] } } });
const gitPaths = run("where.exe", ["git"]).stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const gitBash = gitBashFrom(gitPaths);
ok(Boolean(gitBash), `Git Bash found (${gitBash})`);
const envDev = childEnv("windows", { configDir: cfg, token: "", gitBash });
delete envDev.CLAUDE_CODE_OAUTH_TOKEN;
const pd = spawnSync(claude, claudeArgs(teamDev, "dev", { allowRead: [dir], sandbox: false, unsandboxed: true }), { cwd: dir, input: "Say hello.", encoding: "utf8", windowsHide: true, env: envDev, timeout: 120_000 });
const saidDev = `${pd.stdout}\n${pd.stderr}`;
console.log(`claude -p (unsandboxed Bash role) without credentials: exit ${pd.status}: ${saidDev.replace(/\s+/g, " ").slice(0, 200)}`);
ok(!/unknown option|invalid json|unexpected token|is not valid json|error: option|sandbox/i.test(saidDev), "the unsandboxed Bash role's arguments parse on Windows");
console.log("windows smoke: all checks passed");
