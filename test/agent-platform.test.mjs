// Role agents across machines: token storage commands, child environment, setup shell, sandbox-less roles, the
// Windows scheduler definition and Claude executable resolution.
import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeArgs, runRepo } from "../engine/cli/agent-run.mjs";
import { childEnv, platformOf, readToken, roleRunsHere, shellFor, tokenCommand } from "../engine/cli/agent-platform.mjs";
import { validateTeam } from "../engine/core/team.mjs";
import { gitBashFrom, machineConfig, resolveClaude, schedulerCommands, TASK_NAME, taskAction, taskXmlFor } from "../tools/agent-install.mjs";

const team = validateTeam({
  version: 1,
  people: [
    { login: "ui-d", roles: ["ui"] },
    { login: "dev-b", roles: ["dev"] },
  ],
  roles: {
    ui: { instructions: "u.md", next: ["dev"], paths: ["design/**"], tools: ["Read", "Grep", "Glob", "Edit", "Write"] },
    dev: { instructions: "d.md", paths: ["**"], tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"], allow: ["Bash(npm test)"] },
  },
});

test("platformOf", () => {
  assert.equal(platformOf("darwin"), "mac");
  assert.equal(platformOf("win32"), "windows");
  assert.equal(platformOf("linux"), "linux");
});

test("Windows token: DPAPI through PowerShell, the path in the environment, the token on stdin only", () => {
  const store = tokenCommand("windows", "store", { home: "C:\\Users\\u\\.dev-process\\agent", token: "sk-ant-oat01-SECRET" });
  assert.equal(store.cmd, "powershell.exe");
  assert.equal(store.input, "sk-ant-oat01-SECRET");
  assert.ok(!store.args.join(" ").includes("SECRET"), "never in the command line");
  assert.match(store.args.at(-1), /ConvertFrom-SecureString/);
  assert.match(store.env.DEV_PROCESS_TOKEN_FILE, /claude-token\.dpapi$/);
  assert.ok("PSModulePath" in store.env && store.env.PSModulePath === undefined, "PowerShell 7's module path is not passed on");
  const read = tokenCommand("windows", "read", { home: "C:\\h" });
  assert.match(read.args.at(-1), /ConvertTo-SecureString/);
  assert.match(read.args.at(-1), /ZeroFreeBSTR/);
  assert.throws(() => tokenCommand("linux", "read", {}), /macOS or Windows/);
});

test("macOS token: the login keychain under the agent's service", () => {
  assert.deepEqual(tokenCommand("mac", "read", { user: "x" }).args, ["find-generic-password", "-a", "x", "-s", "dev-process-agent-claude", "-w"]);
});

test("readToken accepts only a token-shaped value", () => {
  assert.equal(readToken("mac", () => ({ status: 0, stdout: "sk-ant-oat01-abc\n" }), { user: "x" }), "sk-ant-oat01-abc");
  assert.equal(readToken("mac", () => ({ status: 0, stdout: "security add-generic-password ..." }), { user: "x" }), null);
  assert.equal(readToken("windows", () => ({ status: 1, stdout: "" }), { home: "C:\\h" }), null);
});

test("childEnv: what the CLI needs, the agent's config and token, never a GitHub token or an API key", () => {
  const base = { USERPROFILE: "C:\\Users\\u", APPDATA: "a", LOCALAPPDATA: "l", SystemRoot: "C:\\Windows", PATH: "p", TEMP: "t", GH_TOKEN: "gh", GITHUB_TOKEN: "gh2", ANTHROPIC_API_KEY: "k", HOME: "/Users/u", USER: "u" };
  const w = childEnv("windows", { base, configDir: "C:\\cfg", token: "tok" });
  assert.equal(w.USERPROFILE, "C:\\Users\\u");
  assert.equal(w.CLAUDE_CONFIG_DIR, "C:\\cfg");
  assert.equal(w.CLAUDE_CODE_OAUTH_TOKEN, "tok");
  assert.equal(w.CLAUDE_CODE_USE_POWERSHELL_TOOL, "0");
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY"]) assert.ok(!(k in w), k);
  const m = childEnv("mac", { base, configDir: "/cfg", token: "tok" });
  assert.deepEqual(Object.keys(m).sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HOME", "LANG", "PATH", "USER"]);
});

test("shellFor: cmd.exe on Windows, /bin/sh elsewhere", () => {
  assert.deepEqual(shellFor("mac", "npm ci"), ["/bin/sh", ["-c", "npm ci"]]);
  const [cmd, args] = shellFor("windows", "npm ci");
  assert.match(cmd, /cmd\.exe$/i);
  assert.deepEqual(args, ["/d", "/s", "/c", "npm ci"]);
});

test("without the sandbox only roles without Bash run; their arguments carry no sandbox block", () => {
  assert.equal(roleRunsHere(team, "ui", { sandbox: false }), true);
  assert.equal(roleRunsHere(team, "dev", { sandbox: false }), false);
  assert.equal(roleRunsHere(team, "dev", { sandbox: true }), true);
  const a = claudeArgs(team, "ui", { sandbox: false });
  const s = JSON.parse(a[a.indexOf("--settings") + 1]);
  assert.equal(s.sandbox, undefined);
  assert.ok(s.permissions.deny.includes("WebFetch"));
  assert.ok(a.includes("--restricted"));
  assert.throws(() => claudeArgs(team, "dev", { sandbox: false }), /needs the sandbox/);
});

test("runRepo leaves a Bash role's issue alone on a machine that cannot run it", async () => {
  const issues = [{ number: 5, title: "t", body: "", state: "open", isPull: false, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] }];
  const writes = [];
  const ops = new Proxy(
    { issuesWithLabel: async (l) => issues.filter((i) => i.labels.includes(l)), labeledBy: async () => "dev-b", agentPulls: async () => [], issueComments: async () => [] },
    { get: (o, k) => o[k] ?? (async (...a) => writes.push([k, ...a])) },
  );
  const logs = [];
  const r = await runRepo({ team, login: "dev-b", base: "main", ops, work: {}, claude: async () => "", run: "R", log: (s) => logs.push(s), canRun: (role) => roleRunsHere(team, role, { sandbox: false }) });
  assert.equal(r.idle, "noTask");
  assert.deepEqual(writes, []);
  assert.match(logs.join("\n"), /role dev needs the sandbox/);
});

test("resolveClaude on Windows: claude.exe first, else the exe the npm package ships beside the shim", () => {
  assert.equal(resolveClaude("windows", ["C:\\npm\\claude.cmd", "C:\\Users\\u\\.local\\bin\\claude.exe"]), "C:\\Users\\u\\.local\\bin\\claude.exe");
  const shipped = resolveClaude("windows", ["C:\\npm\\claude.cmd"], (p) => /claude-code[\\/]bin[\\/]claude\.exe$/.test(p));
  assert.match(shipped, /node_modules.@anthropic-ai.claude-code.bin.claude\.exe$/);
  assert.equal(resolveClaude("windows", ["C:\\npm\\claude.cmd"], () => false), null);
  // the native installer's place, not on PATH
  assert.match(resolveClaude("windows", [], (p) => /\.local[\\/]bin[\\/]claude\.exe$/.test(p), "C:\\Users\\u"), /\.local.bin.claude\.exe$/);
  assert.equal(resolveClaude("mac", ["/usr/local/bin/claude"]), "/usr/local/bin/claude");
});

test("taskXmlFor: every N minutes while logged on, one at a time, hidden console, paths quoted and escaped", () => {
  const x = taskXmlFor({ node: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Users\\a&b\\engine\\cli\\agent-run.mjs", config: "C:\\c.json", log: "C:\\l.log", workdir: "C:\\Users\\a&b", intervalMin: 15, start: new Date(2026, 10, 21, 9, 5) });
  assert.match(x, /<Interval>PT15M<\/Interval>/);
  assert.match(x, /<StartBoundary>2026-11-21T09:05:00<\/StartBoundary>/);
  assert.match(x, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(x, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(x, /<Command>conhost\.exe<\/Command>/);
  assert.match(x, /<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node\.exe&quot; &quot;C:\\Users\\a&amp;b\\engine\\cli\\agent-run\.mjs&quot; --config &quot;C:\\c\.json&quot; --log &quot;C:\\l\.log&quot;<\/Arguments>/);
  assert.doesNotMatch(x, /\{\{/);
  assert.throws(() => taskXmlFor({ node: "n", script: "s", config: "c", log: "l", workdir: "w", intervalMin: 2 }), /interval/);
});

test("schedulerCommands: schtasks on Windows, launchctl on macOS", () => {
  const w = schedulerCommands("windows", { taskFile: "C:\\t.xml" });
  assert.deepEqual(w.install, ["schtasks.exe", ["/Create", "/TN", TASK_NAME, "/XML", "C:\\t.xml", "/F"]]);
  assert.deepEqual(w.pause, ["schtasks.exe", ["/Change", "/TN", TASK_NAME, "/DISABLE"]]);
  const m = schedulerCommands("mac", { plist: "/p.plist", uid: 501 });
  assert.deepEqual(m.runNow, ["launchctl", ["kickstart", "gui/501/com.dev-process.agent"]]);
  assert.throws(() => schedulerCommands("linux", {}), /macOS or Windows/);
});

test("taskAction: the PowerShell fallback quotes paths with single quotes (doubled inside)", () => {
  const a = taskAction("powershell", { node: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Users\\o'brien\\run.mjs", config: "C:\\c.json", log: "C:\\l.log" });
  assert.equal(a.command, "powershell.exe");
  assert.match(a.arguments, /-WindowStyle Hidden/);
  assert.ok(a.arguments.endsWith(`"& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\o''brien\\run.mjs' --config 'C:\\c.json' --log 'C:\\l.log'"`), a.arguments);
  assert.match(taskXmlFor({ node: "n", script: "s", config: "c", log: "l", workdir: "w", launcher: "powershell" }), /<Command>powershell\.exe<\/Command>/);
});

test("unsandboxed (Windows, the owner's opt-in): a Bash role runs without a sandbox block; the PR says so", async () => {
  const a = claudeArgs(team, "dev", { sandbox: false, unsandboxed: true });
  const s = JSON.parse(a[a.indexOf("--settings") + 1]);
  assert.equal(s.sandbox, undefined);
  assert.ok(a.includes("Bash(npm test)"));
  assert.ok(s.permissions.deny.includes("Bash(gh *)"));
  assert.equal(roleRunsHere(team, "dev", { sandbox: false || true }), true);
  // the PR footer warns reviewers
  const issues = [{ number: 6, title: "t", body: "", state: "open", isPull: false, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] }];
  const writes = [];
  const ops = new Proxy(
    { issuesWithLabel: async (l) => issues.filter((i) => i.labels.includes(l)), labeledBy: async () => "dev-b", agentPulls: async () => [], issueComments: async () => [], createPull: async (o) => (writes.push(o), { number: 9 }) },
    { get: (o, k) => o[k] ?? (async () => {}) },
  );
  const work = { readDefault: async () => "", prepare: async () => ({ dir: "/w", branch: "agent/dev/6-R", base: null }), setup: async () => ({ ok: true }), changedFiles: async () => ["src/a.ts"], commitAndPush: async () => {}, cleanup: async () => {} };
  await runRepo({ team, login: "dev-b", base: "main", mode: "full", run: "R", ops, work, claude: async () => JSON.stringify({ structured_output: { status: "done", summary: "s", next: "done", pr: { title: "t", body: "b" } } }), canRun: () => true, unsandboxed: true });
  assert.match(writes[0].body, /没有沙箱/);
});

test("machineConfig keeps the unsandboxed opt-in and Git Bash; gitBashFrom finds bash.exe next to git", () => {
  assert.deepEqual(machineConfig({ login: "dev-b", repos: ["o/r"], claude: "c", unsandboxed: true, gitBash: "C:\\Git\\bin\\bash.exe" }).unsandboxed, true);
  assert.equal(machineConfig({ login: "dev-b", repos: ["o/r"], claude: "c" }).unsandboxed, undefined);
  assert.match(gitBashFrom(["C:\\Program Files\\Git\\cmd\\git.exe"], (p) => /Git[\\/]bin[\\/]bash\.exe$/.test(p)), /bin.bash\.exe$/);
  assert.equal(gitBashFrom(["C:\\x\\git.exe"], () => false), null);
  const env = childEnv("windows", { base: { PATH: "p" }, configDir: "c", token: "t", gitBash: "C:\\Git\\bin\\bash.exe" });
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, "C:\\Git\\bin\\bash.exe");
  assert.equal(env.npm_config_script_shell, "C:\\Git\\bin\\bash.exe");
});
