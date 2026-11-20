/**
 * The Claude review job's decisions (pure). The job: should this event be reviewed → the prompt → claude-code-action →
 * did a review for this head come out, and if not, which notice to leave. I/O lives in cli/ai-review.mjs.
 *
 * "Reviewed" means exactly what the gate means (gate.aiReviewState): a real summary by the reviewer for this head, posted
 * after the latest target-branch change. Judging it any other way would let a retarget run skip (or accept the old
 * summary) while the gate keeps waiting.
 */
import { aiReviewState } from "./gate.mjs";

/** Machine-read outputs of the job steps (language-neutral). */
export const SKIP = Object.freeze({ fork: "fork", draft: "draft", superseded: "superseded", reviewed: "reviewed" });

/**
 * Should this run review? `{ review, reason, code, params }`; reason is one of SKIP or "run".
 * @param change    the forge's loadChange shape (headSha, draft, fromFork, comments, baseChangedAt)
 * @param eventHead the head sha of the event that started the run
 */
export function reviewDecision({ reviewer, change, eventHead }) {
  const sha = change.headSha;
  const skip = (reason) => ({ review: false, reason, code: `aiReview.skip.${reason}`, params: { sha, eventHead } });
  // A fork PR's run has no secrets and a read-only token; claude-code-action would refuse it anyway.
  if (change.fromFork) return skip(SKIP.fork);
  if (change.draft) return skip(SKIP.draft);
  // A newer push started its own run; reviewing the old head would only be noise.
  if (eventHead && eventHead !== sha) return skip(SKIP.superseded);
  if (reviewedNow({ reviewer, change })) return skip(SKIP.reviewed);
  return { review: true, reason: "run", code: "aiReview.run", params: { sha } };
}

/** Is there a review of the head that the gate counts? */
export function reviewedNow({ reviewer, change }) {
  return aiReviewState(reviewer.aiReviews({ reviews: change.reviews ?? [], comments: change.comments ?? [] }), change.headSha, null, change.baseChangedAt ?? null).reviewedHead;
}

/**
 * After the review step: `{ notice: null }` when the head is reviewed (or moved on), else `{ notice: { code, params } }`.
 * @param outcome  the review step's outcome: success | failure | skipped | cancelled
 * @param keySet   whether the API key secret is set
 */
export function verifyDecision({ reviewer, change, eventHead, outcome, keySet }) {
  if (eventHead && eventHead !== change.headSha) return { notice: null, reason: SKIP.superseded };
  if (reviewedNow({ reviewer, change })) return { notice: null, reason: SKIP.reviewed };
  const code = !keySet ? "aiReview.notice.noKey" : outcome === "success" ? "aiReview.notice.noSummary" : "aiReview.notice.failed";
  return { notice: { code, params: { sha: change.headSha, outcome } }, reason: "missing" };
}

/** A notice with the same text already on this head (a re-run): don't post it twice. */
export function hasNotice(comments, ciIdentity, body) {
  return (comments ?? []).some((c) => c.login === ciIdentity && String(c.body ?? "").trim() === body.trim());
}
