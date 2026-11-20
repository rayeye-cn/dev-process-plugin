// risk-gate CLI orchestration against an in-memory forge: what it writes back, and when.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { judgeChange, loginsToCheck } from "../engine/cli/risk-gate.mjs";
import { copilot } from "../engine/reviewer/copilot.mjs";
import { AUTHOR, file, HEAD, policy } from "./helpers.mjs";

const OVERVIEW = "<!-- ccr-overview-v2 -->\nok";
const aiReview = (submittedAt = "2026-11-18T08:00:00Z", commitId = HEAD) => ({ login: "copilot-pull-request-reviewer[bot]", type: "Bot", state: "COMMENTED", commitId, submittedAt, body: OVERVIEW });

function fakeForge(change, { writers = [], requested = [] } = {}) {
  const writes = [];
  return {
    writes,
    id: "github",
    prTerm: "PR",
    ciIdentity: "github-actions[bot]",
    loadChange: async () => structuredClone(change),
    hasWriteAccess: async (login) => writers.includes(login),
    setStatus: async (...a) => writes.push(["status", ...a]),
    syncRiskLabel: async (...a) => writes.push(["label", ...a]),
    upsertMarkedComment: async (...a) => writes.push(["sticky", ...a]),
    postComment: async (...a) => writes.push(["comment", ...a]),
    requestedReviewers: async () => requested,
    requestAiReview: async (...a) => writes.push(["rerequest", ...a]),
    runUrl: () => "https://run",
  };
}

const baseChange = (over = {}) => ({
  number: 7,
  author: AUTHOR,
  headSha: HEAD,
  baseRef: "main",
  labels: [],
  files: [file("src/a.ts")],
  reviews: [aiReview()],
  comments: [{ login: AUTHOR, type: "User", body: `/signoff ${HEAD.slice(0, 7)}`, createdAt: "2026-11-18T09:00:00Z" }],
  threads: [],
  statuses: [],
  baseChangedAt: null,
  ...over,
});
const quiet = { log: () => {}, env: {} };

describe("judgeChange", () => {
  it("writes status, label and sticky comment in the project's language", async () => {
    const forge = fakeForge(baseChange());
    const { result } = await judgeChange({ forge, policy, reviewer: copilot, number: 7, ...quiet });
    assert.equal(result.ok, true);
    const status = forge.writes.find((w) => w[0] === "status" && w[2] === "risk-gate");
    assert.equal(status[3], "success");
    assert.equal(status[4], "medium：已满足（1 人）");
    assert.deepEqual(forge.writes.find((w) => w[0] === "label").slice(1, 5), [7, "medium", [], "risk:"]);
    const sticky = forge.writes.find((w) => w[0] === "sticky");
    assert.equal(sticky[2], "<!-- risk-gate -->");
    assert.ok(sticky[3].includes("risk-gate：**medium**"));

    const en = fakeForge(baseChange());
    await judgeChange({ forge: en, policy: { ...policy, language: "en" }, reviewer: copilot, number: 7, ...quiet });
    assert.equal(en.writes.find((w) => w[0] === "status")[4], "medium: satisfied (1 person)");
  });

  it("dry run writes nothing", async () => {
    const forge = fakeForge(baseChange());
    await judgeChange({ forge, policy, reviewer: copilot, number: 7, dryRun: true, ...quiet });
    assert.deepEqual(forge.writes, []);
  });

  it("a fresh classifier result for this head raises the tier and is stored as a status", async () => {
    const forge = fakeForge(baseChange());
    const env = { CLASSIFIER_TIER: "high", CLASSIFIER_REASON: "new privileged channel", CLASSIFIER_SHA: HEAD };
    const { result } = await judgeChange({ forge, policy, reviewer: copilot, number: 7, log: () => {}, env });
    assert.equal(result.tier, "high");
    assert.deepEqual(forge.writes.find((w) => w[2] === "risk-classifier").slice(3, 5), ["success", "high — new privileged channel"]);
  });

  it("re-requests the AI review when all reviews predate the base change, unless already requested", async () => {
    const change = baseChange({ reviews: [aiReview("2026-11-19T11:00:00Z")], baseChangedAt: "2026-11-19T12:00:00Z" });
    const forge = fakeForge(change);
    await judgeChange({ forge, policy, reviewer: copilot, number: 7, ...quiet });
    assert.deepEqual(forge.writes.find((w) => w[0] === "rerequest"), ["rerequest", 7, "copilot"]);
    const already = fakeForge(change, { requested: ["Copilot"] });
    await judgeChange({ forge: already, policy, reviewer: copilot, number: 7, ...quiet });
    assert.equal(already.writes.find((w) => w[0] === "rerequest"), undefined);
  });

  it("posts the rethink comment once when the round cap is reached with unanswered comments", async () => {
    const rounds = Array.from({ length: policy.reviewRoundCap }, (_, i) => aiReview(`2026-11-18T0${i}:00:00Z`));
    const thread = { isOutdated: false, path: "src/a.ts", line: 1, comments: [{ login: "Copilot", type: "Bot", body: "bug" }] };
    const forge = fakeForge(baseChange({ reviews: rounds, threads: [thread] }));
    await judgeChange({ forge, policy, reviewer: copilot, number: 7, ...quiet });
    const posted = forge.writes.filter((w) => w[0] === "comment");
    assert.equal(posted.length, 1);
    assert.ok(posted[0][2].startsWith("<!-- risk-gate:rethink -->"));
    const again = fakeForge(baseChange({ reviews: rounds, threads: [thread], comments: [{ login: "github-actions[bot]", type: "Bot", body: posted[0][2] }] }));
    await judgeChange({ forge: again, policy, reviewer: copilot, number: 7, ...quiet });
    assert.equal(again.writes.filter((w) => w[0] === "comment").length, 0);
  });

  it("a waiver counts only when its author has write access (checked through the forge)", async () => {
    const change = baseChange({
      files: [file("docs/a.md")],
      reviews: [],
      comments: [{ login: "carol", type: "User", body: `/waive-ai-review ${HEAD.slice(0, 7)}`, createdAt: "2026-11-18T09:00:00Z" }],
    });
    const yes = await judgeChange({ forge: fakeForge(change, { writers: ["carol"] }), policy, reviewer: copilot, number: 7, dryRun: true, ...quiet });
    assert.equal(yes.result.aiReview.waived, true);
    const no = await judgeChange({ forge: fakeForge(change), policy, reviewer: copilot, number: 7, dryRun: true, ...quiet });
    assert.equal(no.result.aiReview.waived, false);
  });
});

describe("loginsToCheck", () => {
  it("approvers on the head after the base change, plus waiver authors only when the AI has not reviewed", () => {
    const reviews = [
      { login: "bob", type: "User", state: "APPROVED", commitId: HEAD, submittedAt: "2026-11-19T13:00:00Z" },
      { login: "old", type: "User", state: "APPROVED", commitId: "x", submittedAt: "2026-11-19T13:00:00Z" },
      { login: AUTHOR, type: "User", state: "APPROVED", commitId: HEAD, submittedAt: "2026-11-19T13:00:00Z" },
      { login: "early", type: "User", state: "APPROVED", commitId: HEAD, submittedAt: "2026-11-19T11:00:00Z" },
    ];
    const args = { reviews, author: AUTHOR, headSha: HEAD, baseChangedAt: "2026-11-19T12:00:00Z", waiverOnHead: [{ by: "carol" }], reviewer: copilot };
    assert.deepEqual([...loginsToCheck({ ...args, reviewedHead: false })], ["bob", "carol"]);
    assert.deepEqual([...loginsToCheck({ ...args, reviewedHead: true })], ["bob"]);
  });
});

describe("judgeChange with Claude as the reviewer", async () => {
  const { createClaudeReviewer, claudeMarker } = await import("../engine/reviewer/claude.mjs");
  const claude = createClaudeReviewer();
  const summary = (sha = HEAD, at = "2026-11-18T08:00:00Z", login = "claude[bot]") => ({ login, type: "Bot", body: `Found 0 issues.\nRisk: low\n${claudeMarker(sha)}`, createdAt: at });

  it("a summary comment by the Claude App on the head is the review; the gate refreshes on that comment", async () => {
    const forge = fakeForge(baseChange({ reviews: [], comments: [...baseChange().comments, summary()] }));
    const { result } = await judgeChange({ forge, policy, reviewer: claude, number: 7, ...quiet });
    assert.equal(result.aiReview.reviewedHead, true);
    assert.equal(result.ok, true);
  });

  it("stale (before a base change) ⇒ nothing to re-request (the review workflow re-runs on the retarget); the text says so", async () => {
    const change = baseChange({ reviews: [], comments: [...baseChange().comments, summary(HEAD, "2026-11-19T11:00:00Z")], baseChangedAt: "2026-11-19T12:00:00Z" });
    const forge = fakeForge(change);
    const { result, body } = await judgeChange({ forge, policy: { ...policy, language: "en" }, reviewer: claude, number: 7, ...quiet });
    assert.equal(result.aiReview.staleBase, true);
    assert.equal(forge.writes.find((w) => w[0] === "rerequest"), undefined);
    assert.match(body, /re-runs on a retarget by itself/);
    assert.match(body, /the gate re-runs when its summary comment is posted/);
  });
});
