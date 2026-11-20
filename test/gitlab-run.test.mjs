// The bot pipeline's entry on GitLab: which pipelines it acts in, what an event or the poll makes it do.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { botPipeline, runBot, whatToDo } from "../engine/cli/gitlab-run.mjs";
import { claudeMarker, claudeNoticeMarker } from "../engine/reviewer/claude.mjs";
import { reviewerOn } from "../engine/reviewer/index.mjs";
import { policy } from "./helpers.mjs";

const BOT = "project_42_bot_0123abcd";
const HEAD = "b".repeat(40);
const ENV = { CI_PIPELINE_SOURCE: "trigger", CI_DEFAULT_BRANCH: "main", CI_COMMIT_BRANCH: "main", TRIGGER_PAYLOAD: "/tmp/payload.json" };
const pol = { ...policy, forge: "gitlab", reviewer: "claude", aiReview: { ...policy.aiReview, accounts: [] }, names: { ...policy.names, gateWorkflow: "risk-gate", queueWorkflow: "merge-queue", aiReviewWorkflow: "ai-review", ciWorkflow: "ci" } };

describe("which pipelines the bot acts in", () => {
  it("trigger / schedule / api / web on the default branch only; never a pipeline a job token started", () => {
    assert.equal(botPipeline(ENV).ok, true);
    for (const src of ["schedule", "api", "web"]) assert.equal(botPipeline({ ...ENV, CI_PIPELINE_SOURCE: src }).ok, true, src);
    assert.match(botPipeline({ ...ENV, CI_PIPELINE_SOURCE: "pipeline" }).why, /"pipeline"/);
    assert.match(botPipeline({ ...ENV, CI_PIPELINE_SOURCE: "merge_request_event" }).why, /not one the process bot acts on/);
    assert.match(botPipeline({ ...ENV, CI_COMMIT_BRANCH: "merge-queue/pr-7" }).why, /not the default branch/);
  });

  it("what to do: the webhook body names the event; the queue asks for one MR; the schedule polls; nothing else", () => {
    const payload = JSON.stringify({ object_kind: "note", user: { username: "alice" }, object_attributes: { noteable_type: "MergeRequest" }, merge_request: { iid: 7, state: "opened" } });
    const o = { bot: BOT, queueLabel: "merge-queue", readPayload: () => payload };
    assert.deepEqual(whatToDo(ENV, o).tasks, ["gate"]);
    assert.deepEqual(whatToDo({ ...ENV, TRIGGER_PAYLOAD: "" }, o).tasks, []);
    assert.deepEqual(whatToDo({ ...ENV, CI_PIPELINE_SOURCE: "api", DEV_PROCESS_TASK: "risk-gate", DEV_PROCESS_PR: "9" }, o), { mode: "gate", mr: 9, head: null, tasks: ["gate"], baseChangedAt: null, why: "re-judge requested" });
    assert.equal(whatToDo({ ...ENV, CI_PIPELINE_SOURCE: "api", DEV_PROCESS_TASK: "risk-gate", DEV_PROCESS_PR: "9; rm -rf" }, o).mode, "none");
    assert.equal(whatToDo({ ...ENV, CI_PIPELINE_SOURCE: "schedule", DEV_PROCESS_TASK: "poll" }, o).mode, "poll");
    assert.equal(whatToDo({ ...ENV, CI_PIPELINE_SOURCE: "trigger" }, { ...o, readPayload: () => "{not json" }).tasks.length, 0);
  });
});

/* ───────────── runBot against an in-memory forge ───────────── */

function fakeForge({ changes = {}, open = [] } = {}) {
  const calls = [];
  const forge = {
    id: "gitlab",
    prTerm: "MR",
    ciIdentity: BOT,
    tokenIsBot: true,
    repo: "grp/app",
    loadChange: async (n) => structuredClone(changes[n]),
    hasWriteAccess: async () => true,
    setStatus: async (...a) => calls.push(["status", ...a.slice(0, 4)]),
    syncRiskLabel: async () => {},
    upsertMarkedComment: async (n) => calls.push(["note", n]),
    requestedReviewers: async () => [],
    postComment: async () => {},
    runUrl: () => undefined,
    rest: {
      paginate: async () => open,
      post: async (url, body) => {
        calls.push(["pipeline", body.variables.map((v) => `${v.key}=${v.value}`).join(" ")]);
        return { id: 1, sha: HEAD };
      },
    },
  };
  return { forge, calls, pipelines: () => calls.filter((c) => c[0] === "pipeline").map((c) => c[1]) };
}
const change = (over = {}) => ({ number: 7, author: "alice", headSha: HEAD, baseRef: "main", draft: false, fromFork: false, labels: [], files: [{ filename: "src/a.js", additions: 1, deletions: 0 }], reviews: [], comments: [], threads: [], statuses: [], baseChangedAt: null, headPushedAt: "2026-11-20T10:00:00Z", ...over });
const NOW = () => Date.parse("2026-11-20T12:00:00Z");
const run = (f, env, readPayload) => runBot({ forge: f.forge, policy: pol, reviewer: reviewerOn(pol, f.forge), env, log: () => {}, now: NOW, readPayload });

describe("runBot", () => {
  it("a push event: the gate runs here, the review gets its own pipeline on the default branch", async () => {
    const f = fakeForge({ changes: { 7: change() } });
    const payload = JSON.stringify({ object_kind: "merge_request", user: { username: "alice" }, object_attributes: { iid: 7, action: "update", oldrev: "a".repeat(40), state: "opened", last_commit: { id: HEAD } }, changes: {} });
    const out = await run(f, ENV, () => payload);
    assert.deepEqual(out.done.judged, [7]);
    assert.deepEqual(f.pipelines(), [`DEV_PROCESS_TASK=ai-review DEV_PROCESS_PR=7 DEV_PROCESS_SHA=${HEAD}`]);
    assert.ok(f.calls.some((c) => c[0] === "status" && c[2] === "risk-gate"));
  });

  it("a head already reviewed, or a draft, gets no review pipeline; a fork MR does (it is only read)", async () => {
    const reviewed = fakeForge({ changes: { 7: change({ comments: [{ login: BOT, body: `x\n${claudeMarker(HEAD)}`, createdAt: "2026-11-20T11:00:00Z" }] }) } });
    const push = JSON.stringify({ object_kind: "merge_request", user: { username: "alice" }, object_attributes: { iid: 7, action: "open", state: "opened", last_commit: { id: HEAD } } });
    await run(reviewed, ENV, () => push);
    assert.deepEqual(reviewed.pipelines(), []);
    const fork = fakeForge({ changes: { 7: change({ fromFork: true }) } });
    await run(fork, ENV, () => push);
    assert.equal(fork.pipelines().length, 1);
  });

  it("refuses a pipeline a job token started, and a token that is not a bot's", async () => {
    await assert.rejects(run(fakeForge(), { ...ENV, CI_PIPELINE_SOURCE: "pipeline" }, () => "{}"), /refusing to act/);
    const f = fakeForge();
    f.forge.tokenIsBot = false;
    await assert.rejects(run(f, ENV, () => "{}"), /not to a bot user/);
  });

  it("the poll: judges every open MR, backfills a missing review only for heads past the grace time without a notice, wakes the queue", async () => {
    const changes = {
      1: change({ number: 1 }), // old head, no review ⇒ review
      2: change({ number: 2, headPushedAt: "2026-11-20T11:50:00Z" }), // young head ⇒ wait
      3: change({ number: 3, comments: [{ login: BOT, body: `${claudeNoticeMarker(HEAD)}\nno key`, createdAt: "2026-11-20T11:00:00Z" }] }), // notice ⇒ someone acts
    };
    const open = [1, 2, 3].map((n) => ({ iid: n, sha: HEAD, state: "opened", target_branch: "main", labels: n === 3 ? ["merge-queue"] : [], source_project_id: 1, project_id: 1 }));
    const f = fakeForge({ changes, open });
    const out = await run(f, { ...ENV, CI_PIPELINE_SOURCE: "schedule", DEV_PROCESS_TASK: "poll" });
    assert.deepEqual(out.done.judged, [1, 2, 3]);
    assert.deepEqual(f.pipelines(), [`DEV_PROCESS_TASK=ai-review DEV_PROCESS_PR=1 DEV_PROCESS_SHA=${HEAD}`, "DEV_PROCESS_TASK=merge-queue"]);
  });
});
