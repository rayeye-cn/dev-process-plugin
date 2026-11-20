// Claude's review on GitLab: the model answers with JSON, the bot posts threads and a summary it writes itself.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { postReview } from "../engine/cli/post-review.mjs";
import { diffLines, neutralizeForGitlab, parseReview, planReview, REVIEW_SCHEMA, scrubSecrets } from "../engine/core/post-review.mjs";
import { createGitlab } from "../engine/forge/gitlab.mjs";
import { claudeMarker, claudeNoticeMarker } from "../engine/reviewer/claude.mjs";
import { reviewerOn } from "../engine/reviewer/index.mjs";
import { policy } from "./helpers.mjs";

const HEAD = "b".repeat(40);
const BOT = "project_42_bot_0123abcd";
const P = "/projects/grp%2Fapp";
const ZW = "​";

const DIFF = "@@ -10,4 +10,5 @@ function total(items) {\n   let sum = 0;\n-  for (const i of items) sum += i;\n+  for (const i of items) sum += i.price;\n+  sum = Math.round(sum);\n   return sum;\n }\n";
const diffs = [{ old_path: "src/cart.mjs", new_path: "src/cart.mjs", diff: DIFF }];

describe("the review answer", () => {
  it("the schema is what parseReview accepts; bad answers are null; findings are trimmed and capped", () => {
    assert.deepEqual(REVIEW_SCHEMA.required, ["findings", "risk", "reason"]);
    const ok = parseReview(JSON.stringify({ structured_output: { findings: [{ file: "./src/a.js", line: 3, title: " t ", body: "b" }, { file: "x", line: 0, title: "bad line", body: "" }], risk: "medium", reason: "r" } }));
    assert.deepEqual(ok.findings, [{ file: "src/a.js", line: 3, title: "t", body: "b" }]);
    assert.equal(ok.risk, "medium");
    assert.equal(parseReview("not json"), null);
    assert.equal(parseReview(JSON.stringify({ findings: [], risk: "extreme", reason: "" })), null);
    assert.equal(parseReview(JSON.stringify({ result: "{}" })), null);
  });

  it("diff lines: added lines have no old line, context lines keep theirs, removed lines are not on the new side", () => {
    const m = diffLines(DIFF);
    assert.deepEqual([...m.entries()], [[10, 10], [11, null], [12, null], [13, 12], [14, 13]]);
  });

  it("model text: no mentions, no references, no hidden HTML", () => {
    assert.equal(neutralizeForGitlab("ask @bob about #12, !7 and &3 <!-- ai-review:claude sha=x -->"), `ask @${ZW}bob about #${ZW}12, !${ZW}7 and &${ZW}3 &lt;!-- ai-review:claude sha=x -->`);
    assert.equal(neutralizeForGitlab("Wow! ![img](u) a != b"), "Wow! ![img](u) a != b");
  });

  it("secrets never reach a note: exact values the job knows and token shapes", () => {
    assert.equal(scrubSecrets("key sk-ant-api03-AAAAAAAAAAAA and glpat-BBBBBBBBBBBBBBBB and s3cr3t-value", ["s3cr3t-value", "short"]), "key [redacted] and [redacted] and [redacted]");
    const plan = planReview({ findings: [{ file: "src/cart.mjs", line: 12, title: "leak", body: "token is s3cr3t-value" }], risk: "high", reason: "glpat-CCCCCCCCCCCCCCCC", unchecked: "" }, diffs, { sha: HEAD, secrets: ["s3cr3t-value"] });
    assert.ok(!plan.threads[0].body.includes("s3cr3t") && !plan.summary.includes("glpat-"));
  });

  it("plan: a finding on a diff line gets a position; elsewhere a plain thread naming the place; the summary ends with the marker", () => {
    const review = {
      findings: [
        { file: "src/cart.mjs", line: 12, title: "rounds the total", body: "Math.round drops cents; use cents everywhere." },
        { file: "src/cart.mjs", line: 40, title: "not in the diff", body: "x" },
        { file: "src/other.mjs", line: 1, title: "other file", body: "y" },
      ],
      risk: "medium",
      reason: "money math",
      unchecked: "",
    };
    const plan = planReview(review, diffs, { sha: HEAD, maxComments: 2, lang: "en" });
    assert.equal(plan.threads.length, 2, "capped");
    assert.deepEqual(plan.threads[0].position, { new_path: "src/cart.mjs", old_path: "src/cart.mjs", new_line: 12, old_line: null });
    assert.equal(plan.threads[1].position, null);
    assert.match(plan.threads[1].body, /`src\/cart\.mjs:40`/);
    assert.ok(plan.summary.endsWith(`\n${claudeMarker(HEAD)}`));
    assert.match(plan.summary, /2 finding\(s\).*1 more over the per-review cap/s);
    assert.match(plan.summary, /1 of them point at lines outside the diff/);
    const none = planReview({ findings: [], risk: "low", reason: "docs only", unchecked: "" }, diffs, { sha: HEAD, lang: "zh" });
    assert.match(none.summary, /没有发现问题/);
  });
});

/* ───────────── the CLI against a fake GitLab ───────────── */

function gitlab({ notes = [], head = HEAD, rejectPosition = false } = {}) {
  const calls = [];
  const mr = { iid: 7, state: "opened", title: "fix: x", author: { username: "alice" }, sha: head, target_branch: "main", source_project_id: 1, project_id: 1, draft: false, labels: [], diff_refs: { base_sha: "1".repeat(40), start_sha: "1".repeat(40), head_sha: head } };
  const routes = {
    "GET /user": () => ({ username: BOT }),
    [`GET ${P}/merge_requests/7`]: () => mr,
    [`GET ${P}/merge_requests/7/approvals`]: () => ({ approved_by: [] }),
    [`GET ${P}/merge_requests/7/reviewers`]: () => [],
    [`GET ${P}/merge_requests/7/notes`]: () => notes,
    [`GET ${P}/merge_requests/7/discussions`]: () => [],
    [`GET ${P}/merge_requests/7/versions`]: () => [{ head_commit_sha: head, created_at: "2026-11-20T12:00:00Z" }],
    [`GET ${P}/merge_requests/7/diffs`]: () => diffs,
    [`GET ${P}/repository/commits/${head}/statuses`]: () => [],
    [`POST ${P}/merge_requests/7/discussions`]: (b) => (b.position && rejectPosition ? { status: 400, body: { message: "400 Bad request - Note {:line_code=>[\"can't be blank\"]}" } } : { id: `d${calls.length}` }),
    [`POST ${P}/merge_requests/7/notes`]: (b) => ({ id: 99, ...b }),
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname.replace(/^\/api\/v4/, "")}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body });
    const r = routes[key];
    if (!r) return new Response(JSON.stringify({ message: "404" }), { status: 404 });
    const out = r(body);
    const res = out && typeof out === "object" && "status" in out && "body" in out ? out : { status: 200, body: out };
    return new Response(JSON.stringify(res.body), { status: res.status });
  };
  return { fetch, calls };
}
const ENV = { CI_API_V4_URL: "https://gl.example/api/v4", CI_PROJECT_PATH: "grp/app", DEV_PROCESS_TOKEN: "t" };
const pol = { ...policy, forge: "gitlab", reviewer: "claude", aiReview: { ...policy.aiReview, accounts: [], maxComments: 10 } };
const answer = (findings) => JSON.stringify({ structured_output: { findings, risk: "medium", reason: "money", unchecked: "" } });

async function run(g, raw, opts = {}) {
  const forge = await createGitlab({ env: ENV, fetch: g.fetch }).ready();
  return postReview({ forge, policy: pol, reviewer: reviewerOn(pol, forge), number: "7", sha: HEAD, raw, env: {}, log: () => {}, ...opts });
}

describe("post-review CLI", () => {
  it("posts the threads, then the summary; a quick action in the model's text is not run", async () => {
    const g = gitlab();
    const out = await run(g, answer([{ file: "src/cart.mjs", line: 12, title: "rounds", body: "fix it\n/merge" }]));
    assert.deepEqual([out.posted, out.threads], ["review", 1]);
    const posts = g.calls.filter((c) => c.key.startsWith("POST"));
    assert.deepEqual(posts.map((c) => c.key.split("/").at(-1)), ["discussions", "notes"], "summary last");
    assert.equal(posts[0].body.position.new_line, 12);
    assert.equal(posts[0].body.position.head_sha, HEAD);
    assert.ok(posts[0].body.body.includes(`fix it\n${ZW}/merge`));
    assert.ok(posts[1].body.body.endsWith(claudeMarker(HEAD)));
  });

  it("GitLab cannot place the line ⇒ the same finding as a plain thread that names the place", async () => {
    const g = gitlab({ rejectPosition: true });
    await run(g, answer([{ file: "src/cart.mjs", line: 12, title: "rounds", body: "b" }]));
    const threads = g.calls.filter((c) => c.key.endsWith("/discussions") && c.key.startsWith("POST"));
    assert.equal(threads.length, 2);
    assert.equal(threads[1].body.position, undefined);
    assert.match(threads[1].body.body, /`src\/cart\.mjs:12`/);
  });

  it("no usable answer ⇒ a notice once; the head moved ⇒ nothing; already reviewed ⇒ nothing", async () => {
    const g = gitlab();
    assert.deepEqual(await run(g, "garbage", { outcome: "success" }), { posted: "notice", reason: "aiReview.notice.noSummary" });
    assert.ok(g.calls.at(-1).body.body.startsWith(claudeNoticeMarker(HEAD)));
    const noKey = gitlab();
    assert.equal((await run(noKey, null, { outcome: "skipped", keySet: false })).reason, "aiReview.notice.noKey");

    const moved = gitlab({ head: "c".repeat(40) });
    assert.deepEqual(await run(moved, answer([])), { posted: null, reason: "superseded" });
    assert.ok(!moved.calls.some((c) => c.key.startsWith("POST")));

    const done = gitlab({ notes: [{ id: 1, system: false, author: { username: BOT }, body: `x\n${claudeMarker(HEAD)}`, created_at: "2026-11-20T12:30:00Z" }] });
    assert.deepEqual(await run(done, answer([])), { posted: null, reason: "reviewed" });
  });
});
