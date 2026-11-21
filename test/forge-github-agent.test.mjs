// GitHub calls of the role-agent runner, against a fake fetch: request shapes and normalization.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as gh from "../engine/forge/github-agent.mjs";
import { createGithub } from "../engine/forge/github.mjs";

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}${u.search}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined });
    const h = routes[key] ?? routes[`${init.method ?? "GET"} ${u.pathname}`];
    if (!h) return new Response(JSON.stringify({ message: `no route ${key}` }), { status: 404 });
    const out = typeof h === "function" ? h(init.body ? JSON.parse(init.body) : undefined, u) : h;
    return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200, headers: out.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}
const forgeWith = (routes) => {
  const fetch = fakeFetch(routes);
  return { forge: createGithub({ repo: "o/r", env: { GH_TOKEN: "t" }, fetch }), fetch };
};

test("issuesWithLabel: open issues with the label, pull requests left out, names flattened", async () => {
  const { forge } = forgeWith({
    "GET /repos/o/r/issues?state=open&labels=agent%3Aready&per_page=100": [
      { number: 1, title: "a", state: "open", labels: [{ name: "agent:ready" }, { name: "role:dev" }], assignees: [{ login: "dev-b" }], user: { login: "lead-a" } },
      { number: 2, title: "pr", state: "open", labels: [{ name: "agent:ready" }], assignees: [], pull_request: {} },
    ],
  });
  assert.deepEqual(await gh.issuesWithLabel(forge, "agent:ready"), [
    { number: 1, title: "a", body: "", state: "open", isPull: false, author: "lead-a", labels: ["agent:ready", "role:dev"], assignees: ["dev-b"] },
  ]);
});

test("labeledBy: the actor of the last time that label was applied", async () => {
  const { forge, fetch } = forgeWith({
    "POST /graphql": {
      data: {
        repository: {
          issue: {
            timelineItems: {
              nodes: [
                { createdAt: "1", label: { name: "agent:ready" }, actor: { login: "outsider" } },
                { createdAt: "2", label: { name: "role:dev" }, actor: { login: "x" } },
                { createdAt: "3", label: { name: "agent:ready" }, actor: { login: "lead-a" } },
              ],
            },
          },
        },
      },
    },
  });
  assert.equal(await gh.labeledBy(forge, 5, "agent:ready"), "lead-a");
  assert.equal(fetch.calls[0].body.variables.i, 5);
  assert.equal(await gh.labeledBy(forge, 5, "agent:blocked"), null);
});

test("setAssignees replaces: DELETE the others with a body, POST the new ones", async () => {
  const { forge, fetch } = forgeWith({ "DELETE /repos/o/r/issues/3/assignees": {}, "POST /repos/o/r/issues/3/assignees": {} });
  await gh.setAssignees(forge, 3, ["dev-b", "lead-a"], ["Lead-A", "ui-d"]);
  assert.deepEqual(
    fetch.calls.map((c) => [c.key, c.body]),
    [
      ["DELETE /repos/o/r/issues/3/assignees", { assignees: ["dev-b"] }],
      ["POST /repos/o/r/issues/3/assignees", { assignees: ["ui-d"] }],
    ],
  );
});

test("removeLabels tolerates a label that is already gone", async () => {
  const { forge, fetch } = forgeWith({ "DELETE /repos/o/r/issues/3/labels/agent%3Aready": { status: 404, body: { message: "Label does not exist" } }, "DELETE /repos/o/r/issues/3/labels/role%3Adev": {} });
  await gh.removeLabels(forge, 3, ["agent:ready", "role:dev"]);
  assert.equal(fetch.calls.length, 2);
});

test("createPull and agentPulls (only my agent/ branches from this repository)", async () => {
  const { forge, fetch } = forgeWith({
    "POST /repos/o/r/pulls": { number: 9, html_url: "https://github.com/o/r/pull/9" },
    "GET /repos/o/r/pulls?state=open&per_page=100": [
      { number: 9, user: { login: "dev-b" }, head: { ref: "agent/dev/7-R1", sha: "abc", repo: { full_name: "o/r" } }, labels: [{ name: "risk:low" }], body: "x" },
      { number: 10, user: { login: "dev-b" }, head: { ref: "feature/x", sha: "def", repo: { full_name: "o/r" } }, labels: [] },
      { number: 11, user: { login: "dev-b" }, head: { ref: "agent/dev/8-R1", sha: "ghi", repo: { full_name: "fork/r" } }, labels: [] },
      { number: 12, user: { login: "other" }, head: { ref: "agent/dev/9-R1", sha: "jkl", repo: { full_name: "o/r" } }, labels: [] },
    ],
  });
  assert.deepEqual(await gh.createPull(forge, { head: "agent/dev/7-R1", base: "main", title: "t", body: "b" }), { number: 9, url: "https://github.com/o/r/pull/9" });
  assert.equal(fetch.calls[0].body.head, "agent/dev/7-R1");
  assert.deepEqual(await gh.agentPulls(forge, "DEV-B"), [{ number: 9, labels: ["risk:low"], headSha: "abc", ref: "agent/dev/7-R1", body: "x" }]);
});

test("dropReviewers removes only the listed accounts from the requested reviewers", async () => {
  const { forge, fetch } = forgeWith({
    "GET /repos/o/r/pulls/9/requested_reviewers": { users: [{ login: "quiet-x" }, { login: "lead-a" }] },
    "DELETE /repos/o/r/pulls/9/requested_reviewers": {},
  });
  assert.deepEqual(await gh.dropReviewers(forge, 9, ["Quiet-X", "quiet-y"]), ["quiet-x"]);
  assert.deepEqual(fetch.calls.at(-1).body, { reviewers: ["quiet-x"] });
});
