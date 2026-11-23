/**
 * The role agent's own upgrades. The scheduled job runs the engine copied at setup; when the person's Claude Code has
 * a newer dev-process plugin, the agent re-runs its setup from that plugin with the same choices (`agent-install.mjs
 * upgrade`), if the person left auto-upgrade on. Design: docs/design/agents.md ("Upgrades").
 *
 * Where newer copies appear: next to the plugin folder recorded at setup — Claude Code keeps an organization-library
 * plugin's generations side by side (`dev-process`, `dev-process~g2`, …) and a marketplace plugin's versions side by
 * side (`…/dev-process/1.1.0`, `…/1.1.2`); a git checkout changes in place. Only folders holding this plugin
 * (`.claude-plugin/plugin.json` named dev-process, with `tools/agent-install.mjs`) count.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PLUGIN_NAME = "dev-process";

/** a > b for x.y.z versions (pre-release suffixes ignored). */
export function versionGreater(a, b) {
  const p = (v) => String(v ?? "0").split("-")[0].split(".").map((n) => Number(n) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

const defaultFs = {
  list: (dir) => {
    try {
      return readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isDirectory());
    } catch {
      return [];
    }
  },
  manifest: (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
    } catch {
      return null;
    }
  },
  exists: existsSync,
};

/**
 * The newest copy of this plugin on the machine that is newer than `current`, or null.
 * @param pluginRoot the plugin folder setup ran from (recorded in the machine config)
 */
export function findNewerPlugin(pluginRoot, current, fs = defaultFs) {
  if (!pluginRoot) return null;
  const candidates = [pluginRoot, ...fs.list(dirname(pluginRoot))];
  let best = null;
  for (const dir of [...new Set(candidates)]) {
    const m = fs.manifest(dir);
    if (!m || m.name !== PLUGIN_NAME || typeof m.version !== "string" || !fs.exists(join(dir, "tools", "agent-install.mjs"))) continue;
    if (!versionGreater(m.version, current)) continue;
    if (!best || versionGreater(m.version, best.version)) best = { root: dir, version: m.version };
  }
  return best;
}

/** An upgrade in progress (a lock younger than 10 minutes) — so a restarted watcher does not start a second one. */
export function upgradeLocked(home, now = Date.now()) {
  const f = join(home, "upgrade.lock");
  try {
    return now - Number(readFileSync(f, "utf8")) < 10 * 60_000;
  } catch {
    return false;
  }
}

/**
 * Start `agent-install.mjs upgrade` from the newer plugin, detached (its own process group / session), so it survives
 * the scheduler stopping this job while it replaces it.
 */
export function startUpgrade({ root, home, log }) {
  writeFileSync(join(home, "upgrade.lock"), String(Date.now()));
  const child = spawn(process.execPath, [join(root, "tools", "agent-install.mjs"), "upgrade", "--home", home], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  log(`upgrade started from ${root}`);
}

export function clearUpgradeLock(home) {
  rmSync(join(home, "upgrade.lock"), { force: true });
}
