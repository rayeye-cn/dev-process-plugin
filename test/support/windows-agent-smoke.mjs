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

import { readToken, tokenCommand } from "../../engine/cli/agent-platform.mjs";
import { resolveClaude, schedulerCommands, TASK_NAME, taskXmlFor } from "../../tools/agent-install.mjs";

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
const xml = taskXmlFor({ node: process.execPath, script: probe, config: join(dir, "config.json"), log: join(dir, "agent.log"), workdir: dir, intervalMin: 10 });
writeFileSync(taskFile, Buffer.from(`﻿${xml}`, "utf16le"));
const S = schedulerCommands("windows", { taskFile });
run(...S.unload);
const reg = run(...S.install);
ok(reg.status === 0, "task registered", reg);
ok(run(...S.query).status === 0, "task queryable");
// the exact action of the task, run directly
const args = /<Arguments>(.*)<\/Arguments>/.exec(xml)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
rmSync(mark, { force: true });
const direct = spawnSync(`conhost.exe ${args}`, { shell: true, encoding: "utf8", windowsHide: true, timeout: 60_000 });
for (let i = 0; i < 30 && !existsSync(mark); i++) spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"]);
ok(existsSync(mark), `the task's command line runs (conhost --headless, quoted paths) [exit ${direct.status}]`);
ok(readFileSync(mark, "utf8").includes("--config"), "the runner gets its arguments");
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
console.log("windows smoke: all checks passed");
