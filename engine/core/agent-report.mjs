/**
 * The project lead's daily / weekly report of the role agents (pure). Input: the runner's marked comments in the period
 * (only those by participants count: the runner posts under participants' logins, and model text cannot carry a marker
 * because safeText disarms `<!--`), the agent pull requests, and the issues waiting for a person.
 */
import { isParticipant, safeText } from "./team.mjs";
import { t } from "./messages/index.mjs";

/** The runner's marker (cli/agent-run.mjs `marker`): `<!-- dev-process:agent k=v … -->`. */
export const MARKER_RE = /<!-- dev-process:agent ([^<>]*?) -->/;

/** `{ kind, role, from, to, … }` from one comment body, or null. */
export function parseMarker(body) {
  const m = MARKER_RE.exec(String(body ?? ""));
  if (!m) return null;
  return Object.fromEntries(m[1].trim().split(/\s+/).map((kv) => kv.split("=")).filter((p) => p.length === 2));
}

/**
 * Counts per role and the lists a lead reads.
 * @param comments `[{ login, body, issue }]` in the period
 * @param pulls    `[{ number, title, createdAt, mergedAt, role }]` agent pull requests touched in the period
 * @param blocked  `[{ number, title, assignees }]` issues with the blocked label now
 */
export function summarize(team, { comments, pulls, blocked, since }) {
  const roles = Object.fromEntries(Object.keys(team.roles).map((r) => [r, { claimed: 0, handedOn: 0, finished: 0, stopped: 0 }]));
  const handoffs = [];
  for (const c of comments) {
    if (!isParticipant(team, c.login)) continue;
    const m = parseMarker(c.body);
    if (!m) continue;
    const role = m.role ?? m.from;
    const r = roles[role];
    if (!r) continue;
    if (m.kind === "claimed") r.claimed++;
    else if (m.kind === "handoff") {
      r.handedOn++;
      handoffs.push({ issue: c.issue, from: m.from, to: m.to });
    } else if (m.kind === "review" || m.kind === "done" || m.kind === "triaged") r.finished++;
    else if (["human", "failed", "badHandoff", "refused", "stale"].includes(m.kind)) r.stopped++;
  }
  const s = new Date(since).getTime();
  return {
    roles,
    handoffs,
    opened: pulls.filter((p) => new Date(p.createdAt).getTime() >= s),
    merged: pulls.filter((p) => p.mergedAt && new Date(p.mergedAt).getTime() >= s),
    blocked,
  };
}

/** The report comment (Markdown, project language). Titles go through safeText (no mentions, refs or command lines). */
export function renderReport(team, sum, { period, since, until }) {
  const lang = team.language;
  const rows = Object.entries(sum.roles).map(([r, c]) => `| ${r} | ${c.claimed} | ${c.handedOn} | ${c.finished} | ${c.stopped} |`);
  const ref = (n) => `#${n}`;
  return [
    t(lang, period === "weekly" ? "agent.report.weekly" : "agent.report.daily", { since: since.slice(0, 10), until: until.slice(0, 10) }),
    "",
    t(lang, "agent.report.tableHead"),
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    t(lang, "agent.report.pulls", { opened: sum.opened.length, merged: sum.merged.length }),
    ...sum.merged.map((p) => `- ${ref(p.number)} ${safeText(p.title)}`),
    "",
    sum.blocked.length ? t(lang, "agent.report.blocked", { n: sum.blocked.length }) : t(lang, "agent.report.noneBlocked"),
    ...sum.blocked.map((i) => `- ${ref(i.number)} ${safeText(i.title)}${i.assignees.length ? ` (${i.assignees.join(", ")})` : ""}`),
  ].join("\n");
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Which reports are due now: daily once a day after `dailyHour`, weekly on Mondays; `state` holds the last days sent. */
export function reportsDue(now, state = {}, { dailyHour = 18 } = {}) {
  const day = localDay(now);
  const due = [];
  if (now.getHours() >= dailyHour && state.daily !== day) due.push("daily");
  if (now.getDay() === 1 && now.getHours() >= 9 && state.weekly !== day) due.push("weekly");
  return due;
}
