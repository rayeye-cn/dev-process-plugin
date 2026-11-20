// The Claude reviewer adapter: what counts as a review, a notice, a reviewer account; the gate on top of it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as gate from "../engine/core/gate.mjs";
import { claude, claudeMarker, claudeNoticeMarker, createClaudeReviewer } from "../engine/reviewer/claude.mjs";
import { reviewerFor } from "../engine/reviewer/index.mjs";
import { AUTHOR, file, HEAD, OLD, policy } from "./helpers.mjs";

const comment = (login, body, createdAt = "2026-11-18T08:00:00Z", type = "Bot") => ({ login, type, body, createdAt });
const summary = (sha = HEAD, at) => comment("claude[bot]", `Found 1 issue.\nRisk: medium — touches auth\n${claudeMarker(sha)}`, at);
const signoff = { login: AUTHOR, type: "User", body: `/signoff ${HEAD.slice(0, 7)}`, createdAt: "2026-11-18T09:00:00Z" };
const run = (over = {}) =>
  gate.evaluate({ policy, reviewer: claude, author: AUTHOR, headSha: HEAD, files: [file("src/a.ts")], reviews: [], comments: [signoff], threads: [], ...over });

describe("what counts", () => {
  it("a summary by the App with the marker for the head is a real review; by anyone else it is nothing", () => {
    assert.deepEqual(claude.aiReviews({ comments: [summary()] }).map((r) => [r.login, r.commitId, r.real]), [["claude[bot]", HEAD, true]]);
    assert.deepEqual(claude.aiReviews({ comments: [comment("alice", claudeMarker(HEAD), undefined, "User")] }), []);
    assert.deepEqual(claude.aiReviews({ comments: [comment("claude[bot]", "a summary without the marker")] }), []);
    assert.deepEqual(claude.aiReviews({ comments: [comment("claude[bot]", "<!-- ai-review:claude sha=abc1234 -->")] }), [], "short shas are not accepted");
  });

  it("a notice by the CI identity is shown, never counted; a notice by anyone else is ignored", () => {
    const notice = comment("github-actions[bot]", `${claudeNoticeMarker(HEAD)}\nThe review job could not run: ANTHROPIC_API_KEY is not set.`);
    const [n] = claude.aiReviews({ comments: [notice] });
    assert.equal(n.real, false);
    assert.equal(n.body, "The review job could not run: ANTHROPIC_API_KEY is not set.");
    assert.deepEqual(claude.aiReviews({ comments: [comment("alice", claudeNoticeMarker(HEAD), undefined, "User")] }), []);
  });

  it("reviewer accounts: the App in both spellings, configurable; never requested", () => {
    assert.equal(claude.isReviewer("claude[bot]"), true);
    assert.equal(claude.isReviewer("Claude"), true);
    assert.equal(claude.isReviewer("claudette"), false);
    const own = reviewerFor("claude", { accounts: ["our-review-app[bot]"] });
    assert.equal(own.isReviewer("our-review-app[bot]"), true);
    assert.equal(own.isReviewer("claude[bot]"), false);
    assert.equal(claude.isRequested(["claude[bot]"]), false);
    assert.equal(createClaudeReviewer({ ciIdentity: "ci-bot" }).aiReviews({ comments: [comment("ci-bot", claudeNoticeMarker(HEAD))] }).length, 1);
  });
});

describe("the gate with Claude", () => {
  it("passes with a review of the head; waits with only an old one or a notice (quoted)", () => {
    assert.equal(run({ comments: [signoff, summary()] }).ok, true);
    const old = run({ comments: [signoff, summary(OLD)] });
    assert.equal(old.ok, false);
    assert.equal(old.aiReview.reviewedHead, false);
    const notice = run({ comments: [signoff, comment("github-actions[bot]", `${claudeNoticeMarker(HEAD)}\nThe review job failed. Re-run it.`)] });
    assert.equal(notice.aiReview.notice, "The review job failed.");
    const text = gate.explain(notice, "en").missing.join("\n");
    assert.match(text, /Wait for Claude to review the head commit/);
    assert.match(text, /re-run the AI review job/);
  });

  it("inline comments by the App are AI threads that need answers; its formal reviews are not approvals", () => {
    const thread = { isOutdated: false, path: "src/a.ts", line: 1, comments: [{ login: "claude[bot]", type: "Bot", body: "null deref" }] };
    assert.equal(run({ comments: [signoff, summary()], threads: [thread] }).ok, false);
    const answered = { ...thread, comments: [...thread.comments, { login: AUTHOR, type: "User", body: "fixed: guarded" }] };
    assert.equal(run({ comments: [signoff, summary()], threads: [answered] }).ok, true);
    const r = run({ files: [file("src/update/a.ts")], comments: [signoff, summary()], reviews: [{ login: "claude[bot]", type: "Bot", state: "APPROVED", commitId: HEAD, submittedAt: "t" }] });
    assert.deepEqual(r.approvers, []);
  });

  it("rounds are real summaries after the base change; a sign-off before it is stale; the waiver works the same", () => {
    const resigned = { ...signoff, createdAt: "2026-11-19T14:00:00Z" };
    const r = run({ comments: [resigned, summary(HEAD, "2026-11-19T11:00:00Z"), summary(HEAD, "2026-11-19T13:00:00Z")], baseChangedAt: "2026-11-19T12:00:00Z" });
    assert.equal(r.aiRounds, 1);
    assert.equal(r.ok, true);
    const waiver = gate.pickWaiver({ onHead: [{ by: "carol", at: "2026-11-19T14:00:00Z" }], stale: [] }, new Set(["carol"]));
    assert.equal(run({ comments: [resigned], waiver }).aiReview.waived, true);
  });
});
