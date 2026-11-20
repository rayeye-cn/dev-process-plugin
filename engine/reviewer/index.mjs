/**
 * AI reviewer adapters. Each adapter is pure (no I/O):
 *   id, displayName, forges[]                 which forges it supports
 *   isReviewer(login)                         does this account belong to the reviewer
 *   isRealReview(review)                      a real review vs a notice
 *   aiReviews({ reviews, comments })          normalized `{ login, commitId, submittedAt, body, real }`
 *   isRequested(requestedLogins)              already requested (skip re-request)
 * Re-requesting is I/O and lives in the CLI next to the forge calls.
 */
import { copilot } from "./copilot.mjs";

const ADAPTERS = { copilot };

export function reviewerFor(id) {
  const r = ADAPTERS[id];
  if (!r) throw new Error(`unknown reviewer "${id}" (known: ${Object.keys(ADAPTERS).join(", ")})`);
  return r;
}

export { copilot };
