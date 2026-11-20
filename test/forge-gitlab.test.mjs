// GitLab adapter: a merge request normalized into the shape the gate reads, and the writes the gate makes.
// Response shapes follow the GitLab REST v4 docs; the live check against a GitLab CE instance is milestone M6.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluate } from "../engine/core/gate.mjs";
import { approvedOn, createGitlab, diffCounts, noQuickActions, splitProject, targetChangedAt, threadsFrom, unifiedDiff } from "../engine/forge/gitlab.mjs";
import { reviewerOn } from "../engine/reviewer/index.mjs";
import { claudeMarker, claudeNoticeMarker } from "../engine/reviewer/claude.mjs";
import { policy } from "./helpers.mjs";

const HEAD = "b".repeat(40);
const OLDHEAD = "a".repeat(40);
const BOT = "project_42_bot_0123abcd";
const P = "/projects/grp%2Fsub%2Fapp";

/** A fake fetch: `METHOD path` (with or without the query) → handler; records calls. Handlers return `{ body, headers? }` or a body. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const full = `${method} ${u.pathname.replace(/^\/api\/v4/, "")}${u.search}`;
    const bare = `${method} ${u.pathname.replace(/^\/api\/v4/, "")}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key: full, body, token: init.headers?.["private-token"] });
    const route = routes[full] ?? routes[bare];
    if (!route) return new Response(JSON.stringify({ message: "404 Not found" }), { status: 404 });
    const out = await route(body, u);
    if (out instanceof Response) return out;
    const res = out && typeof out === "object" && "body" in out && "status" in out ? out : { status: 200, body: out };
    return new Response(res.body === undefined ? "" : JSON.stringify(res.body), { status: res.status, headers: res.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

const ENV = { CI_API_V4_URL: "https://gl.example/api/v4", CI_PROJECT_PATH: "grp/sub/app", DEV_PROCESS_TOKEN: "glpat-x", CI_JOB_URL: "https://gl.example/grp/sub/app/-/jobs/9" };

const mrJson = (over = {}) => ({
  iid: 7,
  state: "opened",
  title: "feat: x",
  author: { username: "alice" },
  sha: HEAD,
  target_branch: "main",
  source_project_id: 1,
  project_id: 1,
  draft: false,
  labels: ["risk:low"],
  reviewers: [{ username: "bob" }],
  ...over,
});

function mrRoutes({ mr = mrJson(), approvals = [], reviewers = [], notes = [], discussions = [], versions = [], statuses = [], diffs = [] } = {}) {
  return {
    "GET /user": () => ({ username: BOT }),
    [`GET ${P}/merge_requests/7`]: () => mr,
    [`GET ${P}/merge_requests/7/approvals`]: () => ({ approved_by: approvals }),
    [`GET ${P}/merge_requests/7/reviewers`]: () => reviewers,
    [`GET ${P}/merge_requests/7/notes`]: () => notes,
    [`GET ${P}/merge_requests/7/discussions`]: () => discussions,
    [`GET ${P}/merge_requests/7/versions`]: () => versions,
    [`GET ${P}/merge_requests/7/diffs`]: () => diffs,
    [`GET ${P}/repository/commits/${HEAD}/statuses`]: () => statuses,
  };
}

describe("GitLab helpers", () => {
  it("project paths nest; diffs are counted and rebuilt as git text", () => {
    assert.deepEqual(splitProject("grp/sub/app"), { owner: "grp/sub", name: "app" });
    assert.throws(() => splitProject("app"), /bad project path/);
    assert.deepEqual(diffCounts("@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n"), { additions: 2, deletions: 1 });
    const text = unifiedDiff({ old_path: "x.js", new_path: "y.js", renamed_file: true, diff: "@@ -1 +1 @@\n-a\n+b" });
    assert.equal(text, "diff --git a/x.js b/y.js\n--- a/x.js\n+++ b/y.js\n@@ -1 +1 @@\n-a\n+b\n");
    assert.match(unifiedDiff({ old_path: "n", new_path: "n", new_file: true, diff: "+1\n" }), /--- \/dev\/null\n\+\+\+ b\/n/);
  });

  it("an approval belongs to the head that was current when it was given; unknown time counts nowhere", () => {
    const versions = [
      { head_commit_sha: OLDHEAD, created_at: "2026-11-20T10:00:00Z" },
      { head_commit_sha: HEAD, created_at: "2026-11-20T12:00:00Z" },
    ];
    assert.equal(approvedOn("2026-11-20T11:00:00Z", versions), OLDHEAD);
    assert.equal(approvedOn("2026-11-20T12:30:00Z", versions), HEAD);
    assert.equal(approvedOn("2026-11-20T09:00:00Z", versions), null);
    assert.equal(approvedOn(undefined, versions), null);
  });

  it("the target-branch change time comes from GitLab's system note", () => {
    const notes = [
      { system: true, body: "changed target branch from `dev` to `main`", created_at: "2026-11-20T11:00:00Z" },
      { system: true, body: "added 1 commit", created_at: "2026-11-20T12:00:00Z" },
      { system: false, body: "changed target branch from a to b", created_at: "2026-11-20T13:00:00Z" },
    ];
    assert.equal(targetChangedAt(notes), "2026-11-20T11:00:00Z");
    assert.equal(targetChangedAt([]), null);
  });

  it("threads: resolvable discussions only; a DiffNote on an older head whose file left the diff is outdated", () => {
    const isBotLogin = (l) => l === BOT;
    const diffNote = (path, head) => ({ id: "d1", individual_note: false, notes: [{ author: { username: BOT }, body: "bug", resolvable: true, resolved: false, position: { new_path: path, new_line: 3, head_sha: head } }, { author: { username: "alice" }, body: "wrong: no", resolvable: true, resolved: false }] });
    const single = { id: "d2", individual_note: true, notes: [{ author: { username: "alice" }, body: "hi", resolvable: false }] };
    const out = threadsFrom([diffNote("src/a.js", HEAD), diffNote("src/gone.js", OLDHEAD), single], { headSha: HEAD, changedPaths: new Set(["src/a.js"]), isBotLogin });
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((t) => [t.path, t.line, t.isOutdated, t.isResolved]), [["src/a.js", 3, false, false], ["src/gone.js", 3, true, false]]);
    assert.deepEqual(out[0].comments.map((c) => [c.login, c.type]), [[BOT, "Bot"], ["alice", "User"]]);
  });
});

describe("GitLab adapter", () => {
  it("ready() learns the bot from the token; requests carry PRIVATE-TOKEN; pages follow x-next-page", async () => {
    const fetch = fakeFetch({
      "GET /user": () => ({ username: BOT }),
      [`GET ${P}/merge_requests?state=opened&per_page=100`]: () => ({ status: 200, body: [{ iid: 1, sha: OLDHEAD }], headers: { "x-next-page": "2" } }),
      [`GET ${P}/merge_requests?state=opened&per_page=100&page=2`]: () => [{ iid: 7, sha: HEAD }],
    });
    const forge = await createGitlab({ env: ENV, fetch }).ready();
    assert.equal(forge.ciIdentity, BOT);
    assert.equal(forge.repo, "grp/sub/app");
    assert.equal(await forge.findOpenPrByHead(HEAD), 7);
    assert.ok(fetch.calls.every((c) => c.token === "glpat-x"));
    assert.equal(forge.runUrl(), ENV.CI_JOB_URL);
    assert.throws(() => createGitlab({ env: { CI_PROJECT_PATH: "a/b" }, fetch }), /API URL unknown/);
  });

  it("loadChange: approvals on the current head only, requested changes, retarget time, notes, threads, statuses newest first", async () => {
    const fetch = fakeFetch(
      mrRoutes({
        approvals: [
          { user: { username: "bob" }, approved_at: "2026-11-20T12:30:00Z" },
          { user: { username: "carol" }, approved_at: "2026-11-20T11:00:00Z" },
        ],
        reviewers: [{ user: { username: "dave" }, state: "requested_changes" }, { user: { username: "erin" }, state: "reviewed" }],
        versions: [
          { head_commit_sha: HEAD, created_at: "2026-11-20T12:00:00Z" },
          { head_commit_sha: OLDHEAD, created_at: "2026-11-20T10:00:00Z" },
        ],
        notes: [
          { id: 1, system: true, body: "changed target branch from `dev` to `main`", created_at: "2026-11-20T11:30:00Z", author: { username: "alice" } },
          { id: 2, system: false, body: `/signoff ${HEAD.slice(0, 12)}`, created_at: "2026-11-20T12:40:00Z", author: { username: "alice" } },
          { id: 3, system: false, body: `ok\n${claudeMarker(HEAD)}`, created_at: "2026-11-20T12:35:00Z", author: { username: BOT } },
        ],
        statuses: [
          { id: 10, name: "risk-gate", status: "failed", description: "old", author: { username: BOT }, created_at: "2026-11-20T12:01:00Z" },
          { id: 11, name: "risk-gate", status: "success", description: "new", author: { username: BOT }, created_at: "2026-11-20T12:50:00Z" },
          { id: 12, name: "tests", status: "success", author: { username: "alice" }, created_at: "2026-11-20T12:20:00Z" },
        ],
        diffs: [
          { old_path: "src/a.js", new_path: "src/a.js", diff: "@@\n+x\n-y\n+z\n" },
          { old_path: "old.md", new_path: "docs/new.md", renamed_file: true, diff: "" },
        ],
      }),
    );
    const forge = await createGitlab({ env: ENV, fetch }).ready();
    const c = await forge.loadChange(7);
    assert.equal(c.number, 7);
    assert.equal(c.author, "alice");
    assert.equal(c.headSha, HEAD);
    assert.equal(c.baseRef, "main");
    assert.equal(c.fromFork, false);
    assert.deepEqual(c.labels, [{ name: "risk:low" }]);
    assert.deepEqual(c.files, [
      { filename: "src/a.js", additions: 2, deletions: 1 },
      { filename: "docs/new.md", previous_filename: "old.md", additions: 0, deletions: 0 },
    ]);
    assert.deepEqual(
      c.reviews.map((r) => [r.login, r.state, r.commitId]),
      [
        ["bob", "APPROVED", HEAD],
        ["carol", "APPROVED", OLDHEAD],
        ["dave", "CHANGES_REQUESTED", HEAD],
      ],
    );
    assert.equal(c.baseChangedAt, "2026-11-20T11:30:00Z");
    assert.deepEqual(c.comments.map((x) => [x.id, x.type]), [[2, "User"], [3, "Bot"]], "system notes are not comments; the bot is a bot");
    assert.deepEqual(c.statuses.map((s) => [s.context, s.state, s.description]), [["tests", "success", ""], ["risk-gate", "success", "new"], ["risk-gate", "failure", "old"]], "newest first");
    assert.equal(c.statuses.find((s) => s.context === "risk-gate").creator.login, BOT);
  });

  it("the gate reads a GitLab MR end to end: the bot's summary is the review, the author's sign-off counts, a stale approval does not", async () => {
    const versions = [
      { head_commit_sha: HEAD, created_at: "2026-11-20T12:00:00Z" },
      { head_commit_sha: OLDHEAD, created_at: "2026-11-20T10:00:00Z" },
    ];
    const notes = [
      { id: 3, system: false, body: `0 findings\n${claudeMarker(HEAD)}`, created_at: "2026-11-20T12:35:00Z", author: { username: BOT } },
      { id: 4, system: false, body: `/signoff ${HEAD.slice(0, 12)}`, created_at: "2026-11-20T12:40:00Z", author: { username: "alice" } },
    ];
    const fetch = fakeFetch(mrRoutes({ versions, notes, approvals: [{ user: { username: "carol" }, approved_at: "2026-11-20T11:00:00Z" }], diffs: [{ old_path: "src/a.js", new_path: "src/a.js", diff: "+x\n" }] }));
    const forge = await createGitlab({ env: ENV, fetch }).ready();
    const pol = { ...policy, forge: "gitlab", reviewer: "claude", aiReview: { ...policy.aiReview, accounts: [] }, trustedAuthors: ["alice"] };
    const reviewer = reviewerOn(pol, forge);
    assert.ok(reviewer.isReviewer(BOT));
    const data = await forge.loadChange(7);
    const r = evaluate({ policy: pol, reviewer, ...data, writers: new Set(["carol"]), pr: forge.prTerm });
    assert.equal(r.tier, "medium");
    assert.equal(r.aiReview.reviewedHead, true);
    assert.equal(r.signed, true);
    assert.equal(r.ok, true, JSON.stringify(r.missing));
    assert.deepEqual(r.staleApprovers, ["carol"], "approved before the latest push");

    // A notice from the bot is not a review.
    const n = await createGitlab({ env: ENV, fetch: fakeFetch(mrRoutes({ versions, notes: [{ id: 5, system: false, body: `${claudeNoticeMarker(HEAD)}\nno key`, created_at: "2026-11-20T12:35:00Z", author: { username: BOT } }] })) }).ready();
    const r2 = evaluate({ policy: pol, reviewer: reviewerOn(pol, n), ...(await n.loadChange(7)), writers: new Set(), pr: "MR" });
    assert.equal(r2.aiReview.reviewedHead, false);
    assert.equal(r2.aiReview.notice, "no key");
  });

  it("a fork MR is a fork; a missing approvals endpoint reads as no approvals", async () => {
    const routes = mrRoutes({ mr: mrJson({ source_project_id: 99 }) });
    routes[`GET ${P}/merge_requests/7/approvals`] = () => ({ status: 404, body: { message: "404 Not found" } });
    const forge = await createGitlab({ env: ENV, fetch: fakeFetch(routes) }).ready();
    const c = await forge.loadChange(7);
    assert.equal(c.fromFork, true);
    assert.deepEqual(c.reviews, []);
  });
});

describe("GitLab writes", () => {
  it("no quick action survives in what the bot writes: a line starting with / gets a zero-width space, code blocks stay verbatim", async () => {
    const zw = "\u200b";
    assert.equal(noQuickActions("ok\n/merge\n  /approve now\nmid /label ~x"), `ok\n${zw}/merge\n  ${zw}/approve now\nmid /label ~x`);
    assert.equal(noQuickActions("```\n/close\n```\n/after"), `\`\`\`\n/close\n\`\`\`\n${zw}/after`);
    assert.equal(noQuickActions("~~~~\n/x\n~~~~"), "~~~~\n/x\n~~~~");
    const fetch = fakeFetch({ [`POST ${P}/merge_requests/7/notes`]: (b) => ({ id: 1, ...b }), [`POST ${P}/issues`]: () => ({ iid: 2 }) });
    const forge = createGitlab({ env: ENV, fetch });
    await forge.postComment(7, "found it\n/merge");
    await forge.issues.create({ title: "t", labels: [], body: "/close" });
    assert.deepEqual(fetch.calls.map((c) => c.body.body ?? c.body.description), [`found it\n${zw}/merge`, `${zw}/close`]);
  });

  it("setStatus maps states, trims the description, and treats 'cannot transition' (same state) as done", async () => {
    let refuse = false;
    const fetch = fakeFetch({
      [`POST ${P}/statuses/${HEAD}`]: () => (refuse ? { status: 400, body: { message: "Cannot transition status via :enqueue from :pending (Reason(s): Status cannot transition via \"enqueue\")" } } : { id: 1 }),
    });
    const forge = createGitlab({ env: ENV, fetch });
    await forge.setStatus(HEAD, "risk-gate", "failure", "x".repeat(400), "https://u");
    assert.deepEqual(fetch.calls[0].body, { state: "failed", name: "risk-gate", description: "x".repeat(250), target_url: "https://u" });
    refuse = true;
    await forge.setStatus(HEAD, "risk-gate", "pending", "again");
    const other = createGitlab({ env: ENV, fetch: fakeFetch({ [`POST ${P}/statuses/${HEAD}`]: () => ({ status: 403, body: { message: "403 Forbidden" } }) }) });
    await assert.rejects(other.setStatus(HEAD, "risk-gate", "success", "d"), /403/);
  });

  it("the sticky note is the bot's own; risk labels are swapped in one update", async () => {
    const notes = [
      { id: 1, system: false, author: { username: "mallory" }, body: "<!-- risk-gate -->\nfake" },
      { id: 2, system: false, author: { username: BOT }, body: "<!-- risk-gate -->\nold" },
    ];
    const fetch = fakeFetch({
      "GET /user": () => ({ username: BOT }),
      [`GET ${P}/merge_requests/7/notes`]: () => notes,
      [`PUT ${P}/merge_requests/7/notes/2`]: (b) => ({ id: 2, ...b }),
      [`POST ${P}/labels`]: () => ({ status: 409, body: { message: "Label already exists" } }),
      [`PUT ${P}/merge_requests/7`]: (b) => b,
    });
    const forge = await createGitlab({ env: ENV, fetch }).ready();
    assert.equal(await forge.upsertMarkedComment(7, "<!-- risk-gate -->", "new"), 2);
    assert.deepEqual(fetch.calls.find((c) => c.key.startsWith("PUT")).body, { body: "<!-- risk-gate -->\nnew" });
    await forge.syncRiskLabel(7, "high", [{ name: "risk:low" }, { name: "bug" }]);
    assert.deepEqual(fetch.calls.at(-1).body, { add_labels: "risk:high", remove_labels: "risk:low" });
    const before = fetch.calls.length;
    await forge.syncRiskLabel(7, "high", [{ name: "risk:high" }]);
    assert.equal(fetch.calls.length, before, "already right: no calls");
  });

  it("write access is Developer or higher (inherited memberships included); unknown users have none", async () => {
    const fetch = fakeFetch({
      "GET /users": (_, u) => (u.searchParams.get("username") === "dev" ? [{ id: 5 }] : u.searchParams.get("username") === "guest" ? [{ id: 6 }] : []),
      [`GET ${P}/members/all/5`]: () => ({ access_level: 30 }),
      [`GET ${P}/members/all/6`]: () => ({ access_level: 10 }),
    });
    const forge = createGitlab({ env: ENV, fetch });
    assert.equal(await forge.hasWriteAccess("dev"), true);
    assert.equal(await forge.hasWriteAccess("guest"), false);
    assert.equal(await forge.hasWriteAccess("nobody"), false);
  });

  it("issues: iid as the number, description as the body, labels as a comma list", async () => {
    const fetch = fakeFetch({
      [`GET ${P}/issues`]: (_, u) => (u.searchParams.get("state") === "opened" ? [{ iid: 3, title: "t", description: "d", state: "opened" }] : []),
      [`POST ${P}/issues`]: () => ({ iid: 4 }),
      [`PUT ${P}/issues/3`]: (b) => b,
      [`POST ${P}/labels`]: () => ({ id: 1 }),
    });
    const forge = createGitlab({ env: ENV, fetch });
    assert.deepEqual(await forge.issues.newestOpen("ai-eval"), { number: 3, title: "t", body: "d", state: "open" });
    assert.equal(await forge.issues.create({ title: "x", labels: ["a", "b"], body: "y" }), 4);
    assert.deepEqual(fetch.calls.at(-1).body, { title: "x", labels: "a,b", description: "y" });
    await forge.issues.ensureLabel("ai-eval", "1d76db");
    assert.deepEqual(fetch.calls.at(-1).body, { name: "ai-eval", color: "#1d76db" });
  });
});

describe("GitLab merge queue (mode self)", async () => {
  const { runQueue } = await import("../engine/cli/merge-queue.mjs");
  const { judgeChange } = await import("../engine/cli/risk-gate.mjs");
  const { reviewerOn: on } = await import("../engine/reviewer/index.mjs");
  const BASE = "c".repeat(40);
  const MERGEREF = "d".repeat(40);
  const MERGED = "e".repeat(40);

  function world({ conflict = false, ci = "success", moved = false } = {}) {
    const branches = new Map([["main", BASE]]);
    const statuses = new Map(); // sha → [{ id, name, status, author }]
    let nextId = 100;
    const addStatus = (sha, name, status, author = "alice", description = "") => {
      const list = statuses.get(sha) ?? [];
      list.push({ id: nextId++, name, status, description, author: { username: author }, created_at: new Date(2026, 10, 20, 12, nextId).toISOString() });
      statuses.set(sha, list);
    };
    addStatus(HEAD, "checks", "success");
    addStatus(HEAD, "tests", "success");
    const mrBody = mrJson({ labels: ["merge-queue"], has_conflicts: false });
    const routes = mrRoutes({
      mr: mrBody,
      versions: [{ head_commit_sha: HEAD, created_at: "2026-11-20T12:00:00Z" }],
      notes: [
        { id: 3, system: false, body: `0 findings\n${claudeMarker(HEAD)}`, created_at: "2026-11-20T12:35:00Z", author: { username: BOT } },
        { id: 4, system: false, body: `/signoff ${HEAD.slice(0, 12)}`, created_at: "2026-11-20T12:40:00Z", author: { username: "alice" } },
      ],
      diffs: [{ old_path: "src/a.js", new_path: "src/a.js", diff: "+x\n" }],
    });
    Object.assign(routes, {
      [`GET ${P}`]: () => ({ default_branch: "main" }),
      [`GET ${P}/merge_requests`]: () => [mrBody],
      [`GET ${P}/repository/commits/${HEAD}/statuses`]: () => statuses.get(HEAD) ?? [],
      [`POST ${P}/statuses/${HEAD}`]: (b) => (addStatus(HEAD, b.name, b.state, BOT, b.description), { id: nextId }),
      [`GET ${P}/repository/branches/main`]: () => ({ commit: { id: branches.get("main") } }),
      [`DELETE ${P}/repository/branches/merge-queue%2Fpr-7`]: () => (branches.delete("merge-queue/pr-7"), { status: 204, body: undefined }),
      [`POST ${P}/repository/branches`]: (_, u) => (branches.set(u.searchParams.get("branch"), u.searchParams.get("ref")), { name: u.searchParams.get("branch") }),
      [`GET ${P}/merge_requests/7/merge_ref`]: () => (conflict ? { status: 400, body: { message: "Merge request is not mergeable" } } : { commit_id: MERGEREF }),
      [`GET ${P}/repository/commits/${MERGEREF}`]: () => ({ id: MERGEREF, parent_ids: [BASE, HEAD] }),
      [`GET ${P}/repository/commits/${MERGED}`]: () => ({ id: MERGED, parent_ids: [BASE, HEAD] }),
      [`POST ${P}/pipeline`]: (b) => {
        if (moved && b.ref !== "main") branches.set("main", "f".repeat(40));
        return { id: 55, sha: b.ref === "main" ? branches.get("main") : MERGEREF, status: "created", web_url: "https://gl/p/55" };
      },
      [`GET ${P}/pipelines/55`]: () => ({ id: 55, status: ci, web_url: "https://gl/p/55" }),
      [`PUT ${P}/merge_requests/7/merge`]: () => ({ merge_commit_sha: MERGED, state: "merged" }),
      [`PUT ${P}/merge_requests/7`]: (b) => b,
      [`POST ${P}/merge_requests/7/notes`]: (b) => ({ id: 9, ...b }),
      [`POST ${P}/labels`]: (b) => ({ id: 1, ...b }),
    });
    return { fetch: fakeFetch(routes), branches, statuses };
  }
  const pol = { ...policy, forge: "gitlab", reviewer: "claude", trustedAuthors: ["alice"], aiReview: { ...policy.aiReview, accounts: [] }, names: { ...policy.names, ciWorkflow: "ci", gateWorkflow: "risk-gate", queueWorkflow: "merge-queue" } };
  const run = async (w) => {
    const forge = await createGitlab({ env: ENV, fetch: w.fetch }).ready();
    // The gate runs first (as on the MR's events) and writes its status, label and note.
    await judgeChange({ forge, policy: pol, reviewer: on(pol, forge), number: 7, env: {}, log: () => {} });
    let clock = Date.parse("2026-11-20T13:00:00Z");
    const out = await runQueue({ forge, policy: pol, reviewer: on(pol, forge), env: {}, log: () => {}, sleep: async (ms) => void (clock += ms), now: () => clock });
    return { out, calls: w.fetch.calls };
  };

  it("green: the candidate is GitLab's own merge on the tested base, CI runs on it as the 'ci' task, then the MR merges at its head", async () => {
    const w = world();
    const { out, calls } = await run(w);
    assert.deepEqual(out.results.map((r) => [r.number, r.outcome]), [[7, "merged"]]);
    const pipeline = calls.find((c) => c.key === `POST ${P}/pipeline`).body;
    assert.deepEqual(pipeline, { ref: "merge-queue/pr-7", variables: [{ key: "DEV_PROCESS_TASK", value: "ci" }, { key: "DEV_PROCESS_PR", value: "7" }, { key: "DEV_PROCESS_BASE", value: BASE }] });
    const merge = calls.find((c) => c.key === `PUT ${P}/merge_requests/7/merge`).body;
    assert.equal(merge.sha, HEAD);
    assert.equal(merge.squash, false);
    assert.match(merge.merge_commit_message, /^feat: 合并 MR !7 x\n/, "an MR is !7 on GitLab (#7 is an issue)");
    assert.ok(!w.branches.has("merge-queue/pr-7"), "the candidate branch is deleted");
    const queueStatus = w.statuses.get(HEAD).filter((s) => s.name === "merge-queue").map((s) => s.status);
    assert.deepEqual(queueStatus, ["pending", "success"]);
  });

  it("GitLab cannot compute the merge ⇒ ejected as a conflict; red CI ⇒ ejected", async () => {
    const c = await run(world({ conflict: true }));
    assert.equal(c.out.results[0].outcome, "ejected");
    assert.ok(c.calls.some((x) => x.key === `PUT ${P}/merge_requests/7` && x.body.remove_labels === "merge-queue"));
    const r = await run(world({ ci: "failed" }));
    assert.equal(r.out.results[0].outcome, "ejected");
    assert.ok(!r.calls.some((x) => x.key === `PUT ${P}/merge_requests/7/merge`));
  });

  it("the target branch moved during CI ⇒ not merged, retried by another run", async () => {
    const { out, calls } = await run(world({ moved: true }));
    assert.equal(out.results[0].outcome, "retry");
    assert.ok(!calls.some((x) => x.key === `PUT ${P}/merge_requests/7/merge`));
  });
});
