// Weekly review metrics (ported from the reference implementation's reviewMetrics tests) and the CLI's I/O against a
// fake fetch (createGithub): search paging, the merged-in-window filter, merge-commit waivers, publishing the report.
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { collectMetrics, definitionsPath, publishReport } from "../engine/cli/metrics.mjs";
import { WAIVER_TRAILER } from "../engine/core/gate.mjs";
import { aggregate, percentile, prMetrics, renderReport, threadOutcome, tierOf, UNTIERED } from "../engine/core/metrics.mjs";
import { createGithub, searchAll } from "../engine/forge/github.mjs";
import { copilot } from "../engine/reviewer/copilot.mjs";
import { AUTHOR, policy } from "./helpers.mjs";

const en = { ...policy, language: "en" };
const TAGS = policy.threadReplyTags;
const aiThread = (replies = [], isOutdated = false) => ({
  isOutdated,
  comments: [{ login: "Copilot", type: "Bot", body: "possible null deref" }, ...replies.map((r) => ({ type: "User", ...r }))],
});
const outcome = (thread, tags = TAGS) => threadOutcome(thread, tags, copilot);
const report = (a, lang = "zh", ai = copilot.displayName) => renderReport(a, { since: "2026-11-11", until: "2026-11-18", lang, ai, pr: "PR" });

describe("percentile", () => {
  it("nearest rank; empty arrays and non-numbers are ignored", () => {
    assert.equal(percentile([3, 1, 2], 50), 2);
    assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
    assert.equal(percentile([null, 5], 50), 5);
    assert.equal(percentile([], 50), null);
  });
});

describe("what became of the AI reviewer's comments", () => {
  it("a tagged human reply first, then the code moved (outdated), else unanswered", () => {
    assert.equal(outcome(aiThread([{ login: AUTHOR, body: "wrong：it cannot be null here" }])), "wrong"); // full-width colon
    assert.equal(outcome(aiThread([{ login: AUTHOR, body: "Intended: on purpose" }], true)), "intended");
    assert.equal(outcome(aiThread([], true)), "outdated");
    assert.equal(outcome(aiThread([{ login: AUTHOR, body: "ok" }])), "unanswered");
    assert.equal(outcome({ comments: [{ login: "carol", type: "User", body: "a thread a human opened" }] }), null);
  });

  it("the last tagged human reply wins: wrong then fixed ⇒ fixed, and the other way round ⇒ wrong", () => {
    assert.equal(
      outcome(aiThread([{ login: AUTHOR, body: "wrong: cannot be null" }, { login: "carol", body: "it can, look at the caller" }, { login: AUTHOR, body: "fixed: added a guard" }])),
      "fixed",
    );
    assert.equal(outcome(aiThread([{ login: AUTHOR, body: "fixed: changed it" }, { login: AUTHOR, body: "wrong: reverted, it was right" }])), "wrong");
    // a bot's reply does not correct anything
    assert.equal(outcome(aiThread([{ login: AUTHOR, body: "fixed: changed it" }, { login: "github-actions[bot]", type: "Bot", body: "wrong: x" }])), "fixed");
  });

  it("reply tags come from the policy: a new tag counts as an outcome", () => {
    const th = { isOutdated: false, comments: [{ login: "Copilot", type: "Bot", body: "x" }, { login: AUTHOR, type: "User", body: "dup: same as above" }] };
    assert.equal(threadOutcome(th, ["fixed:", "dup:"], copilot), "dup");
    assert.equal(threadOutcome(th, ["fixed:"], copilot), "unanswered");
  });

  it("which threads are the AI's comes from the reviewer adapter, not from a fixed login", () => {
    const other = { isReviewer: (l) => l === "review-bot", aiReviews: () => [] };
    const th = (login) => ({ isOutdated: true, comments: [{ login, type: "Bot", body: "x" }] });
    assert.equal(threadOutcome(th("review-bot"), TAGS, other), "outdated");
    assert.equal(threadOutcome(th("Copilot"), TAGS, other), null);
  });
});

describe("one PR and the aggregate", () => {
  const COPILOT = "copilot-pull-request-reviewer[bot]";
  const pr = (over = {}) =>
    prMetrics({
      policy,
      reviewer: copilot,
      author: AUTHOR,
      createdAt: "2026-11-10T00:00:00Z",
      mergedAt: "2026-11-10T06:00:00Z",
      reviews: [
        { login: "carol", type: "User", state: "APPROVED", submittedAt: "2026-11-10T02:00:00Z" },
        { login: COPILOT, type: "Bot", state: "COMMENTED", submittedAt: "2026-11-10T00:10:00Z", body: "<!-- ccr-overview-v2 -->\noverview" },
        { login: AUTHOR, type: "User", state: "COMMENTED", submittedAt: "2026-11-10T00:20:00Z" },
      ],
      comments: [
        { login: AUTHOR, type: "User", body: "/signoff abcdef1" },
        { login: "bob", type: "User", body: "why is this done this way" },
      ],
      threads: [aiThread([{ login: AUTHOR, body: "fixed: changed it" }])],
      labels: [{ name: "risk:high" }],
      ...over,
    });

  it("approvals and comments from others, durations, AI rounds and tier; the author and bots don't count", () => {
    const m = pr();
    assert.equal(m.approvals, 1);
    assert.equal(m.humanComments, 1);
    assert.equal(m.leadHours, 6);
    assert.equal(m.approvalWaitHours, 2);
    assert.equal(m.aiRounds, 1);
    assert.deepEqual(m.outcomes, ["fixed"]);
    assert.equal(m.tier, "high");
  });

  it("an inline comment counts once: GitHub's empty-body COMMENTED review is not counted again; reviews with a body are", () => {
    const m = pr({
      comments: [],
      reviews: [
        { login: "carol", type: "User", state: "COMMENTED", submittedAt: "2026-11-10T01:00:00Z", body: "" },
        { login: "bob", type: "User", state: "COMMENTED", submittedAt: "2026-11-10T01:00:00Z", body: "read it all, two points" },
      ],
      threads: [{ isOutdated: false, comments: [{ login: "carol", type: "User", body: "needs a null check" }] }],
    });
    assert.equal(m.humanComments, 2);
  });

  it("AI rounds count real reviews only: a quota notice is not a round", () => {
    const notice = {
      login: COPILOT,
      type: "Bot",
      state: "COMMENTED",
      submittedAt: "2026-11-10T03:00:00Z",
      body: "Copilot was unable to review this pull request because the user who requested the review has insufficient remaining quota.",
    };
    assert.equal(pr().aiRounds, 1);
    assert.equal(pr({ reviews: [notice] }).aiRounds, 0);
  });

  it("a waiver trailer in the merge commit ⇒ one AI review waiver, shown in the report", () => {
    const waived = pr({ mergeMessage: `Merge pull request #12\n\nCI re-run on main@07c3c3f passed: u\n\n${WAIVER_TRAILER} \`carol\` at t via /waive-ai-review` });
    assert.equal(waived.waived, true);
    assert.equal(pr().waived, false);
    // only a trailer at the start of a line counts; mentioning it in the text does not
    assert.equal(pr({ mergeMessage: `CI passed (this PR fixes how ${WAIVER_TRAILER} is written)` }).waived, false);
    const a = aggregate([pr(), waived]);
    assert.equal(a.waived, 1);
    assert.ok(report(a).includes("**AI 评审豁免**：1 个 PR"));
    assert.ok(report(a, "en").includes("**AI review waivers**: 1 PR(s) did not wait for a Copilot review"));
  });

  it("the tier comes from the policy's label prefix; no label ⇒ untiered", () => {
    assert.equal(tierOf([{ name: "tier/medium" }, "bug"], "tier/"), "medium");
    assert.equal(tierOf(["risk:low"], "risk:"), "low");
    assert.equal(tierOf([{ name: "risk:low" }], "tier/"), UNTIERED);
    const custom = { ...policy, names: { ...policy.names, riskLabelPrefix: "tier/" } };
    assert.equal(pr({ policy: custom, labels: [{ name: "tier/low" }] }).tier, "low");
  });

  it("aggregate: share merged without others, false positives = wrong ÷ with an outcome; the report has the guardrails", () => {
    const solo = pr({ reviews: [], labels: [], threads: [aiThread([{ login: AUTHOR, body: "wrong: false alarm" }])] });
    const a = aggregate([pr(), solo], { reverts: 1, fixPrs: 2 });
    assert.equal(a.prs, 2);
    assert.equal(a.zeroHumanShare, 0.5);
    assert.equal(a.falsePositiveRate, 0.5);
    assert.deepEqual(a.tiers, { high: 1, [UNTIERED]: 1 });
    assert.deepEqual(a.aiRounds, { p50: 0, p95: 1 }); // nearest rank over [0, 1]

    const zh = report(a);
    assert.ok(zh.startsWith("## 评审指标 2026-11-11 ～ 2026-11-18"));
    assert.ok(zh.includes("没有他人批准就合入的占 50%"));
    assert.ok(zh.includes("回滚提交 1 个，修复类 PR 2 个"));
    assert.ok(zh.includes("**分档**：high 1，未分档 1"));
    assert.ok(zh.includes("**Copilot 意见去向**：fixed 1，wrong 1；误报率（wrong ÷ 有去向）50%"));
    assert.ok(zh.includes("| 开 PR → 合入 | 6 小时 | 6 小时 |"));
    assert.ok(zh.includes("| Copilot 评审轮数 / PR | 0 | 1 |"));

    const e = report(a, "en");
    assert.ok(e.startsWith("## Review metrics 2026-11-11 – 2026-11-18"));
    assert.ok(e.includes("2 PR(s) merged; 50% of them without an approval from someone other than the author."));
    assert.ok(e.includes("**Tiers**: high 1, untiered 1"));
    assert.ok(e.includes("false-positive rate (wrong ÷ with an outcome) 50%"));
    assert.ok(e.includes("| PR opened → merged | 6 h | 6 h |"));
    assert.ok(e.includes("**Guardrails**: 1 revert commit(s), 2 fix PR(s)."));
  });

  it("the AI reviewer's name and rounds come from the adapter", () => {
    const other = {
      displayName: "ReviewBot",
      isReviewer: (l) => l === "review-bot",
      aiReviews: ({ comments }) => comments.filter((c) => c.login === "review-bot").map((c) => ({ login: c.login, body: c.body, real: c.body.startsWith("review") })),
    };
    const m = pr({ reviewer: other, comments: [{ login: "review-bot", type: "Bot", body: "review: ok" }, { login: "review-bot", type: "Bot", body: "quota" }], threads: [] });
    assert.equal(m.aiRounds, 1);
    assert.equal(m.humanComments, 0);
    const md = report(aggregate([m]), "en", other.displayName);
    assert.ok(md.includes("| ReviewBot review rounds / PR | 1 | 1 |"));
    assert.ok(md.includes("**What became of ReviewBot comments**: —"));
  });

  it("no PRs at all: the report still renders", () => {
    const zh = report(aggregate([]));
    assert.ok(zh.includes("合入 0 个 PR"));
    assert.ok(zh.includes("| 他人批准数 / PR | — | — |"));
    assert.ok(report(aggregate([]), "en").includes("0 PR(s) merged; — of them"));
  });
});

/** A fake fetch: routes `METHOD path` (with or without the query) to handlers; records calls. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key: `${method} ${u.pathname}${u.search}`, body });
    const h = routes[`${method} ${u.pathname}${u.search}`] ?? routes[`${method} ${u.pathname}`];
    if (!h) return new Response(JSON.stringify({ message: `no route ${method} ${u.pathname}${u.search}` }), { status: 404 });
    const out = typeof h === "function" ? h(body, u) : h;
    return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200, headers: out.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

const ENV = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" };
const NOW = new Date("2026-11-20T00:00:00Z"); // window: 2026-11-13T00:00Z … now

describe("collectMetrics (fake GitHub)", () => {
  const user = (login, type = "User") => ({ login, type });
  const pull = (number, over = {}) => ({
    number,
    title: `feat: change ${number}`,
    user: user(AUTHOR),
    created_at: "2026-11-14T00:00:00Z",
    merged_at: "2026-11-14T04:00:00Z",
    merge_commit_sha: `m${number}`,
    labels: [{ name: "risk:medium" }],
    ...over,
  });
  const PULLS = {
    1: pull(1, { labels: [{ name: "risk:high" }] }),
    2: pull(2, { title: "fix: off by one", labels: [] }),
    3: pull(3, { merged_at: "2026-11-12T23:00:00Z" }), // found by the day-level search, merged before the window
    4: pull(4, { merge_commit_sha: "old4" }), // merge commit not among the fetched commits
  };
  const emptyThreads = { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } };
  const threadsOf = (pr) =>
    pr === 1
      ? {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "T1",
                      isResolved: true,
                      isOutdated: false,
                      path: "src/a.ts",
                      line: 1,
                      comments: {
                        pageInfo: { hasNextPage: false },
                        nodes: [
                          { author: { login: "Copilot", __typename: "Bot" }, body: "bug", url: "u1" },
                          { author: { login: AUTHOR, __typename: "User" }, body: "wrong: not a bug", url: "u2" },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        }
      : emptyThreads;

  function routes(over = {}) {
    const searchPages = [];
    return {
      searchPages,
      "GET /repos/o/r": { default_branch: "trunk" },
      "GET /search/issues": (_, u) => {
        const page = Number(u.searchParams.get("page"));
        searchPages.push({ page, q: u.searchParams.get("q") });
        // total 4, served 3 + 1 to exercise paging
        return page === 1 ? { total_count: 4, items: [{ number: 1 }, { number: 2 }, { number: 3 }] } : { total_count: 4, items: [{ number: 4 }] };
      },
      "GET /repos/o/r/pulls/1": PULLS[1],
      "GET /repos/o/r/pulls/2": PULLS[2],
      "GET /repos/o/r/pulls/3": PULLS[3],
      "GET /repos/o/r/pulls/4": PULLS[4],
      "GET /repos/o/r/commits": (_, u) =>
        u.searchParams.get("page") === "2"
          ? [
              { sha: "m2", commit: { message: "fix: off by one" } },
              { sha: "r1", commit: { message: 'Revert "feat: change 9"' } },
            ]
          : {
              body: [
                { sha: "m1", commit: { message: `feat: change 1\n\n${WAIVER_TRAILER} \`carol\` via /waive-ai-review` } },
                { sha: "x", commit: { message: "chore: bump" } },
              ],
              headers: { link: `<https://api.github.com/repos/o/r/commits?sha=trunk&since=x&per_page=100&page=2>; rel="next"` },
            },
      "GET /repos/o/r/commits/old4": { commit: { message: "feat: change 4" } },
      "GET /repos/o/r/pulls/1/reviews": [
        { user: user("copilot-pull-request-reviewer[bot]", "Bot"), state: "COMMENTED", submitted_at: "2026-11-14T00:30:00Z", body: "<!-- ccr-overview-v2 -->", commit_id: "h" },
        { user: user("bob"), state: "APPROVED", submitted_at: "2026-11-14T01:00:00Z", body: "", commit_id: "h" },
      ],
      "GET /repos/o/r/pulls/2/reviews": [],
      "GET /repos/o/r/pulls/4/reviews": [{ user: user("carol"), state: "APPROVED", submitted_at: "2026-11-14T03:00:00Z", body: "lgtm", commit_id: "h" }],
      "GET /repos/o/r/issues/1/comments": [{ user: user("carol"), body: "question", created_at: "c" }],
      "GET /repos/o/r/issues/2/comments": [],
      "GET /repos/o/r/issues/4/comments": [],
      "POST /graphql": (body) => threadsOf(body.variables.pr),
      ...over,
    };
  }

  it("collects a week of merged PRs (paged search and commits), filters to the window and renders the report", async () => {
    const r = routes();
    const fetch = fakeFetch(r);
    const forge = createGithub({ env: ENV, fetch });
    const out = await collectMetrics({ forge, policy, reviewer: copilot, days: 7, now: NOW });

    assert.deepEqual(
      r.searchPages.map((p) => p.page),
      [1, 2],
    );
    assert.equal(r.searchPages[0].q, "repo:o/r is:pr is:merged base:trunk merged:>=2026-11-13"); // the default branch, not a fixed name
    assert.ok(fetch.calls.some((c) => c.key === "GET /repos/o/r/commits?sha=trunk&since=2026-11-13T00:00:00.000Z&per_page=100"));
    assert.ok(!fetch.calls.some((c) => c.key.startsWith("GET /repos/o/r/pulls/3/")), "PR 3 was merged before the window");
    assert.ok(fetch.calls.some((c) => c.key === "GET /repos/o/r/commits/old4"), "a merge commit outside the list is fetched");

    assert.equal(out.since, "2026-11-13");
    assert.equal(out.until, "2026-11-20");
    const a = out.aggregate;
    assert.equal(a.prs, 3);
    assert.equal(a.waived, 1);
    assert.equal(a.reverts, 1);
    assert.equal(a.fixPrs, 1);
    assert.deepEqual(a.tiers, { high: 1, [UNTIERED]: 1, medium: 1 });
    assert.deepEqual(a.outcomes, { wrong: 1 });
    assert.equal(a.zeroHumanShare, 1 / 3);
    assert.deepEqual(
      out.list.map((m) => [m.approvals, m.humanComments, m.aiRounds, m.waived]),
      [
        [1, 1, 1, true],
        [0, 0, 0, false],
        [1, 1, 0, false],
      ],
    );
    assert.ok(out.body.includes("## 评审指标 2026-11-13 ～ 2026-11-20"));
    assert.ok(out.body.includes("合入 3 个 PR；没有他人批准就合入的占 33%。"));
    assert.ok(out.body.includes("回滚提交 1 个，修复类 PR 1 个"));

    const enOut = await collectMetrics({ forge: createGithub({ env: ENV, fetch: fakeFetch(routes()) }), policy: en, reviewer: copilot, now: NOW });
    assert.ok(enOut.body.includes("**AI review waivers**: 1 PR(s)"));
  });

  it("revert and fix detection follow the policy's patterns", async () => {
    const custom = { ...policy, patterns: { revert: "^undo", fix: "^bugfix" } };
    const out = await collectMetrics({ forge: createGithub({ env: ENV, fetch: fakeFetch(routes()) }), policy: custom, reviewer: copilot, now: NOW });
    assert.equal(out.aggregate.reverts, 0);
    assert.equal(out.aggregate.fixPrs, 0);
  });

  it("a merge commit that cannot be fetched fails the report instead of counting as not waived", async () => {
    const fetch = fakeFetch(routes({ "GET /repos/o/r/commits/old4": { status: 500, body: { message: "boom" } } }));
    await assert.rejects(collectMetrics({ forge: createGithub({ env: ENV, fetch }), policy, reviewer: copilot, now: NOW }), /500/);
  });

  it("searchAll stops at total_count or an empty page, and at most 10 pages", async () => {
    const seen = [];
    const rest = { get: async (url) => (seen.push(new URL(url, "https://x").searchParams.get("page")), { total_count: 5000, items: [{ number: seen.length }] }) };
    assert.equal((await searchAll(rest, "q")).length, 10);
    assert.equal(seen.length, 10);
    const empty = { get: async () => ({ total_count: 3, items: [] }) };
    assert.deepEqual(await searchAll(empty, "q"), []);
  });
});

describe("publishReport (fake GitHub)", () => {
  it("appends to the open labelled issue when there is one", async () => {
    const fetch = fakeFetch({
      "GET /repos/o/r/issues": (_, u) => (u.searchParams.get("labels") === "review-metrics" ? [{ number: 42 }] : []),
      "POST /repos/o/r/issues/42/comments": { id: 1 },
    });
    const n = await publishReport({ forge: createGithub({ env: ENV, fetch }), policy, body: "report", doc: "d" });
    assert.equal(n, 42);
    assert.deepEqual(fetch.calls.at(-1), { key: "POST /repos/o/r/issues/42/comments", body: { body: "report" } });
    assert.equal(fetch.calls.length, 2);
  });

  it("otherwise creates the label (an existing label is fine) and the issue in the project's language, then comments", async () => {
    for (const [p, title] of [
      [policy, "评审指标周报"],
      [en, "Weekly review metrics"],
    ]) {
      const fetch = fakeFetch({
        "GET /repos/o/r/issues": [],
        "POST /repos/o/r/labels": { status: 422, body: { message: "already_exists" } },
        "POST /repos/o/r/issues": { number: 7 },
        "POST /repos/o/r/issues/7/comments": { id: 1 },
      });
      const n = await publishReport({ forge: createGithub({ env: ENV, fetch }), policy: p, body: "report", doc: ".dev-process/engine/core/metrics.mjs" });
      assert.equal(n, 7);
      const created = fetch.calls.find((c) => c.key === "POST /repos/o/r/issues").body;
      assert.equal(created.title, title);
      assert.deepEqual(created.labels, ["review-metrics"]);
      assert.ok(created.body.includes("`.dev-process/engine/core/metrics.mjs`"));
      assert.deepEqual(fetch.calls.find((c) => c.key === "POST /repos/o/r/labels").body, { name: "review-metrics", color: "5319e7" });
    }
  });

  it("the label comes from the policy", async () => {
    const fetch = fakeFetch({ "GET /repos/o/r/issues": (_, u) => (u.searchParams.get("labels") === "metrics:weekly" ? [{ number: 3 }] : []), "POST /repos/o/r/issues/3/comments": {} });
    const custom = { ...policy, names: { ...policy.names, metricsLabel: "metrics:weekly" } };
    assert.equal(await publishReport({ forge: createGithub({ env: ENV, fetch }), policy: custom, body: "x", doc: "d" }), 3);
  });
});

describe("definitionsPath", () => {
  it("is relative to the repository root, with a fallback when the engine lives elsewhere", () => {
    const repo = fileURLToPath(new URL("../", import.meta.url));
    assert.equal(definitionsPath(repo), "engine/core/metrics.mjs");
    assert.equal(definitionsPath(join(repo, "..")), `${basename(repo)}/engine/core/metrics.mjs`);
    assert.equal(definitionsPath("/somewhere/else"), "engine/core/metrics.mjs");
  });
});
