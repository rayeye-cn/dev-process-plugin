// The Claude review job: whether to review, whether a review came out, which notice, the prompt — judged like the gate.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { buildPrompt, output, shouldReview, sideCopy, verifyReview } from "../engine/cli/ai-review.mjs";
import { hasNotice, reviewDecision, verifyDecision } from "../engine/core/ai-review.mjs";
import { t } from "../engine/core/messages/index.mjs";
import { claudeMarker, claudeNoticeMarker, createClaudeReviewer } from "../engine/reviewer/claude.mjs";
import { HEAD, OLD, policy } from "./helpers.mjs";

const claude = createClaudeReviewer();
const summary = (sha = HEAD, at = "2026-11-19T13:00:00Z", login = "claude[bot]") => ({ login, type: "Bot", body: `Found 0 issues.\n${claudeMarker(sha)}`, createdAt: at });
const change = (over = {}) => ({ headSha: HEAD, draft: false, fromFork: false, reviews: [], comments: [], baseChangedAt: null, ...over });
const decide = (over, eventHead = HEAD) => reviewDecision({ reviewer: claude, change: change(over), eventHead });

describe("should this run review", () => {
  it("reviews an unreviewed head; skips forks, drafts, an older head and a head already reviewed", () => {
    assert.equal(decide({}).review, true);
    assert.equal(decide({ fromFork: true }).reason, "fork");
    assert.equal(decide({ draft: true }).reason, "draft");
    assert.equal(decide({}, OLD).reason, "superseded");
    assert.equal(decide({ comments: [summary()] }).reason, "reviewed");
    assert.equal(decide({ comments: [summary(OLD)] }).review, true, "a review of another commit does not count");
  });

  it("a retarget: the summary before the base change does not count, so the retarget run reviews again", () => {
    const before = summary(HEAD, "2026-11-19T11:00:00Z");
    assert.equal(decide({ comments: [before], baseChangedAt: "2026-11-19T12:00:00Z" }).review, true);
    assert.equal(decide({ comments: [before, summary(HEAD, "2026-11-19T13:00:00Z")], baseChangedAt: "2026-11-19T12:00:00Z" }).reason, "reviewed");
  });

  it("someone else's comment with the marker is not a review", () => {
    assert.equal(decide({ comments: [summary(HEAD, undefined, "mallory")] }).review, true);
    assert.equal(decide({ comments: [summary(HEAD, undefined, "github-actions[bot]")] }).review, true);
  });
});

describe("after the review step", () => {
  const verify = (over, opts = {}) => verifyDecision({ reviewer: claude, change: change(over), eventHead: HEAD, outcome: "success", keySet: true, ...opts });
  it("no notice when the head is reviewed or a newer push took over", () => {
    assert.equal(verify({ comments: [summary()] }).notice, null);
    assert.equal(verifyDecision({ reviewer: claude, change: change(), eventHead: OLD, outcome: "failure", keySet: true }).notice, null);
  });
  it("which notice: no key, the action failed, or it finished without the summary", () => {
    assert.equal(verify({}, { keySet: false, outcome: "skipped" }).notice.code, "aiReview.notice.noKey");
    assert.equal(verify({}, { outcome: "failure" }).notice.code, "aiReview.notice.failed");
    assert.equal(verify({}).notice.code, "aiReview.notice.noSummary");
    assert.equal(verify({ comments: [summary(HEAD, "2026-11-19T11:00:00Z")], baseChangedAt: "2026-11-19T12:00:00Z" }).notice.code, "aiReview.notice.noSummary", "an old summary is not this review");
  });
  it("each notice's first sentence says what happened (the gate quotes only that)", async () => {
    const { firstSentence } = await import("../engine/core/gate.mjs");
    for (const lang of ["zh", "en"]) {
      for (const code of ["aiReview.notice.noKey", "aiReview.notice.failed", "aiReview.notice.noSummary"]) {
        const first = firstSentence(t(lang, code, { sha: HEAD, outcome: "failure" }));
        assert.ok(first.length > 15 && first.length < 120, `${lang} ${code}: ${first}`);
      }
    }
  });
  it("the same notice twice on one head is posted once", () => {
    const body = `${claudeNoticeMarker(HEAD)}\nx`;
    assert.equal(hasNotice([{ login: "github-actions[bot]", body }], "github-actions[bot]", body), true);
    assert.equal(hasNotice([{ login: "mallory", body }], "github-actions[bot]", body), false);
  });
});

/* ───────────────────────────── the CLI against an in-memory forge ───────────────────────────── */

function fakeForge(c) {
  const writes = [];
  return {
    writes,
    ciIdentity: "github-actions[bot]",
    loadChange: async (number, { baseHint } = {}) => ({ ...structuredClone(c), baseChangedAt: c.baseChangedAt ?? baseHint }),
    postComment: async (...a) => writes.push(["comment", ...a]),
  };
}
const quiet = { log: () => {} };

describe("ai-review CLI", () => {
  it("should-review: the event's base-change hint counts like the gate's; the key flag is passed on", async () => {
    const forge = fakeForge(change({ comments: [summary(HEAD, "2026-11-19T11:00:00Z")] }));
    const env = { BASE_CHANGED_AT: "2026-11-19T12:00:00Z", KEY_SET: "true" };
    const d = await shouldReview({ forge, policy, reviewer: claude, number: "7", eventHead: HEAD, env, ...quiet });
    assert.deepEqual([d.review, d.key], [true, true]);
    const none = await shouldReview({ forge, policy, reviewer: claude, number: "7", eventHead: HEAD, env: {}, ...quiet });
    assert.deepEqual([none.review, none.reason, none.key], [false, "reviewed", false]);
  });

  it("verify posts the localized notice with the marker once, and nothing when reviewed", async () => {
    const forge = fakeForge(change());
    const v = await verifyReview({ forge, policy: { ...policy, language: "en" }, reviewer: claude, number: "7", eventHead: HEAD, outcome: "failure", keySet: true, env: {}, ...quiet });
    assert.equal(v.notice, true);
    const [, n, body] = forge.writes[0];
    assert.equal(n, "7");
    assert.ok(body.startsWith(`${claudeNoticeMarker(HEAD)}\nThe AI review job failed`));
    // the adapter reads it back as a notice, not a review
    const [read] = claude.aiReviews({ comments: [{ login: "github-actions[bot]", body, createdAt: "t" }] });
    assert.equal(read.real, false);

    const again = fakeForge(change({ comments: [{ login: "github-actions[bot]", body }] }));
    assert.equal((await verifyReview({ forge: again, policy: { ...policy, language: "en" }, reviewer: claude, number: "7", eventHead: HEAD, outcome: "failure", keySet: true, env: {}, ...quiet })).notice, false);
    assert.equal(again.writes.length, 0);

    const ro = { ...fakeForge(change()), postComment: async () => Promise.reject(new Error("403 Resource not accessible by integration")) };
    const logs = [];
    assert.deepEqual(await verifyReview({ forge: ro, policy, reviewer: claude, number: "7", eventHead: HEAD, outcome: "failure", keySet: false, env: {}, log: (l) => logs.push(l) }), { notice: false, reason: "unwritable" });
    assert.match(logs.join("\n"), /::warning::#7: could not post the notice/);

    const done = fakeForge(change({ comments: [summary()] }));
    assert.equal((await verifyReview({ forge: done, policy, reviewer: claude, number: "7", eventHead: HEAD, outcome: "success", keySet: true, env: {}, ...quiet })).notice, false);
    assert.equal(done.writes.length, 0);
  });

  it("outputs: one-line values as key=value, multi-line ones with a random delimiter the text cannot guess", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-review-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "out");
    writeFileSync(file, "");
    output({ GITHUB_OUTPUT: file }, { review: true, text: "a\nEOF\nb" });
    const text = readFileSync(file, "utf8");
    const m = /^review=true\ntext<<(EOF_[0-9a-f-]{36})\na\nEOF\nb\n\1\n$/.exec(text);
    assert.ok(m, text);
  });
});

describe("the review prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-prompt-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const pol = { ...policy, paths: { ...policy.paths, instructions: ".dev-process/ai-review/instructions.md", security: ".dev-process/ai-review/security.md" } };
  mkdirSync(join(dir, ".dev-process/ai-review"), { recursive: true });
  writeFileSync(join(dir, pol.paths.instructions), "---\napplyTo: x\n---\n# Review rules\nLook for races.\n");
  writeFileSync(join(dir, pol.paths.security), "# Security\nNo secrets in logs.\n");

  for (const lang of ["zh", "en"]) {
    it(`${lang}: the head, the marker as the summary's last line, the instructions, the limits and the people-only commands`, () => {
      const p = buildPrompt({ policy: { ...pol, language: lang }, root: dir, repo: "o/r", number: "7", sha: HEAD });
      assert.ok(p.includes(`#7`) && p.includes(HEAD));
      assert.ok(p.includes(`\n${claudeMarker(HEAD)}\n`));
      assert.ok(p.includes("Look for races.") && p.includes("No secrets in logs."));
      assert.doesNotMatch(p, /applyTo/, "front matter is for the forge, not the prompt");
      assert.ok(p.includes("mcp__github_inline_comment__create_inline_comment"));
      assert.ok(p.includes(`gh pr comment 7`));
      assert.ok(p.includes(String(pol.aiReview.maxComments)));
      for (const tag of pol.threadReplyTags) assert.ok(p.includes(`\`${tag}\``), tag);
      assert.ok(p.includes(`\`${pol.commands.signoff}\``) && p.includes(`\`${pol.commands.waiver}\``));
      assert.doesNotMatch(p, /\.dev-process-ci/);
      const withCopy = buildPrompt({ policy: { ...pol, language: lang }, root: dir, repo: "o/r", number: "7", sha: HEAD, ignore: ".dev-process-ci" });
      assert.ok(withCopy.includes("`.dev-process-ci/`"));
    });
  }

  it("the CI's copy is named only when it is a subdirectory of the working directory", () => {
    assert.equal(sideCopy("/w/.dev-process-ci", "/w"), ".dev-process-ci");
    assert.equal(sideCopy("/w", "/w"), "");
    assert.equal(sideCopy("/elsewhere", "/w"), "");
  });
});
