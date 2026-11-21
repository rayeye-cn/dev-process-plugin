#!/usr/bin/env node
/**
 * One run of a person's role agent (launchd starts it every few minutes). Design: docs/design/agents.md.
 *
 *   node agent-run.mjs [--config ~/.dev-process/agent/config.json] [--home dir] [--dry-run]   (--dry-run: comment mode)
 *
 * Machine config (written by the `agent` skill), `~/.dev-process/agent/config.json`:
 *   { login, repos: ["owner/name"…], mode: "comment" | "full", keychainService: "dev-process-agent-claude",
 *     claude: "/path/to/claude" }
 *
 * Per repository, in order: housekeeping (assign ready issues if this person triages, stop stale runs, queue / remind on
 * the agent's open pull requests), then at most one task: claim → worktree from the default branch → setup commands →
 * Claude (no GitHub credential, see claudeArgs) → checks → commit / push / pull request / hand-off → cleanup.
 * mode "comment": the agent's result is only posted as a comment and the issue stops for a person (nothing is pushed).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { AGENT_RESULT_SCHEMA, buildAgentPrompt, parseAgentResult } from "../core/agent-result.mjs";
import { t } from "../core/messages/index.mjs";
import { assignable, assignmentsFor, checkPaths, checkTransition, labelsFor, ownerFor, rolesOf, safeText, selectTask, TEAM_FILE, triageRole, validateTeam } from "../core/team.mjs";
import * as gh from "../forge/github-agent.mjs";
import { createGithub } from "../forge/github.mjs";
import { parseArgs, runIfMain } from "./args.mjs";

export const AGENT_HOME = join(homedir(), ".dev-process", "agent");
export const MARKER = "dev-process:agent";
const marker = (fields) => `<!-- ${MARKER} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")} -->`;

/** Paths a sandboxed command may never read (credentials); the worktree and the agent's clone stay readable. */
export const CREDENTIAL_PATHS = Object.freeze(["~/.config/gh", "~/.ssh", "~/Library/Keychains", "~/.netrc", "~/.git-credentials", "~/.aws", "~/.npmrc", "~/.docker", "~/.kube", "~/.claude", "~/.dev-process"]);

/**
 * The Claude command for a role (pure): restricted mode (no settings files, file tools confined to the worktree, Bash
 * only when the role names it), dontAsk with the role's rules, a sandbox that cannot be left, structured output.
 */
export function claudeArgs(team, role, { allowRead = [], schema = AGENT_RESULT_SCHEMA } = {}) {
  const r = team.roles[role];
  const fileTools = r.tools.filter((x) => x !== "Bash");
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem: { denyRead: [...CREDENTIAL_PATHS], allowRead: [...allowRead] },
      network: { allowedDomains: [...r.network], strictAllowlist: true },
    },
    permissions: { deny: ["WebFetch", "WebSearch", "Bash(gh *)", "Bash(git push *)", "Bash(curl *)", "Bash(wget *)"] },
  };
  return [
    "--restricted",
    "--strict-mcp-config",
    "-p",
    "--tools",
    r.tools.join(","),
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    ...fileTools,
    ...r.allow,
    "--settings",
    JSON.stringify(settings),
    "--max-turns",
    String(r.maxTurns),
    ...(r.model ? ["--model", r.model] : []),
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
  ];
}

const short = (s) => String(s).slice(0, 7);

/**
 * One repository, one pass. Everything outside is injected so tests can drive it:
 * @param ops    GitHub calls (forge/github-agent.mjs bound to a forge)
 * @param work   `{ prepare(issue, role, run) → { dir, branch }, setup(dir, commands) → { ok, why }, changedFiles(dir),
 *               commitAndPush(dir, branch, message), cleanup(dir, branch), readDefault(path) → text }`
 * @param claude `(dir, prompt, role) → raw JSON text`
 */
export async function runRepo({ team, login, base, ops, work, claude, mode = "comment", run, secrets = [], log = () => {} }) {
  const lang = team.language;
  const L = team.labels;
  const say = (code, params) => safeLines(t(lang, code, params));
  const out = { assigned: [], stale: [], queued: [], reminded: [], task: null };
  const mine = rolesOf(team, login);
  if (!mine.length) return { ...out, idle: "notInTeam" };

  // 1. Assignment (only the triage role's people do it, so one machine owns it).
  const ready = await ops.issuesWithLabel(L.ready);
  for (const i of ready) i.readyBy = await ops.labeledBy(i.number, L.ready);
  if (mine.includes(triageRole(team))) {
    for (const a of assignmentsFor(team, ready)) {
      if (!assignable(team, a.login)) continue;
      await ops.setAssignees(a.number, [], [a.login]);
      const i = ready.find((x) => x.number === a.number);
      i.assignees = [a.login];
      out.assigned.push(a);
    }
  }

  // 2. Stale runs: an issue still "working" for me while this run holds the lock never finished.
  for (const i of await ops.issuesWithLabel(L.working)) {
    if (!i.assignees.some((a) => a.toLowerCase() === login.toLowerCase())) continue;
    const role = mine.find((r) => i.labels.includes(`${L.rolePrefix}${r}`)) ?? mine[0];
    await moveTo(ops, team, i, role, "human");
    await ops.comment(i.number, say("agent.comment.stale", { role, run: "?", ready: L.ready }) + `\n\n${marker({ run, kind: "stale" })}`);
    out.stale.push(i.number);
  }

  // 3. The agent's open pull requests: queue a low one once per head, remind the author on medium / high once per head.
  for (const p of await ops.agentPulls(login)) {
    const tier = p.labels.find((l) => l.startsWith(L.riskPrefix))?.slice(L.riskPrefix.length);
    if (!tier) continue;
    const head = short(p.headSha);
    const comments = await ops.issueComments(p.number, 100);
    const done = (kind) => comments.some((c) => c.login.toLowerCase() === login.toLowerCase() && c.body.includes(`${MARKER} kind=${kind} head=${head}`));
    if (tier === "low") {
      if (!team.autoQueueLow || p.labels.includes(L.queue) || p.labels.includes(L.release) || done("queued")) continue;
      await ops.addLabels(p.number, [L.queue]);
      await ops.comment(p.number, say("agent.pr.queued") + `\n\n${marker({ kind: "queued", head })}`);
      out.queued.push(p.number);
    } else if (!done("reminder")) {
      await ops.comment(p.number, say("agent.pr.signoff", { tier }) + `\n\n${marker({ kind: "reminder", head })}`);
      out.reminded.push(p.number);
    }
  }

  // 4. At most one task.
  const { task, skipped } = selectTask(team, login, ready);
  for (const s of skipped) log(`skip #${s.number}: ${s.why}`);
  if (!task) return { ...out, idle: "noTask" };
  const { issue, role, triage } = task;
  out.task = { number: issue.number, role, triage };
  await moveTo(ops, team, issue, role, "working");
  await ops.comment(issue.number, say("agent.comment.claimed", { role, run }) + `\n\n${marker({ run, kind: "claimed", role })}`);

  let prepared = null;
  try {
    prepared = await work.prepare(issue, role, run);
    const setup = triage ? { ok: true } : await work.setup(prepared.dir, team.roles[role].setup);
    if (!setup.ok) return await stop(out, "failed", setup.why);
    const r = team.roles[role];
    const instructions = await work.readDefault(r.instructions).catch(() => "");
    const prompt = buildAgentPrompt({
      lang,
      instructions,
      issue: { ...issue, comments: await ops.issueComments(issue.number) },
      context: { role, triage, next: r.next, paths: r.paths, protectedPaths: team.protectedPaths, roles: Object.keys(team.roles) },
    });
    const result = parseAgentResult(await claude(prepared.dir, prompt, role));
    if (!result) return await stop(out, "failed", lang === "zh" ? "没有给出可用的结果" : "no usable result");
    const clean = (s) => safeText(s, { secrets });
    const files = triage ? [] : await work.changedFiles(prepared.dir);

    if (mode === "comment") {
      const lines = [clean(result.summary), "", `next: \`${clean(result.next)}\``, ...(files.length ? ["", ...files.map((f) => `- \`${f}\``)] : []), ...(result.triage ? ["", `triage: \`${clean(result.triage.role)}\``, ...result.triage.subtasks.map((s) => `- ${clean(s.title)} (\`${clean(s.role)}\`)`)] : [])];
      await moveTo(ops, team, issue, role, "human");
      await ops.comment(issue.number, `${lang === "zh" ? "（只评论模式，什么都没有提交）" : "(comment-only mode, nothing was committed)"}\n\n${lines.join("\n")}\n\n${marker({ run, kind: "comment-only", role })}`);
      out.task.result = "comment";
      return out;
    }

    if (result.status !== "done") return await stop(out, "human", null, result);

    if (triage) {
      const target = result.triage?.role ?? result.next;
      if (!team.roles[target]) return await stop(out, "badHandoff", target);
      const subtasks = [];
      for (const s of result.triage?.subtasks ?? []) {
        if (!team.roles[s.role]) continue;
        const n = await ops.createIssue({ title: clean(s.title), body: `${clean(s.body)}\n\n${lang === "zh" ? "来自" : "From"} #${issue.number}\n\n${marker({ run, kind: "subtask", parent: issue.number })}`, labels: [`${L.rolePrefix}${s.role}`, L.ready], assignees: [ownerFor(team, s.role, issue.number)].filter((x) => assignable(team, x)) });
        subtasks.push(`#${n} ${clean(s.title)} → ${s.role}`);
      }
      await moveTo(ops, team, issue, role, target);
      await assignTo(ops, team, issue, target);
      await ops.comment(issue.number, say("agent.comment.triaged", { role: target, summary: clean(result.summary), subtasks }) + `\n\n${marker({ run, kind: "triaged", role: target })}`);
      out.task.result = `triaged:${target}`;
      return out;
    }

    const next = result.next;
    const hop = checkTransition(team, role, next);
    if (!hop.ok) return await stop(out, "badHandoff", next);

    let pr = null;
    if (files.length) {
      const scope = checkPaths(team, role, files);
      if (!scope.ok) {
        await moveTo(ops, team, issue, role, "human");
        await ops.comment(issue.number, say("agent.comment.refusedPaths", { role, protected: scope.protected, outside: scope.outside }) + `\n\n${marker({ run, kind: "refused", role })}`);
        out.task.result = "refusedPaths";
        return out;
      }
      const title = clean(result.pr?.title || issue.title);
      await work.commitAndPush(prepared.dir, prepared.branch, `${title.replaceAll("​", "")}\n\nAgent-Run: ${run}\nAgent-Role: ${role}\nRefs: #${issue.number}`);
      const body = [
        `${team.roles[next] ? "Refs" : "Closes"} #${issue.number}`,
        "",
        clean(result.pr?.body || result.summary),
        "",
        say("agent.pr.verification"),
        "",
        result.pr?.verification ? clean(result.pr.verification) : say("agent.pr.noVerification"),
        "",
        say("agent.pr.footer", { role, run }),
        "",
        marker({ run, role, issue: issue.number }),
      ].join("\n");
      pr = await ops.createPull({ head: prepared.branch, base, title, body });
      await ops.dropReviewers(pr.number, team.neverNotify);
      out.task.pr = pr.number;
    }

    if (team.roles[next]) {
      await moveTo(ops, team, issue, role, next);
      await assignTo(ops, team, issue, next);
      const summary = clean(result.summary) + (pr ? `\n\nPR #${pr.number}` : "");
      await ops.comment(issue.number, say("agent.comment.handoff", { from: role, to: next, summary, handoff: clean(result.handoff) }) + `\n\n${marker({ run, kind: "handoff", from: role, to: next })}`);
      out.task.result = `handoff:${next}`;
    } else if (pr) {
      await moveTo(ops, team, issue, role, "review");
      await ops.comment(issue.number, say("agent.comment.review", { role, ref: `#${pr.number}`, summary: clean(result.summary), handoff: clean(result.handoff) }) + `\n\n${marker({ run, kind: "review", role })}`);
      out.task.result = "review";
    } else if (next === "done") {
      await moveTo(ops, team, issue, role, "done");
      await ops.comment(issue.number, say("agent.comment.done", { role, summary: clean(result.summary) }) + `\n\n${marker({ run, kind: "done", role })}`);
      await ops.closeIssue(issue.number);
      out.task.result = "done";
    } else {
      return await stop(out, "human", null, result);
    }
    return out;
  } catch (e) {
    log(`error #${issue.number}: ${e.message}`);
    return await stop(out, "failed", String(e.message).slice(0, 200));
  } finally {
    if (prepared) await work.cleanup(prepared.dir, prepared.branch).catch((e) => log(`cleanup: ${e.message}`));
  }

  async function stop(o, kind, detail, result = null) {
    await moveTo(ops, team, issue, role, "human");
    const clean = (s) => safeText(s, { secrets });
    const body =
      kind === "human" ? say("agent.comment.blocked", { role, summary: clean(result?.summary ?? ""), questions: (result?.questions ?? []).map(clean), ready: L.ready })
      : kind === "badHandoff" ? say("agent.comment.badHandoff", { role, next: clean(detail ?? "") })
      : say("agent.comment.failed", { role, why: clean(detail ?? ""), ready: L.ready });
    await ops.comment(issue.number, `${body}\n\n${marker({ run, kind, role })}`);
    o.task.result = kind;
    return o;
  }
}

/** Runner text is ours, but it embeds model text: keep it from becoming a command line or a hidden marker. */
function safeLines(text) {
  return String(text).replace(/^(\s*)\//gm, "$1​/").replace(/<!--/g, "&lt;!--");
}

async function moveTo(ops, team, issue, from, to) {
  const { add, remove } = labelsFor(team, issue.labels, { from, to });
  await ops.removeLabels(issue.number, remove);
  await ops.addLabels(issue.number, add);
  issue.labels = [...issue.labels.filter((l) => !remove.includes(l)), ...add];
}

async function assignTo(ops, team, issue, role) {
  const who = ownerFor(team, role, issue.number);
  if (!who || !assignable(team, who)) return;
  await ops.setAssignees(issue.number, issue.assignees, [who]);
  issue.assignees = [who];
}

/* ───────────── real I/O (the machine) ───────────── */

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();

function boundOps(forge) {
  const b = (f) => (...a) => f(forge, ...a);
  return {
    issuesWithLabel: b(gh.issuesWithLabel),
    labeledBy: b(gh.labeledBy),
    issueComments: b(gh.issueComments),
    addLabels: b(gh.addLabels),
    removeLabels: b(gh.removeLabels),
    setAssignees: b(gh.setAssignees),
    comment: b(gh.comment),
    createIssue: b(gh.createIssue),
    createPull: b(gh.createPull),
    agentPulls: b(gh.agentPulls),
    dropReviewers: b(gh.dropReviewers),
    closeIssue: (n) => forge.rest.patch(`/repos/${forge.owner}/${forge.name}/issues/${n}`, { state: "closed", state_reason: "completed" }),
  };
}

/** The agent's own clone of a repository (never the person's checkout), fetched to the default branch. */
function machineWork({ repo, base, home }) {
  const clone = join(home, "repos", repo.replace("/", "__"));
  if (!existsSync(join(clone, ".git"))) {
    mkdirSync(join(home, "repos"), { recursive: true });
    sh("git", ["clone", "--quiet", `https://github.com/${repo}.git`, clone]);
  }
  sh("git", ["-C", clone, "fetch", "--quiet", "--prune", "origin"]);
  const git = (...a) => sh("git", ["-C", clone, ...a]);
  return {
    clone,
    readDefault: async (path) => git("show", `origin/${base}:${path}`),
    prepare: async (issue, role, run) => {
      const dir = join(home, "work", `${repo.replace("/", "__")}-${issue.number}-${run}`);
      const branch = `agent/${role}/${issue.number}-${run}`;
      mkdirSync(join(home, "work"), { recursive: true });
      git("worktree", "add", "--quiet", "-b", branch, dir, `origin/${base}`);
      return { dir, branch };
    },
    setup: async (dir, commands) => {
      for (const c of commands) {
        const r = spawnSync("/bin/sh", ["-c", c], { cwd: dir, encoding: "utf8", timeout: 30 * 60_000 });
        if (r.status !== 0) return { ok: false, why: `setup \`${c}\` → ${r.status ?? r.signal}` };
      }
      return { ok: true };
    },
    changedFiles: async (dir) => sh("git", ["-C", dir, "status", "--porcelain=v1", "-uall"]).split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, "")),
    commitAndPush: async (dir, branch, message) => {
      sh("git", ["-C", dir, "add", "-A"]);
      sh("git", ["-C", dir, "commit", "--quiet", "-m", message]);
      sh("git", ["-C", dir, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
    },
    cleanup: async (dir, branch) => {
      try {
        git("worktree", "remove", "--force", dir);
      } catch {
        rmSync(dir, { recursive: true, force: true });
        git("worktree", "prune");
      }
      try {
        git("branch", "-D", branch);
      } catch {
        /* never created */
      }
    },
  };
}

function machineClaude({ team, claudeBin, token, home, clone }) {
  const cfg = join(home, "claude-config");
  mkdirSync(cfg, { recursive: true });
  return async (dir, prompt, role) => {
    const r = spawnSync(claudeBin, claudeArgs(team, role, { allowRead: [dir, clone] }), {
      cwd: dir,
      input: prompt,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 90 * 60_000,
      // A clean environment: no GitHub token, no API key (it would win over the OAuth token), the agent's own config dir.
      env: { HOME: homedir(), USER: process.env.USER ?? "", PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_OAUTH_TOKEN: token },
    });
    return r.stdout ?? "";
  };
}

/** One lock per machine: a second run while one is going exits at once. */
function takeLock(home) {
  const lock = join(home, "run.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    try {
      process.kill(pid, 0);
      return null;
    } catch {
      /* stale lock */
    }
  }
  writeFileSync(lock, String(process.pid));
  return () => rmSync(lock, { force: true });
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const home = args.home ?? AGENT_HOME;
  const config = JSON.parse(readFileSync(args.config ?? join(home, "config.json"), "utf8"));
  mkdirSync(home, { recursive: true });
  const release = takeLock(home);
  if (!release) return console.log("another run is going");
  const run = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const logLine = (s) => console.log(`[${new Date().toISOString()}] ${s}`);
  try {
    const ghToken = sh("gh", ["auth", "token"]);
    const token = sh("/usr/bin/security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", config.keychainService ?? "dev-process-agent-claude", "-w"]);
    const login = sh("gh", ["api", "user", "--jq", ".login"]);
    if (config.login && config.login.toLowerCase() !== login.toLowerCase()) throw new Error(`gh is logged in as ${login}, the agent is set up for ${config.login}`);
    for (const repo of config.repos ?? []) {
      const forge = createGithub({ repo, env: { GH_TOKEN: ghToken } });
      const base = await forge.defaultBranch();
      const work = machineWork({ repo, base, home });
      let team;
      try {
        team = validateTeam(JSON.parse(await work.readDefault(TEAM_FILE)));
      } catch (e) {
        logLine(`${repo}: no usable ${TEAM_FILE} on ${base}: ${e.message}`);
        continue;
      }
      const result = await runRepo({
        team,
        login,
        base,
        ops: boundOps(forge),
        work,
        claude: machineClaude({ team, claudeBin: config.claude ?? "claude", token, home, clone: work.clone }),
        mode: config.mode === "full" && !args["dry-run"] ? "full" : "comment",
        run,
        secrets: [ghToken, token],
        log: (s) => logLine(`${repo}: ${s}`),
      });
      logLine(`${repo}: ${JSON.stringify(result)}`);
    }
  } finally {
    release();
  }
}

runIfMain(import.meta.url, "agent-run", main);
