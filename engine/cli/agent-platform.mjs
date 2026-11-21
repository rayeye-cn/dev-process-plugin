/**
 * What differs between the machines a role agent runs on (macOS, Windows): where the Claude token is kept, the child
 * process environment, how setup commands run, how hooks are switched off. Everything takes its OS calls as arguments
 * so tests run on any machine. Design: docs/design/agents.md ("Windows").
 *
 * Token storage
 * - macOS: the login keychain, generic password, service `dev-process-agent-claude` (the `security` tool).
 * - Windows: a file encrypted with DPAPI for the current user (PowerShell's ConvertFrom-SecureString, built in), at
 *   `%USERPROFILE%\.dev-process\agent\claude-token.dpapi`. Only that user on that machine can decrypt it. The token
 *   travels through stdin / stdout of PowerShell, never through its command line.
 */
import { join } from "node:path";

export const KEYCHAIN_SERVICE = "dev-process-agent-claude";
export const TOKEN_FILE = "claude-token.dpapi";
export const TOKEN_SHAPE = /^sk-ant-oat[A-Za-z0-9_-]+$/;

/** "mac" | "windows" | "linux". */
export const platformOf = (p = process.platform) => (p === "darwin" ? "mac" : p === "win32" ? "windows" : "linux");

const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
// The file path comes through the environment, the token through stdin / stdout: nothing secret in an argument.
const PS_READ = "$ErrorActionPreference='Stop'; $s = (Get-Content -LiteralPath $env:DEV_PROCESS_TOKEN_FILE -Raw).Trim() | ConvertTo-SecureString; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }";
const PS_STORE = "$ErrorActionPreference='Stop'; $t = [Console]::In.ReadToEnd().Trim(); New-Item -ItemType Directory -Force -Path (Split-Path -Parent $env:DEV_PROCESS_TOKEN_FILE) | Out-Null; ConvertTo-SecureString -String $t -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $env:DEV_PROCESS_TOKEN_FILE -NoNewline";
const PS_CLIPBOARD = "[Console]::Out.Write((Get-Clipboard -Raw))";

/**
 * The commands for the token, per platform: `{ cmd, args, input?, env? }` objects the caller runs (pure).
 * @param op "read" | "store" | "clipboard" | "delete"
 */
export function tokenCommand(platform, op, { home, user = "", token = "" } = {}) {
  if (platform === "mac") {
    if (op === "read") return { cmd: "/usr/bin/security", args: ["find-generic-password", "-a", user, "-s", KEYCHAIN_SERVICE, "-w"] };
    // `security` takes the password only as an argument or from a terminal prompt: the argument lives for the
    // fraction of a second the command runs, on the person's own machine.
    if (op === "store") return { cmd: "/usr/bin/security", args: ["add-generic-password", "-U", "-a", user, "-s", KEYCHAIN_SERVICE, "-w", token] };
    if (op === "clipboard") return { cmd: "/usr/bin/pbpaste", args: [] };
    if (op === "delete") return { cmd: "/usr/bin/security", args: ["delete-generic-password", "-a", user, "-s", KEYCHAIN_SERVICE] };
  }
  if (platform === "windows") {
    const env = { DEV_PROCESS_TOKEN_FILE: join(home, TOKEN_FILE) };
    if (op === "read") return { cmd: "powershell.exe", args: [...PS, PS_READ], env };
    if (op === "store") return { cmd: "powershell.exe", args: [...PS, PS_STORE], env, input: token };
    if (op === "clipboard") return { cmd: "powershell.exe", args: [...PS, PS_CLIPBOARD] };
    if (op === "delete") return { cmd: "powershell.exe", args: [...PS, "Remove-Item -LiteralPath $env:DEV_PROCESS_TOKEN_FILE -Force -ErrorAction SilentlyContinue"], env };
  }
  throw new Error(`the role agent runs on macOS or Windows, not ${platform}`);
}

/** Read the token with `run(cmd, args, { input, env }) → { status, stdout }`; null when missing or not token-shaped. */
export function readToken(platform, run, opts) {
  const c = tokenCommand(platform, "read", opts);
  const r = run(c.cmd, c.args, { env: c.env });
  const t = r.status === 0 ? String(r.stdout ?? "").trim() : "";
  return TOKEN_SHAPE.test(t) ? t : null;
}

/**
 * The Claude child's environment: what the CLI needs on that OS, the agent's own config dir and the OAuth token —
 * and nothing else (no GH_TOKEN / GITHUB_TOKEN, no ANTHROPIC_API_KEY, which would win over the token).
 */
export function childEnv(platform, { base = process.env, configDir, token }) {
  const pick = (keys) => Object.fromEntries(keys.filter((k) => base[k] !== undefined).map((k) => [k, base[k]]));
  const common = { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: token };
  if (platform === "windows") {
    return { ...pick(["USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "PATH", "Path", "PATHEXT", "ComSpec", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]), ...common };
  }
  return { HOME: base.HOME ?? "", USER: base.USER ?? "", PATH: base.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", ...common };
}

/** How a setup command line runs: `[cmd, args]`. */
export function shellFor(platform, line) {
  return platform === "windows" ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line]] : ["/bin/sh", ["-c", line]];
}

/** An always-empty hooks directory (git runs no hooks from it on any OS). */
export const noHooksDir = (home) => join(home, "no-hooks");

/**
 * Whether a role can run on this machine: Bash (and anything it starts) needs the sandbox, which Claude Code provides on
 * macOS and Linux; a role without Bash only uses file tools, which `--restricted` confines to the worktree everywhere.
 */
export function roleRunsHere(team, role, { sandbox }) {
  return sandbox || !team.roles[role].tools.includes("Bash");
}
