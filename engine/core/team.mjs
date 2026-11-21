/**
 * Role agents (pure, no I/O): the team file, which issue a machine takes, which hand-offs are allowed, which paths a role
 * may change, and the text safety every agent write goes through. Design: docs/design/agents.md.
 *
 * `.dev-process/team.json` (read from the default branch only, so a pull request cannot change how agents behave):
 *   {
 *     version: 1,
 *     language: "zh" | "en",
 *     people: [{ login, roles: [role…], lead?: true }],
 *     roles: {
 *       <role>: {
 *         instructions: ".dev-process/agents/<role>.md",
 *         next: [role…],                 // where this role may hand an issue on to ("done" / "human" are always allowed)
 *         paths: ["glob"…],              // what it may change ("**" = anything outside protectedPaths)
 *         tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
 *         allow: ["Bash(npm test *)"…],  // permission rules for the run (dontAsk denies the rest)
 *         setup: ["npm ci"…],            // run by the runner in the worktree before Claude (not by the model)
 *         network: ["registry.npmjs.org"…], // sandbox network allowlist for the model's commands
 *         model?: "opus", maxTurns?: 80, triage?: true
 *       }
 *     },
 *     protectedPaths: ["glob"…],         // never changed by any agent (the review process itself)
 *     neverNotify: [login…],             // never assigned, mentioned or asked for review
 *     labels?: { rolePrefix, ready, working, review, blocked },
 *     autoQueueLow?: true                // the runner may queue a pull request the gate judged low
 *   }
 */
import { posix } from "node:path";

export const TEAM_FILE = ".dev-process/team.json";
export const TOOL_NAMES = Object.freeze(["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
export const END_STATES = Object.freeze(["done", "human"]);
export const DEFAULT_LABELS = Object.freeze({ rolePrefix: "role:", ready: "agent:ready", working: "agent:working", review: "agent:review", blocked: "agent:blocked" });
/** Always protected, whatever the team file says: the review process, its instructions and Claude Code's own config. */
export const ALWAYS_PROTECTED = Object.freeze([".github/**", ".gitlab/**", ".gitlab-ci.yml", "**/CLAUDE.md", "CLAUDE.md", ".claude/**", ".mcp.json", ".dev-process/**"]);

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ROLE = /^[a-z][a-z0-9-]{0,30}$/;
const RULE = /^(Read|Grep|Glob|Edit|Write|Bash)(\([^()\n]{1,200}\))?$/;
const DOMAIN = /^(\*\.)?[a-z0-9.-]+(:\d+)?$/i;

export class TeamError extends Error {}
const fail = (field, why) => {
  throw new TeamError(`team.${field}: ${why}`);
};
const strList = (v, field, re = null) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim() || (re && !re.test(x)))) fail(field, "must be a list of strings" + (re ? ` matching ${re}` : ""));
  return v.map((x) => x.trim());
};

/** The team file, validated and with defaults; throws TeamError naming the field. */
export function validateTeam(raw) {
  const t = raw && typeof raw === "object" ? raw : fail("", "must be an object");
  if (t.version !== 1) fail("version", "only version 1 is known");
  const language = t.language ?? "zh";
  if (!["zh", "en"].includes(language)) fail("language", 'must be "zh" or "en"');
  if (!t.roles || typeof t.roles !== "object" || !Object.keys(t.roles).length) fail("roles", "needs at least one role");
  const names = Object.keys(t.roles);
  for (const n of names) if (!ROLE.test(n) || END_STATES.includes(n)) fail(`roles.${n}`, "role names are lowercase words and not done / human");
  const roles = {};
  for (const n of names) {
    const r = t.roles[n] ?? {};
    const tools = strList(r.tools ?? ["Read", "Grep", "Glob"], `roles.${n}.tools`);
    for (const x of tools) if (!TOOL_NAMES.includes(x)) fail(`roles.${n}.tools`, `unknown tool ${x} (known: ${TOOL_NAMES.join(", ")})`);
    const allow = strList(r.allow, `roles.${n}.allow`, RULE);
    for (const rule of allow) if (!tools.includes(rule.replace(/\(.*$/, ""))) fail(`roles.${n}.allow`, `${rule} needs ${rule.replace(/\(.*$/, "")} in tools`);
    if (allow.some((x) => /^Bash$/.test(x))) fail(`roles.${n}.allow`, "a bare Bash rule allows every command; list the commands");
    const next = strList(r.next, `roles.${n}.next`);
    for (const x of next) if (!names.includes(x) || x === n) fail(`roles.${n}.next`, `${x} is not another role`);
    if (typeof r.instructions !== "string" || !r.instructions.trim()) fail(`roles.${n}.instructions`, "needs the path of the role's instructions");
    const maxTurns = r.maxTurns ?? 80;
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 500) fail(`roles.${n}.maxTurns`, "1–500");
    roles[n] = {
      instructions: r.instructions.trim(),
      next,
      paths: strList(r.paths, `roles.${n}.paths`),
      tools,
      allow,
      setup: strList(r.setup, `roles.${n}.setup`),
      network: strList(r.network, `roles.${n}.network`, DOMAIN),
      model: typeof r.model === "string" && r.model.trim() ? r.model.trim() : null,
      maxTurns,
      triage: r.triage === true,
    };
  }
  if (!Array.isArray(t.people) || !t.people.length) fail("people", "needs at least one person");
  const neverNotify = strList(t.neverNotify, "neverNotify", LOGIN);
  const seen = new Set();
  const people = t.people.map((p, i) => {
    if (!p || typeof p.login !== "string" || !LOGIN.test(p.login)) fail(`people[${i}].login`, "a GitHub login");
    const key = p.login.toLowerCase();
    if (seen.has(key)) fail(`people[${i}].login`, `${p.login} is listed twice`);
    seen.add(key);
    if (neverNotify.some((x) => x.toLowerCase() === key)) fail(`people[${i}].login`, `${p.login} is in neverNotify`);
    const rs = strList(p.roles, `people[${i}].roles`);
    if (!rs.length) fail(`people[${i}].roles`, "needs at least one role");
    for (const r of rs) if (!roles[r]) fail(`people[${i}].roles`, `unknown role ${r}`);
    return { login: p.login, roles: rs, lead: p.lead === true };
  });
  for (const n of names) if (!people.some((p) => p.roles.includes(n))) fail(`roles.${n}`, "nobody has this role");
  if (names.filter((n) => roles[n].triage).length > 1) fail("roles", "at most one role triages");
  const labels = { ...DEFAULT_LABELS, ...(t.labels ?? {}) };
  for (const [k, v] of Object.entries(labels)) if (typeof v !== "string" || !v.trim()) fail(`labels.${k}`, "a label name");
  return {
    version: 1,
    language,
    people,
    roles,
    protectedPaths: [...new Set([...ALWAYS_PROTECTED, ...strList(t.protectedPaths, "protectedPaths")])],
    neverNotify,
    labels,
    autoQueueLow: t.autoQueueLow === true,
  };
}

export const roleLabel = (team, role) => `${team.labels.rolePrefix}${role}`;
export const isParticipant = (team, login) => team.people.some((p) => p.login.toLowerCase() === String(login ?? "").toLowerCase());
export const rolesOf = (team, login) => team.people.find((p) => p.login.toLowerCase() === String(login ?? "").toLowerCase())?.roles ?? [];
export const triageRole = (team) => Object.keys(team.roles).find((n) => team.roles[n].triage) ?? null;

/** Who takes `role` for issue `number`: the role's people in team-file order, spread by issue number (stable, no race). */
export function ownerFor(team, role, number) {
  const people = team.people.filter((p) => p.roles.includes(role));
  if (!people.length) return null;
  return people[Math.abs(Number(number) || 0) % people.length].login;
}

const has = (issue, label) => issue.labels.includes(label);
const rolesOn = (team, issue) => Object.keys(team.roles).filter((r) => has(issue, roleLabel(team, r)));

/**
 * The issue this machine works on next, or null. Each issue is `{ number, state, isPull, labels, assignees, readyBy }`
 * (`readyBy`: who last applied the ready label, from the timeline). A machine takes only open issues assigned to its
 * owner, with `ready` applied by a participant, and either one of the owner's role labels or — for the triage role — no
 * role label at all. Lowest number first. `skipped` says why other ready issues were passed over (for the log).
 */
export function selectTask(team, login, issues) {
  const mine = rolesOf(team, login);
  const triage = triageRole(team);
  const skipped = [];
  const candidates = [];
  for (const i of issues) {
    if (i.isPull || i.state !== "open" || !has(i, team.labels.ready)) continue;
    const onIssue = rolesOn(team, i);
    if (!i.assignees.some((a) => a.toLowerCase() === login.toLowerCase())) continue;
    if (!isParticipant(team, i.readyBy)) {
      skipped.push({ number: i.number, why: "readyByOutsider" });
      continue;
    }
    if (onIssue.length > 1) {
      skipped.push({ number: i.number, why: "manyRoles" });
      continue;
    }
    if (onIssue.length === 1 && mine.includes(onIssue[0])) candidates.push({ issue: i, role: onIssue[0], triage: false });
    else if (onIssue.length === 0 && triage && mine.includes(triage)) candidates.push({ issue: i, role: triage, triage: true });
    else skipped.push({ number: i.number, why: "notMyRole" });
  }
  candidates.sort((a, b) => a.issue.number - b.issue.number);
  return { task: candidates[0] ?? null, skipped };
}

/** Issues marked ready with no assignee: who should get each (the triage role's owner when it has no role label). */
export function assignmentsFor(team, issues) {
  const triage = triageRole(team);
  const out = [];
  for (const i of issues) {
    if (i.isPull || i.state !== "open" || !has(i, team.labels.ready) || i.assignees.length || !isParticipant(team, i.readyBy)) continue;
    const onIssue = rolesOn(team, i);
    const role = onIssue.length === 1 ? onIssue[0] : onIssue.length === 0 ? triage : null;
    const login = role ? ownerFor(team, role, i.number) : null;
    if (login) out.push({ number: i.number, role, login });
  }
  return out;
}

/** Whether `from` may hand an issue on to `next` (a role, "done" or "human"). */
export function checkTransition(team, from, next) {
  if (END_STATES.includes(next)) return { ok: true };
  if (!team.roles[from]) return { ok: false, why: "unknownRole" };
  if (!team.roles[next]) return { ok: false, why: "unknownTarget" };
  return team.roles[from].next.includes(next) ? { ok: true } : { ok: false, why: "notAllowed" };
}

/** Changed files a role may not commit: protected ones (always refused) and ones outside the role's paths. */
export function checkPaths(team, role, files) {
  const r = team.roles[role];
  const hit = (f, globs) => globs.some((g) => posix.matchesGlob(f, g));
  const protectedHit = files.filter((f) => hit(f, team.protectedPaths));
  const outside = files.filter((f) => !protectedHit.includes(f) && !hit(f, r.paths));
  return { ok: !protectedHit.length && !outside.length, protected: protectedHit, outside };
}

/**
 * Label changes that put an issue into a state: `working` (claimed by `from`), another role (handed on, ready),
 * `human` (blocked, with `from`), `review` (a pull request is open, with `from`) or `done` (no agent labels left).
 * Only role and status labels are touched; returns `{ add, remove }` relative to `issueLabels`.
 */
export function labelsFor(team, issueLabels, { from, to }) {
  const status = new Set([team.labels.ready, team.labels.working, team.labels.review, team.labels.blocked]);
  const ours = (l) => status.has(l) || Object.keys(team.roles).some((r) => l === roleLabel(team, r));
  const want =
    to === "working" ? [roleLabel(team, from), team.labels.working]
    : team.roles[to] ? [roleLabel(team, to), team.labels.ready]
    : to === "human" ? [roleLabel(team, from), team.labels.blocked]
    : to === "review" ? [roleLabel(team, from), team.labels.review]
    : [];
  return {
    add: want.filter((l) => !issueLabels.includes(l)),
    remove: issueLabels.filter((l) => ours(l) && !want.includes(l)),
  };
}

/** Who an issue may be assigned to: participants only, never anyone in neverNotify. */
export function assignable(team, login) {
  return isParticipant(team, login) && !team.neverNotify.some((x) => x.toLowerCase() === String(login).toLowerCase());
}

/** Token shapes that must never be posted: GitHub tokens, GitLab tokens, Anthropic keys and OAuth tokens. */
export const TOKEN_SHAPES = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{10,}/g,
  /\bglcbt-[A-Za-z0-9_-]{10,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
]);

/**
 * Model text before the runner posts it under a person's login (comment, PR title / body, issue):
 * - secrets out (the exact values the runner knows, then anything shaped like a token);
 * - `<!--` disarmed (no hidden text, no forged agent / gate markers);
 * - `@login`, `#123`, `owner/repo#1` broken with a zero-width space (no notifications, no cross-references, no
 *   "Closes #N" of another issue);
 * - a zero-width space before every line-leading `/` (the gate counts `/signoff <sha>` and `/waive-ai-review <sha>`
 *   lines of the author's comments: model text must never become one).
 */
export function safeText(text, { secrets = [] } = {}) {
  let out = String(text ?? "");
  for (const v of secrets) if (typeof v === "string" && v.length >= 8) out = out.split(v).join("[redacted]");
  for (const re of TOKEN_SHAPES) out = out.replace(re, "[redacted]");
  return out
    .replace(/<!--/g, "&lt;!--")
    .replace(/([@#])(?=[A-Za-z0-9])/g, "$1​")
    .replace(/^(\s*)\//gm, "$1​/");
}
