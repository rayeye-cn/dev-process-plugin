/**
 * Weekly review metrics (pure, no I/O). Following the Claude Code team's practice: measure human time, with reverts and
 * fixes as guardrails.
 *
 * Over the PRs merged into the default branch within the window:
 * - Human time: approvals and comments from others per PR (median / p95); hours from opening the PR to the merge and to
 *   the first approval from someone else.
 * - Noise: what became of the AI reviewer's inline comments — the code moved (outdated) / a reply tag
 *   (threadReplyTags: fixed / wrong / intended / wontfix …) / unanswered; false-positive rate = wrong ÷ comments with an
 *   outcome. AI review rounds (median / p95; real reviews only — quota or error notices are not rounds).
 * - AI review waivers: PRs whose merge commit carries the merge queue's waiver trailer (WAIVER_TRAILER), i.e. people
 *   stood in because the AI reviewer was down or out of quota. Counted from the merge commit, not from comments or
 *   labels: those can still change after the merge and would under- or over-count.
 * - Tier distribution: the `<names.riskLabelPrefix><tier>` labels.
 * - Guardrails: revert commits on the default branch within the window (patterns.revert) and fix PRs (title matches
 *   patterns.fix).
 * The AI reviewer (its accounts, real reviews vs notices, display name) comes from the reviewer adapter; reply tags are
 * read exactly like the gate reads them (replyTagOf). cli/metrics.mjs appends the report as a weekly comment on the
 * issue labelled names.metricsLabel.
 */
import { isBot, replyTagOf, WAIVER_TRAILER } from "./gate.mjs";
import { t } from "./messages/index.mjs";
import { DEFAULTS } from "./policy.mjs";

const HOUR = 3_600_000;

/** Language-neutral outcome and tier values (rendered through the catalog where they are not codes). */
export const OUTDATED = "outdated";
export const UNANSWERED = "unanswered";
export const UNTIERED = "untiered";
/** The reply tag that marks an AI comment as a false positive. */
export const FALSE_POSITIVE_TAG = "wrong";

/** Nearest-rank percentile; non-numbers are ignored; empty ⇒ null. */
export function percentile(values, p) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

/**
 * Outcome of one thread the AI reviewer opened: a reply tag (the policy's threadReplyTags, same reading as the gate)
 * > the code moved (outdated) > unanswered. The LAST tagged human reply wins: `wrong:` first and, after a discussion,
 * `fixed:` ⇒ fixed. Threads opened by anyone else ⇒ null.
 */
export function threadOutcome(thread, tags = DEFAULTS.threadReplyTags, reviewer) {
  const [first, ...replies] = thread.comments ?? [];
  if (!first || !reviewer.isReviewer(first.login)) return null;
  for (const c of [...replies].reverse()) {
    if (isBot(c.login, c.type, reviewer)) continue;
    const tag = replyTagOf(c.body, tags);
    if (tag) return tag;
  }
  return thread.isOutdated ? OUTDATED : UNANSWERED;
}

/** The tier from the `<prefix><tier>` label; none ⇒ UNTIERED. Labels are `{ name }` objects or names. */
export function tierOf(labels, prefix) {
  return (labels ?? []).map((l) => l?.name ?? l).find((n) => typeof n === "string" && n.startsWith(prefix))?.slice(prefix.length) ?? UNTIERED;
}

/** The merge commit message carries the queue's waiver trailer (at the start of a line; a mention mid-line doesn't count). */
export const isWaivedMerge = (mergeMessage) => String(mergeMessage ?? "").split("\n").some((l) => l.startsWith(WAIVER_TRAILER));

/**
 * Metrics of one merged PR.
 * @param input.policy    withDefaults() policy (threadReplyTags, names.riskLabelPrefix)
 * @param input.reviewer  reviewer adapter
 * @param input.reviews   `{ login, type, state, submittedAt, body, commitId }`
 * @param input.comments  issue comments `{ login, type, body, createdAt? }`
 * @param input.threads   review threads (forge loadReviewThreads)
 * @param input.mergeMessage  the merge commit's message (waiver trailer)
 */
export function prMetrics({ policy, reviewer, author, reviews, comments, threads, createdAt, mergedAt, labels = [], mergeMessage = "" }) {
  const others = (login, type) => Boolean(login) && login !== author && !isBot(login, type, reviewer);
  const approvals = reviews.filter((r) => r.state === "APPROVED" && others(r.login, r.type));
  const approvers = new Set(approvals.map((r) => r.login));
  const firstApproval = approvals
    .map((r) => Date.parse(r.submittedAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const threadComments = threads.flatMap((th) => th.comments ?? []);
  // On GitHub an inline comment is both a thread comment and a COMMENTED review with an empty body: count reviews
  // only when they have a body, so it is not counted twice.
  const humanComments =
    comments.filter((c) => others(c.login, c.type)).length +
    threadComments.filter((c) => others(c.login, c.type)).length +
    reviews.filter((r) => others(r.login, r.type) && String(r.body ?? "").trim() !== "").length;
  const outcomes = threads.map((th) => threadOutcome(th, policy.threadReplyTags, reviewer)).filter(Boolean);
  const created = Date.parse(createdAt);
  return {
    approvals: approvers.size,
    humanComments,
    leadHours: (Date.parse(mergedAt) - created) / HOUR,
    approvalWaitHours: firstApproval ? (firstApproval - created) / HOUR : null,
    aiRounds: reviewer.aiReviews({ reviews, comments }).filter((r) => r.real).length,
    waived: isWaivedMerge(mergeMessage),
    outcomes,
    tier: tierOf(labels, policy.names.riskLabelPrefix),
  };
}

export function aggregate(list, { reverts = 0, fixPrs = 0 } = {}) {
  const count = (arr) => arr.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  const outcomes = count(list.flatMap((m) => m.outcomes));
  const decided = Object.entries(outcomes).reduce((n, [k, v]) => n + (k === UNANSWERED ? 0 : v), 0);
  const stat = (key) => ({ p50: percentile(list.map((m) => m[key]), 50), p95: percentile(list.map((m) => m[key]), 95) });
  return {
    prs: list.length,
    approvals: stat("approvals"),
    humanComments: stat("humanComments"),
    leadHours: stat("leadHours"),
    approvalWaitHours: stat("approvalWaitHours"),
    aiRounds: stat("aiRounds"),
    zeroHumanShare: list.length ? list.filter((m) => m.approvals === 0).length / list.length : null,
    tiers: count(list.map((m) => m.tier)),
    outcomes,
    falsePositiveRate: decided ? (outcomes[FALSE_POSITIVE_TAG] ?? 0) / decided : null,
    waived: list.filter((m) => m.waived).length,
    reverts,
    fixPrs,
  };
}

const fmt = (v, digits = 1) => (v === null || v === undefined ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(digits));
const pct = (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(0)}%`);

/**
 * The weekly report (markdown) in `lang`.
 * @param ctx `{ since, until, lang, ai: reviewer display name, pr: "PR" | "MR" }`
 */
export function renderReport(a, { since, until, lang, ai, pr = "PR" }) {
  const row = (code, s, unit = "") => `| ${t(lang, code, { ai, pr })} | ${fmt(s.p50)}${unit} | ${fmt(s.p95)}${unit} |`;
  const hours = t(lang, "metrics.unit.hours");
  const tierName = (k) => (k === UNTIERED ? t(lang, "metrics.tier.untiered") : k);
  return [
    t(lang, "metrics.title", { since, until }),
    "",
    t(lang, "metrics.summary", { prs: a.prs, pr, zeroHuman: pct(a.zeroHumanShare) }),
    "",
    t(lang, "metrics.table.header"),
    "| --- | --- | --- |",
    row("metrics.row.approvals", a.approvals),
    row("metrics.row.humanComments", a.humanComments),
    row("metrics.row.leadHours", a.leadHours, hours),
    row("metrics.row.approvalWaitHours", a.approvalWaitHours, hours),
    row("metrics.row.aiRounds", a.aiRounds),
    "",
    t(lang, "metrics.tiers", { pairs: Object.entries(a.tiers).map(([k, v]) => [tierName(k), v]) }),
    "",
    t(lang, "metrics.outcomes", { ai, pairs: Object.entries(a.outcomes), tag: FALSE_POSITIVE_TAG, rate: pct(a.falsePositiveRate) }),
    "",
    t(lang, "metrics.waived", { n: a.waived, ai, pr }),
    "",
    t(lang, "metrics.guard", { reverts: a.reverts, fixPrs: a.fixPrs, pr }),
  ].join("\n");
}

/** Title and body of the issue that collects the weekly reports (created on first run). `doc`: where the definitions live. */
export function reportIssue(lang, { doc }) {
  return { title: t(lang, "metrics.issue.title"), body: t(lang, "metrics.issue.body", { doc }) };
}
