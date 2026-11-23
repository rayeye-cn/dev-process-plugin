#!/usr/bin/env node
/**
 * The role agent's "watch" trigger: a long-running process (macOS: a KeepAlive LaunchAgent; Windows: a Task Scheduler
 * task started at logon and restarted on failure) that starts a run of agent-run.mjs as soon as the work list changes,
 * instead of every N minutes. Design: docs/design/agents.md ("Triggers").
 *
 *   node agent-watch.mjs --config <machine config> [--log <file>] [--home <agent folder>]
 *
 * Personal computers cannot receive GitHub webhooks (no public address), so "events" are read with conditional
 * requests: every poll interval (GitHub's `X-Poll-Interval`, at least 60 s) it asks each repository for the open issues
 * labelled ready with `If-None-Match`; a 304 costs no rate limit and starts nothing. A changed list (a new ready issue,
 * an assignment, an answer followed by "ready" again) starts a run within about a minute. A full run also happens every
 * `fallbackMin` minutes (default 30) for what the list does not show: the agent's pull requests (queueing, sign-off
 * reminders), issues to close after their pull requests merged, missed changes.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findNewerPlugin, startUpgrade, upgradeLocked } from "./agent-upgrade.mjs";
import { parseArgs, runIfMain } from "./args.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIN_POLL_SEC = 60;
export const DEFAULT_FALLBACK_MIN = 30;

/**
 * One poll of every repository (pure apart from `request`).
 * @param request `(url, etag) → { status, etag, pollInterval }` (a conditional GET)
 * @returns `{ changed: [repo…], etags, pollSec }`
 */
export async function pollRepos({ repos, etags, request, readyLabel = "agent:ready" }) {
  const next = { ...etags };
  const changed = [];
  let pollSec = MIN_POLL_SEC;
  for (const repo of repos) {
    const url = `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(readyLabel)}&per_page=100&sort=updated`;
    try {
      const r = await request(url, etags[repo] ?? null);
      pollSec = Math.max(pollSec, Number(r.pollInterval) || 0);
      if (r.status === 200) {
        if (etags[repo] !== r.etag) changed.push(repo);
        next[repo] = r.etag ?? null;
      }
    } catch {
      // A failed poll starts nothing; the fallback run still comes.
    }
  }
  return { changed, etags: next, pollSec };
}

/** Whether to start a run now (pure): something changed, or the fallback full run is due. */
export function shouldRun({ changed, lastRunAt, now, fallbackMin = DEFAULT_FALLBACK_MIN }) {
  if (changed.length) return { run: true, why: `changed: ${changed.join(", ")}` };
  if (now - lastRunAt >= fallbackMin * 60_000) return { run: true, why: "fallback" };
  return { run: false };
}

/** A conditional GET against the GitHub API with the person's gh token. */
function githubRequest(tokenFn, fetchImpl = globalThis.fetch) {
  return async (url, etag) => {
    const res = await fetchImpl(`https://api.github.com${url}`, {
      headers: { authorization: `Bearer ${tokenFn()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(etag ? { "if-none-match": etag } : {}) },
    });
    await res.arrayBuffer(); // the body is not needed: a changed list is enough to start a run
    return { status: res.status, etag: res.headers.get("etag"), pollInterval: res.headers.get("x-poll-interval") };
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const home = args.home ?? join(homedir(), ".dev-process", "agent");
  const configPath = args.config ?? join(home, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const logFile = args.log ?? null;
  const log = (s) => {
    const line = `[${new Date().toISOString()}] watch: ${s}`;
    console.log(line);
    if (logFile) appendFileSync(logFile, `${line}\n`);
  };
  let token = null;
  let tokenAt = 0;
  const tokenFn = () => {
    if (!token || Date.now() - tokenAt > 30 * 60_000) {
      token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", windowsHide: true }).trim();
      tokenAt = Date.now();
    }
    return token;
  };
  const request = githubRequest(tokenFn);
  const runAgent = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(HERE, "agent-run.mjs"), "--config", configPath, "--home", home, ...(logFile ? ["--log", logFile] : [])], { stdio: "inherit", windowsHide: true });
      const timer = setTimeout(() => child.kill(), 3 * 3600_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  const fallbackMin = Number(config.fallbackMin) || DEFAULT_FALLBACK_MIN;
  log(`watching ${config.repos.join(", ")} (fallback run every ${fallbackMin} min)`);
  let etags = {};
  let lastRunAt = 0;
  for (;;) {
    // A newer plugin on this machine: hand over to its setup (detached) and stop; it replaces this watcher.
    if (config.autoUpgrade !== false && !upgradeLocked(home)) {
      const newer = findNewerPlugin(config.pluginRoot, config.engineVersion);
      if (newer) {
        log(`newer plugin ${newer.version} (running ${config.engineVersion}): upgrading`);
        startUpgrade({ root: newer.root, home, log });
        process.exit(0);
      }
    }
    let polled = { changed: [], etags, pollSec: MIN_POLL_SEC };
    try {
      polled = await pollRepos({ repos: config.repos, etags, request });
    } catch (e) {
      log(`poll failed: ${e.message}`);
    }
    etags = polled.etags;
    const now = Date.now();
    const d = shouldRun({ changed: polled.changed, lastRunAt, now, fallbackMin });
    if (d.run) {
      log(`run (${d.why})`);
      lastRunAt = now;
      await runAgent();
    }
    await new Promise((r) => setTimeout(r, Math.max(MIN_POLL_SEC, polled.pollSec) * 1000));
  }
}

runIfMain(import.meta.url, "agent-watch", main);
