/**
 * GitHub Copilot code review (GitHub only).
 *
 * Logins: reviews come from `copilot-pull-request-reviewer[bot]` in REST, without `[bot]` in GraphQL; inline comments show
 * as `Copilot`. Only these exact names count (a human account may be called copilotxyz).
 *
 * A real review carries the overview marker `<!-- ccr-overview-vN -->` (any N). Quota or error notices ("Copilot was
 * unable to review this pull request…") are reviews by the same account without the marker: they are neither a review
 * nor a round. If GitHub changes the marker everything reads as "not reviewed" (fail closed); the gate comment quotes the
 * notice's first sentence so the cause is visible.
 */
const LOGIN = /^(copilot-pull-request-reviewer|copilot)(\[bot\])?$/i;
const OVERVIEW = /<!--\s*ccr-overview(?:-v\d+)?\s*-->/i;

export const copilot = Object.freeze({
  id: "copilot",
  displayName: "Copilot",
  forges: Object.freeze(["github"]),

  isReviewer: (login) => LOGIN.test(login ?? ""),

  /** `{ login, body }` → real review (not a notice). */
  isRealReview(review) {
    return copilot.isReviewer(review?.login) && OVERVIEW.test(String(review?.body ?? ""));
  },

  /**
   * Normalized AI reviews from forge data: `{ login, commitId, submittedAt, body, real }`.
   * Copilot posts formal PR reviews, so they come from `reviews`.
   */
  aiReviews({ reviews = [] }) {
    return reviews
      .filter((r) => copilot.isReviewer(r.login))
      .map((r) => ({ login: r.login, commitId: r.commitId, submittedAt: r.submittedAt, body: r.body, real: copilot.isRealReview(r) }));
  },

  /** Is this reviewer already among the requested reviewers (so a re-request would be a no-op)? */
  isRequested: (requestedLogins = []) => requestedLogins.some((l) => copilot.isReviewer(l)),
});
