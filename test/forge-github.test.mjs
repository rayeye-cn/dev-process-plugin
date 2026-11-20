// GitHub adapter: thread paging (ported), REST paging via Link, status truncation, normalized loadChange.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { unansweredAiThreads } from "../engine/core/gate.mjs";
import { createGithub, loadReviewThreads } from "../engine/forge/github.mjs";
import { copilot } from "../engine/reviewer/copilot.mjs";
import { policy } from "./helpers.mjs";

const ENV = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" };

/** A fake fetch: routes `METHOD path` to handlers; records calls. */
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

describe("review threads paging", () => {
  const node = (login, body, typename = "User") => ({ author: { login, __typename: typename }, body, url: `u/${body}` });
  const page = (nodes, endCursor) => ({ pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes });

  it("a thread with more than a page of comments is continued; a late tagged reply still answers", async () => {
    const filler = Array.from({ length: 99 }, (_, i) => node("alice", `talk ${i}`));
    const calls = [];
    const query = async (q, v) => {
      calls.push(v);
      if (q.includes("reviewThreads")) {
        const thread = (id, comments) => ({ id, isResolved: true, isOutdated: false, path: "src/a.ts", line: 3, comments });
        return v.after
          ? { repository: { pullRequest: { reviewThreads: page([thread("T2", page([node("Copilot", "second thread", "Bot")], null))], null) } } }
          : { repository: { pullRequest: { reviewThreads: page([thread("T1", page([node("Copilot", "null deref", "Bot"), ...filler], "c100"))], "t1") } } };
      }
      assert.deepEqual(v, { id: "T1", after: "c100" });
      return { node: { comments: page([node("alice", "fixed: added a guard")], null) } };
    };
    const threads = await loadReviewThreads("o", "r", 7, query);
    assert.equal(threads.length, 2);
    assert.equal(threads[0].comments.length, 101);
    assert.deepEqual(threads[0].comments[0], { login: "Copilot", type: "Bot", body: "null deref", url: "u/null deref" });
    assert.deepEqual(
      unansweredAiThreads(threads, policy.threadReplyTags, copilot).map((th) => th.comments[0].body),
      ["second thread"],
    );
    assert.equal(unansweredAiThreads([{ ...threads[0], comments: threads[0].comments.slice(0, 100) }], policy.threadReplyTags, copilot).length, 1);
    assert.deepEqual(
      calls.filter((v) => "pr" in v),
      [
        { owner: "o", name: "r", pr: 7, after: null },
        { owner: "o", name: "r", pr: 7, after: "t1" },
      ],
    );
  });
});

describe("REST plumbing", () => {
  it("paginates by the Link header and reports errors with the status", async () => {
    const fetch = fakeFetch({
      "GET /repos/o/r/pulls?state=open&per_page=100": { body: [{ number: 1, head: { sha: "a" } }], headers: { link: '<https://api.github.com/repos/o/r/pulls?state=open&per_page=100&page=2>; rel="next"' } },
      "GET /repos/o/r/pulls?state=open&per_page=100&page=2": [{ number: 2, head: { sha: "b" } }],
    });
    const gh = createGithub({ env: ENV, fetch });
    assert.equal(await gh.findOpenPrByHead("b"), 2);
    await assert.rejects(gh.rest.get("/repos/o/r/nope"), (e) => e.status === 404 && /404/.test(e.message));
  });

  it("status descriptions are cut to fit GitHub's 140-character limit", async () => {
    const fetch = fakeFetch({ "POST /repos/o/r/statuses/abc": {} });
    const gh = createGithub({ env: ENV, fetch });
    await gh.setStatus("abc", "risk-gate", "failure", "x".repeat(300), "https://run");
    const sent = fetch.calls[0].body;
    assert.equal([...sent.description].length, 138);
    assert.equal(sent.target_url, "https://run");
  });

  it("write access: write/maintain/admin count, anything else or an error does not", async () => {
    const fetch = fakeFetch({
      "GET /repos/o/r/collaborators/w/permission": { role_name: "write" },
      "GET /repos/o/r/collaborators/r/permission": { role_name: "read" },
    });
    const gh = createGithub({ env: ENV, fetch });
    assert.equal(await gh.hasWriteAccess("w"), true);
    assert.equal(await gh.hasWriteAccess("r"), false);
    assert.equal(await gh.hasWriteAccess("missing"), false);
  });

  it("the sticky comment is edited in place when it exists, created otherwise", async () => {
    const fetch = fakeFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100": [{ id: 9, user: { login: "github-actions[bot]", type: "Bot" }, body: "<!-- risk-gate -->\nold" }],
      "PATCH /repos/o/r/issues/comments/9": {},
    });
    const gh = createGithub({ env: ENV, fetch });
    assert.equal(await gh.upsertMarkedComment(5, "<!-- risk-gate -->", "new"), 9);
    assert.deepEqual(fetch.calls.at(-1), { key: "PATCH /repos/o/r/issues/comments/9", body: { body: "<!-- risk-gate -->\nnew" } });
  });
});

describe("loadChange", () => {
  it("normalizes the PR, its reviews, comments, statuses and the latest base change", async () => {
    const fetch = fakeFetch({
      "GET /repos/o/r/pulls/7": { number: 7, user: { login: "alice" }, head: { sha: "h1", repo: { full_name: "o/r" } }, base: { ref: "main" }, draft: false, labels: [{ name: "risk:low" }] },
      "GET /repos/o/r/pulls/7/files?per_page=100": [{ filename: "a.ts", additions: 1, deletions: 2, status: "modified" }],
      "GET /repos/o/r/pulls/7/reviews?per_page=100": [{ user: { login: "bob", type: "User" }, state: "APPROVED", commit_id: "h1", submitted_at: "t", author_association: "MEMBER", body: "" }],
      "GET /repos/o/r/issues/7/comments?per_page=100": [{ id: 1, user: { login: "alice", type: "User" }, body: "/signoff h1", created_at: "c", updated_at: "u" }],
      "GET /repos/o/r/commits/h1/statuses?per_page=100": [{ context: "risk-gate", state: "pending", creator: { login: "github-actions[bot]" } }],
      "POST /graphql": (body) =>
        body.query.includes("reviewThreads")
          ? { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }
          : { data: { repository: { pullRequest: { timelineItems: { nodes: [{ createdAt: "2026-11-19T12:00:00Z" }] } } } } },
    });
    const gh = createGithub({ env: ENV, fetch });
    const c = await gh.loadChange(7, { baseHint: "2026-11-19T13:00:00Z" });
    assert.equal(c.author, "alice");
    assert.equal(c.headSha, "h1");
    assert.equal(c.baseRef, "main");
    assert.equal(c.fromFork, false);
    assert.deepEqual(c.files, [{ filename: "a.ts", previous_filename: undefined, additions: 1, deletions: 2 }]);
    assert.equal(c.reviews[0].commitId, "h1");
    assert.equal(c.comments[0].updatedAt, "u");
    assert.equal(c.baseChangedAt, "2026-11-19T13:00:00Z"); // the event's own time wins when later
  });
});
