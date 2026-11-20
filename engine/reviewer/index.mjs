/**
 * AI reviewer adapters. Each adapter is pure (no I/O):
 *   id, displayName, forges[]                 which forges it supports
 *   isReviewer(login)                         does this account belong to the reviewer
 *   isRealReview(review)                      a real review vs a notice
 *   aiReviews({ reviews, comments })          normalized `{ login, commitId, submittedAt, body, real }`
 *   isRequested(requestedLogins)              already requested (skip re-request)
 *   rerequestable                             false ⇒ the gate never re-requests (the reviewer re-runs on its own events)
 * Re-requesting is I/O and lives in the CLI next to the forge calls.
 */
import { createClaudeReviewer } from "./claude.mjs";
import { copilot } from "./copilot.mjs";

/**
 * @param id    "copilot" | "claude"
 * @param opts  `{ ciIdentity }` (who posts notices on this forge) and `{ accounts }` (the reviewer's logins, e.g. a
 *              self-hosted Claude App) — only the Claude adapter reads them.
 */
export function reviewerFor(id, opts = {}) {
  if (id === "copilot") return copilot;
  if (id === "claude") return createClaudeReviewer({ ...(opts.accounts?.length ? { accounts: opts.accounts } : {}), ...(opts.ciIdentity ? { ciIdentity: opts.ciIdentity } : {}) });
  throw new Error(`unknown reviewer "${id}" (known: copilot, claude)`);
}

export { copilot };

/**
 * The policy's reviewer on this forge. GitLab has no reviewer App: the process bot posts Claude's review, so unless the
 * policy names the accounts, the reviewer's account is the bot (the forge's CI identity).
 */
export function reviewerOn(policy, forge) {
  const named = policy.aiReview?.accounts ?? [];
  const accounts = named.length ? named : forge.id === "gitlab" && forge.ciIdentity ? [forge.ciIdentity] : [];
  return reviewerFor(policy.reviewer, { ciIdentity: forge.ciIdentity, accounts });
}
