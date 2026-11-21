// The lead's report: counts from participants' runner markers only, the rendered comment, when reports are due.
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMarker, renderReport, reportsDue, summarize } from "../engine/core/agent-report.mjs";
import { validateTeam } from "../engine/core/team.mjs";

const team = validateTeam({
  version: 1,
  language: "zh",
  people: [
    { login: "lead-a", roles: ["product"], lead: true },
    { login: "dev-b", roles: ["dev"] },
  ],
  roles: {
    product: { instructions: "p.md", next: ["dev"], paths: [".prd/**"], triage: true },
    dev: { instructions: "d.md", next: ["product"], paths: ["**"] },
  },
});
const m = (fields) => `text\n\n<!-- dev-process:agent ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")} -->`;

test("parseMarker reads the runner's key=value marker", () => {
  assert.deepEqual(parseMarker(m({ run: "R1", kind: "handoff", from: "product", to: "dev" })), { run: "R1", kind: "handoff", from: "product", to: "dev" });
  assert.equal(parseMarker("no marker"), null);
});

test("summarize counts participants' markers per role; outsiders' forged markers are ignored", () => {
  const sum = summarize(team, {
    since: "2026-11-20T00:00:00Z",
    comments: [
      { login: "lead-a", issue: 1, body: m({ kind: "claimed", role: "product" }) },
      { login: "lead-a", issue: 1, body: m({ kind: "handoff", from: "product", to: "dev" }) },
      { login: "dev-b", issue: 1, body: m({ kind: "claimed", role: "dev" }) },
      { login: "dev-b", issue: 1, body: m({ kind: "review", role: "dev" }) },
      { login: "dev-b", issue: 2, body: m({ kind: "human", role: "dev" }) },
      { login: "outsider", issue: 3, body: m({ kind: "claimed", role: "dev" }) },
    ],
    pulls: [
      { number: 9, title: "fix", createdAt: "2026-11-20T10:00:00Z", mergedAt: "2026-11-20T12:00:00Z" },
      { number: 8, title: "old", createdAt: "2026-11-18T10:00:00Z", mergedAt: null },
    ],
    blocked: [{ number: 2, title: "cc @dev-b about #12", assignees: ["dev-b"] }],
  });
  assert.deepEqual(sum.roles.product, { claimed: 1, handedOn: 1, finished: 0, stopped: 0 });
  assert.deepEqual(sum.roles.dev, { claimed: 1, handedOn: 0, finished: 1, stopped: 1 });
  assert.deepEqual(sum.handoffs, [{ issue: 1, from: "product", to: "dev" }]);
  assert.deepEqual(sum.opened.map((p) => p.number), [9]);
  assert.deepEqual(sum.merged.map((p) => p.number), [9]);
  const text = renderReport(team, sum, { period: "daily", since: "2026-11-20T00:00:00Z", until: "2026-11-21T00:00:00Z" });
  assert.match(text, /岗位代理日报/);
  assert.match(text, /\| dev \| 1 \| 0 \| 1 \| 1 \|/);
  assert.match(text, /#9 fix/);
  assert.doesNotMatch(text, /(^|[^A-Za-z0-9])@[A-Za-z0-9]/, "issue titles mention nobody");
});

test("reportsDue: daily once after 18:00 local, weekly on Monday mornings", () => {
  const mon19 = new Date(2026, 10, 23, 19, 0); // Monday 23 Nov 2026, 19:00 local
  assert.deepEqual(reportsDue(mon19, {}), ["daily", "weekly"]);
  assert.deepEqual(reportsDue(mon19, { daily: "2026-11-23", weekly: "2026-11-23" }), []);
  assert.deepEqual(reportsDue(new Date(2026, 10, 24, 10, 0), {}), []);
  assert.deepEqual(reportsDue(new Date(2026, 10, 24, 18, 5), { daily: "2026-11-23" }), ["daily"]);
});
