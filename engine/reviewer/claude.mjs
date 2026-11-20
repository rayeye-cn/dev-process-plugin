/**
 * Claude as the AI reviewer: `anthropics/claude-code-action` on GitHub (a Claude CLI job on GitLab, M5).
 *
 * Unlike Copilot, the action cannot submit formal PR reviews. A review is:
 * - inline comments through the action's inline-comment tool, posted as the Claude GitHub App (`claude[bot]`): they open
 *   review threads like any reviewer, and the gate requires every one to be answered;
 * - ONE summary comment, also as `claude[bot]`, whose last line is the review marker
 *   `<!-- ai-review:claude sha=<full head sha> -->` (the review prompt asks for it; the workflow checks it was posted).
 * Only comments by the reviewer's own accounts count: anyone can paste the marker into a comment, nobody else can post as
 * the App. The formal reviews GitHub wraps around the inline comments carry no marker and are ignored here.
 *
 * When the review job ran but no review came out (no API key, the model did not post its summary) the workflow posts a
 * notice as the CI identity with `<!-- ai-review:claude-notice sha=<sha> -->`: shown in the gate's comment like
 * Copilot's quota notices, never counted as a review. Fork PRs get no notice: their token cannot write; the review
 * workflow skips them and the gate's text points at the waiver.
 *
 * Nothing re-requests Claude (`rerequestable: false`): the review workflow runs on pushes and on retargets
 * (`pull_request: edited` with a base change). claude-code-action only offers its inline-comment tool on PR events, so a
 * `workflow_dispatch` re-run could post a summary but no inline threads. When a review is missing, re-run the job.
 */
const MARKER = /<!--\s*ai-review:claude\s+sha=([0-9a-f]{40})\s*-->/i;
const NOTICE = /<!--\s*ai-review:claude-notice\s+sha=([0-9a-f]{40})\s*-->/i;

/** The review marker for a head commit (the review prompt and tests use it). */
export const claudeMarker = (sha) => `<!-- ai-review:claude sha=${sha} -->`;
/** The notice marker for a head commit (the review workflow's fallback comment). */
export const claudeNoticeMarker = (sha) => `<!-- ai-review:claude-notice sha=${sha} -->`;

export const CLAUDE_ACCOUNTS = Object.freeze(["claude[bot]", "claude"]);

/**
 * @param opts.accounts    the reviewer's logins (default: the Claude GitHub App in REST and GraphQL spellings)
 * @param opts.ciIdentity  who posts notices (GitHub: github-actions[bot])
 */
export function createClaudeReviewer({ accounts = CLAUDE_ACCOUNTS, ciIdentity = "github-actions[bot]" } = {}) {
  const own = new Set(accounts.map((a) => a.toLowerCase()));
  const isReviewer = (login) => own.has(String(login ?? "").toLowerCase());
  const reviewer = {
    id: "claude",
    displayName: "Claude",
    forges: Object.freeze(["github", "gitlab"]),
    isReviewer,

    /** A summary comment by the reviewer that carries the marker. */
    isRealReview: (c) => isReviewer(c?.login) && MARKER.test(String(c?.body ?? "")),

    /** Normalized `{ login, commitId, submittedAt, body, real }` from the PR's comments (reviews are not used). */
    aiReviews({ comments = [] }) {
      const out = [];
      for (const c of comments) {
        const body = String(c.body ?? "");
        const at = c.createdAt ?? c.updatedAt ?? null;
        if (isReviewer(c.login)) {
          const m = MARKER.exec(body);
          if (m) out.push({ login: c.login, commitId: m[1].toLowerCase(), submittedAt: at, body, real: true });
        } else if (c.login === ciIdentity) {
          const n = NOTICE.exec(body);
          if (n) out.push({ login: c.login, commitId: n[1].toLowerCase(), submittedAt: at, body: body.replace(NOTICE, "").trim(), real: false });
        }
      }
      return out;
    },

    /** Claude is never a requested reviewer. */
    isRequested: () => false,
    /** The review workflow re-runs on its own events (push, retarget); the gate has nothing to request. */
    rerequestable: false,
  };
  return Object.freeze(reviewer);
}

export const claude = createClaudeReviewer();
