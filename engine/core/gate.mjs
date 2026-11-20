/**
 * risk-gate decisions (pure, no I/O). Layer 5 of the Claude Code team's review model: humans scale with risk.
 *
 * 1. The tier comes from the change: a highPaths hit ⇒ high; only lowOnlyPaths ⇒ low; otherwise medium; non-doc changes
 *    over sizeThresholdLines are at least medium. The AI classifier's second opinion may only RAISE the tier, so a prompt
 *    injection in the PR can at worst make the gate stricter.
 * 2. People: low needs none; other tiers need the author's sign-off (`<signoff> <head sha>`, posted by the author) plus
 *    (tier humans − 1) approvals from others; an untrusted author needs untrustedExtraApprovals more. Approvals count only on
 *    the head commit, from accounts with write access; the AI reviewer and bots never count.
 * 3. "Changes requested" blocks until that reviewer reviews again.
 * 4. Every inline thread the AI opened needs an answer: the code moved (thread outdated), or a human reply starting with
 *    a tag (fixed: / wrong: / intended: / wontfix:). Resolving threads is the branch protection's job.
 * 5. After reviewRoundCap AI rounds with unanswered comments, post once: stop and reconsider the approach (does not block).
 * 6. Every tier needs a REAL AI review of the head commit (notices about quota or errors don't count, nor count as
 *    rounds). When the reviewer is down or out of quota, someone with write access comments `<waiver> <head sha>` and the
 *    gate requires aiReviewWaiverExtraApprovals more approvals instead. Like sign-off it binds to a commit and is revoked by
 *    deleting or editing the comment. One person cannot waive for themselves alone: the extra approval is someone else's.
 * 7. A change of the target branch voids AI reviews, sign-offs, approvals and waivers made before it (the head is the
 *    same, the diff is not). When all real reviews of the head predate it, the CLI re-requests the AI review.
 */
import { posix } from "node:path";

import { TIERS, rank } from "./policy.mjs";
import { t, tr } from "./messages/index.mjs";

/** Merge-commit trailer the queue writes when the AI review was waived; metrics count it. Language-neutral by design. */
export const WAIVER_TRAILER = "AI-Review-Waived:";

const COUNTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const matchesAny = (file, globs) => globs.some((g) => posix.matchesGlob(file, g));
const onCommit = (headSha, sha) => headSha.toLowerCase().startsWith(sha.toLowerCase());
const item = (code, params = {}) => ({ code, params });

/** Bots never count as people: Bot type, `[bot]` logins, and the AI reviewer's accounts. */
export function isBot(login, type, reviewer = null) {
  return type === "Bot" || /\[bot\]$/i.test(login ?? "") || Boolean(reviewer?.isReviewer(login));
}

/** files: `{ filename, previous_filename?, additions, deletions }` (GitHub REST shape; the GitLab adapter maps to it). */
export function computeTier(files, policy, { pr = "PR" } = {}) {
  const paths = files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  const reasons = [];
  let tier;
  const high = paths.filter((p) => matchesAny(p, policy.highPaths));
  if (high.length) {
    tier = "high";
    reasons.push(item("tier.high", { paths: high }));
  } else if (paths.every((p) => matchesAny(p, policy.lowOnlyPaths))) {
    tier = "low";
    reasons.push(item(paths.length ? "tier.docsOnly" : "tier.empty"));
  } else {
    tier = "medium";
    reasons.push(item("tier.medium"));
  }
  const lines = files.filter((f) => !matchesAny(f.filename, policy.sizeExcludedPaths)).reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  if (lines > policy.sizeThresholdLines) {
    if (rank(tier) < rank("medium")) tier = "medium";
    reasons.push(item("tier.size", { lines, threshold: policy.sizeThresholdLines, pr }));
  }
  return { tier, reasons, changedLines: lines };
}

/**
 * Command lines in comments (shared by sign-off and waiver): every line starting with `<command> <sha>` (sha ≥ 7 hex),
 * in comment and line order; bots excluded. The time is the comment's last edit.
 * Known limit: people with write access can edit others' comments and the API does not say who edited; attribution is
 * by comment author.
 */
export function commandLines(comments, command, reviewer = null) {
  const escaped = String(command).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s+([0-9a-f]{7,40})\\b`, "gim");
  const out = [];
  for (const c of comments) {
    if (isBot(c.login, c.type, reviewer)) continue;
    for (const m of String(c.body ?? "").matchAll(re)) out.push({ login: c.login, sha: m[1], at: c.updatedAt ?? c.createdAt ?? null });
  }
  return out;
}

/** After the latest target-branch change: no change ⇒ always; otherwise strictly later, unknown times don't count. */
export function afterBaseChange(at, baseChangedAt) {
  if (!baseChangedAt) return true;
  const ts = Date.parse(at ?? "");
  return Number.isFinite(ts) && ts > Date.parse(baseChangedAt);
}

/** Latest valid time, or null. */
export function latestTime(...times) {
  const valid = times.filter((x) => Number.isFinite(Date.parse(x ?? "")));
  return valid.length ? valid.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
}

/** Re-request the AI review: all real reviews of the head predate the base change, and it is not requested already. */
export function needAiRerequest(aiReview, requestedLogins, reviewer) {
  return Boolean(aiReview?.staleBase) && reviewer.rerequestable !== false && !reviewer.isRequested(requestedLogins ?? []);
}

/** The author's sign-off of the head; signed an older commit ⇒ `{ stale }`; before the base change ⇒ `{ stale, beforeBase }`. */
export function findSignoff(comments, author, headSha, baseChangedAt = null, command = "/signoff", reviewer = null) {
  let stale = null;
  let beforeBase = false;
  for (const l of commandLines(comments, command, reviewer)) {
    if (l.login !== author) continue;
    if (onCommit(headSha, l.sha) && afterBaseChange(l.at, baseChangedAt)) return { sha: l.sha, at: l.at };
    stale = l.sha;
    beforeBase ||= onCommit(headSha, l.sha);
  }
  return stale ? { stale, ...(beforeBase ? { beforeBase: true } : {}) } : null;
}

/**
 * Latest effective review per non-author human (COMMENTED is not a stance).
 * @param writers        accounts with write access; absent ⇒ fall back to author_association (offline use only).
 * @param baseChangedAt  approvals before the latest base change don't count.
 */
export function tallyReviews(reviews, author, headSha, writers, baseChangedAt = null, reviewer = null) {
  const latest = new Map();
  const ordered = [...reviews].sort((a, b) => String(a.submittedAt ?? "").localeCompare(String(b.submittedAt ?? "")));
  for (const r of ordered) {
    if (!r.login || r.login === author || isBot(r.login, r.type, reviewer)) continue;
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) continue;
    latest.set(r.login, r);
  }
  const approvers = [];
  const staleApprovers = [];
  const baseStaleApprovers = [];
  const uncountedApprovers = [];
  const changesRequestedBy = [];
  for (const [login, r] of latest) {
    if (r.state === "CHANGES_REQUESTED") changesRequestedBy.push(login);
    else if (r.state !== "APPROVED") continue;
    else if (r.commitId !== headSha) staleApprovers.push(login);
    else if (!afterBaseChange(r.submittedAt, baseChangedAt)) baseStaleApprovers.push(login);
    else if (writers ? !writers.has(login) : !COUNTED_ASSOCIATIONS.has(r.association)) uncountedApprovers.push(login);
    else approvers.push(login);
  }
  return { approvers, staleApprovers, baseStaleApprovers, uncountedApprovers, changesRequestedBy };
}

/** Reply head normalized (trim, lower-case, full-width colon to ASCII) to read the tags. */
export const normalizeReply = (s) => String(s ?? "").trim().toLowerCase().replace("：", ":");

/** Which tag a reply starts with (without the colon), or null. Shared with metrics. */
export function replyTagOf(body, tags) {
  const head = normalizeReply(body);
  const tag = tags.find((x) => head.startsWith(x));
  return tag ? tag.replace(/:$/, "") : null;
}

/** Threads opened by the AI reviewer that are neither outdated nor answered by a human with a tag. */
export function unansweredAiThreads(threads, tags, reviewer) {
  return threads.filter((th) => {
    const [first, ...replies] = th.comments ?? [];
    if (!first || !reviewer.isReviewer(first.login)) return false;
    if (th.isOutdated) return false;
    return !replies.some((c) => !isBot(c.login, c.type, reviewer) && replyTagOf(c.body, tags) !== null);
  });
}

/** First sentence of a notice (quoted in the gate comment). */
export function firstSentence(body, max = 160) {
  const text = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  // A CJK full stop needs no space after it; an ASCII one does (keeps v1.2 and e.g. intact).
  const first = text.split(/(?<=[。！？])|(?<=[.!?])\s/)[0] ?? "";
  return first.replace(/\s+/g, " ").slice(0, max);
}

/**
 * Has the AI reviewed the head for real; if not, does a waiver apply.
 * @param aiReviews      normalized `{ login, commitId, submittedAt, body, real }` (reviewer.aiReviews)
 * @param waiver         `{ by, at, counted, stale?, beforeBase? }` | null (pickWaiver)
 */
export function aiReviewState(aiReviews, headSha, waiver, baseChangedAt = null) {
  const realOnHead = aiReviews.filter((r) => r.commitId === headSha && r.real);
  const reviewedHead = realOnHead.some((r) => afterBaseChange(r.submittedAt, baseChangedAt));
  const latestNotice = aiReviews
    .filter((r) => r.commitId === headSha && !r.real && afterBaseChange(r.submittedAt, baseChangedAt))
    .sort((a, b) => String(a.submittedAt ?? "").localeCompare(String(b.submittedAt ?? "")))
    .at(-1);
  return {
    reviewedHead,
    staleBase: !reviewedHead && realOnHead.length > 0,
    // "" = a notice with an empty body (rendered as a placeholder); null = no notice
    notice: reviewedHead || !latestNotice ? null : firstSentence(latestNotice.body),
    waived: !reviewedHead && Boolean(waiver?.counted),
    waiver: waiver ?? null,
  };
}

/**
 * @param input.policy      withDefaults() policy
 * @param input.reviewer    reviewer adapter
 * @param input.aiReviews   optional; default reviewer.aiReviews({ reviews, comments })
 * @param input.classifier  `{ tier, reason }` | null — the AI second opinion for the head
 * @param input.waiver      pickWaiver() result | null
 * @param input.pr          "PR" | "MR" (wording only)
 */
export function evaluate({
  policy,
  reviewer,
  author,
  headSha,
  files,
  reviews,
  aiReviews = null,
  comments,
  threads,
  classifier = null,
  writers,
  waiver = null,
  baseChangedAt = null,
  pr = "PR",
}) {
  const ai = reviewer.displayName;
  const normalizedAi = aiReviews ?? reviewer.aiReviews({ reviews, comments });
  const base = computeTier(files, policy, { pr });
  let tier = base.tier;
  const reasons = [...base.reasons];
  if (classifier && TIERS.includes(classifier.tier)) {
    if (rank(classifier.tier) > rank(tier)) {
      tier = classifier.tier;
      reasons.push(item("classifier.raised", { ai, tier, reason: classifier.reason }));
    } else {
      reasons.push(item("classifier.notHigher", { ai, tier: classifier.tier }));
    }
  } else {
    reasons.push(item("classifier.none", { ai }));
  }
  if (baseChangedAt) reasons.push(item("base.changed", { at: baseChangedAt, ai }));

  const trusted = policy.trustedAuthors.includes(author);
  const aiReview = aiReviewState(normalizedAi, headSha, waiver, baseChangedAt);
  const humans = policy.requiredHumans[tier];
  const needSignoff = humans >= 1;
  const needOthers = Math.max(0, humans - 1) + (trusted ? 0 : policy.untrustedExtraApprovals) + (aiReview.waived ? policy.aiReviewWaiverExtraApprovals : 0);

  const signoff = findSignoff(comments, author, headSha, baseChangedAt, policy.commands.signoff, reviewer);
  const signed = Boolean(signoff && !signoff.stale);
  const tally = tallyReviews(reviews, author, headSha, writers, baseChangedAt, reviewer);
  const unanswered = unansweredAiThreads(threads, policy.threadReplyTags, reviewer);
  // Rounds count real reviews only, and only after the base change.
  const aiRounds = normalizedAi.filter((r) => r.real && afterBaseChange(r.submittedAt, baseChangedAt)).length;

  const short = headSha.slice(0, 12);
  const missing = [];
  if (!aiReview.reviewedHead && !aiReview.waived) {
    const w = aiReview.waiver;
    const ignored = w?.beforeBase ? item("waiver.beforeBase") : w?.stale ? item("waiver.stale", { sha: w.stale }) : w && !w.counted ? item("waiver.uncounted", { by: w.by }) : null;
    missing.push(
      item("missing.aiReview", {
        ai,
        reviewer: reviewer.id,
        sha: headSha,
        queueLabel: policy.names.queueLabel,
        staleBase: aiReview.staleBase,
        notice: aiReview.notice,
        ignored,
        cmd: `${policy.commands.waiver} ${short}`,
        extra: policy.aiReviewWaiverExtraApprovals,
      }),
    );
  }
  if (needSignoff && !signed) {
    missing.push(
      item("missing.signoff", {
        author,
        cmd: `${policy.commands.signoff} ${short}`,
        prev: signoff?.beforeBase ? "beforeBase" : signoff?.stale ? "stale" : null,
        staleSha: signoff?.stale ?? null,
      }),
    );
  }
  if (tally.approvers.length < needOthers) {
    const notes = [];
    if (!trusted) notes.push(item("note.untrusted"));
    if (aiReview.waived) notes.push(item("note.waived", { by: aiReview.waiver.by, cmd: policy.commands.waiver, extra: policy.aiReviewWaiverExtraApprovals }));
    if (tally.staleApprovers.length) notes.push(item("note.staleApprovers", { logins: tally.staleApprovers }));
    if (tally.baseStaleApprovers.length) notes.push(item("note.baseStaleApprovers", { logins: tally.baseStaleApprovers }));
    if (tally.uncountedApprovers.length) notes.push(item("note.uncountedApprovers", { logins: tally.uncountedApprovers }));
    missing.push(item("missing.approvals", { n: needOthers - tally.approvers.length, sha: headSha, notes }));
  }
  if (tally.changesRequestedBy.length) missing.push(item("missing.changesRequested", { logins: tally.changesRequestedBy }));
  if (unanswered.length) missing.push(item("missing.unanswered", { ai, n: unanswered.length, tags: policy.threadReplyTags }));

  return {
    tier,
    reasons,
    trusted,
    humans,
    needSignoff,
    needOthers,
    signed,
    signoff,
    ...tally,
    unanswered,
    aiRounds,
    aiReview,
    rethink: aiRounds >= policy.reviewRoundCap && unanswered.length > 0,
    missing,
    ok: missing.length === 0,
  };
}

/** Commit status description (GitHub caps it at 140 characters; the forge truncates). */
export function statusDescription(r, { lang, gate = "risk-gate", pr = "PR" }) {
  return r.ok ? t(lang, "status.ok", { tier: r.tier, humans: r.humans }) : t(lang, "status.missing", { tier: r.tier, n: r.missing.length, gate, pr });
}

/** Text of a decision's reasons and missing items (for logs and tests). */
export function explain(r, lang) {
  return { reasons: r.reasons.map((x) => tr(lang, x)), missing: r.missing.map((x) => tr(lang, x)) };
}

function aiStateText(lang, a) {
  if (a.reviewedHead) return t(lang, "render.ai.reviewed");
  if (a.waived) return t(lang, "render.ai.waived", { by: a.waiver.by, at: a.waiver.at });
  return t(lang, "render.ai.pending");
}

/**
 * The sticky gate comment (markdown).
 * @param ctx `{ lang, gate, ai, queueMode, queueLabel, base, config }`
 */
export function render(r, headSha, ctx) {
  const { lang } = ctx;
  const lines = [
    t(lang, "render.title", { gate: ctx.gate ?? "risk-gate", tier: r.tier, humans: r.humans, trusted: r.trusted, sha: headSha }),
    "",
    ...r.reasons.map((x) => `- ${tr(lang, x)}`),
    t(lang, "render.signoff", { needed: r.needSignoff, signed: r.signed, sha: r.signoff?.sha }),
    t(lang, "render.approvals", { have: r.approvers.length, need: r.needOthers, logins: r.approvers }),
    t(lang, "render.ai", { ai: ctx.ai, rounds: r.aiRounds, state: aiStateText(lang, r.aiReview), unanswered: r.unanswered.length }),
    "",
  ];
  if (r.ok) {
    const mode = ctx.queueMode ?? "self";
    lines.push(t(lang, `render.ok.${mode}`, { queueLabel: ctx.queueLabel ?? "merge-queue", base: ctx.base ?? "main" }));
  } else {
    lines.push(t(lang, "render.missing"), ...r.missing.map((m) => `- [ ] ${tr(lang, m)}`));
  }
  if (r.unanswered.length) {
    lines.push("", `<details><summary>${t(lang, "render.unanswered", { ai: ctx.ai })}</summary>`, "");
    for (const th of r.unanswered.slice(0, 20)) {
      const first = th.comments[0];
      const excerpt = String(first.body ?? "").replace(/\s+/g, " ").slice(0, 80);
      lines.push(`- ${th.path ?? ""}${th.line ? `:${th.line}` : ""} ${first.url ? `[${t(lang, "render.link")}](${first.url}) ` : ""}${excerpt}`);
    }
    lines.push("", "</details>");
  }
  lines.push("", t(lang, "render.footer", { config: ctx.config ?? ".dev-process/config.json" }));
  return lines.join("\n");
}

/** Second opinion statuses are trusted only from the CI identity (someone with a personal token must not lower the tier). */
export function trustedClassifier(statuses, { context = "risk-classifier", creator = "github-actions[bot]" } = {}) {
  const s = statuses.find((x) => x.context === context && x.creator?.login === creator);
  return s ? parseClassifierStatus(s.description) : null;
}

/** The latest gate status written by the CI identity: `{ state, description, createdAt }`. */
export function trustedGateStatus(statuses, { context = "risk-gate", creator = "github-actions[bot]" } = {}) {
  const s = statuses.find((x) => x.context === context && x.creator?.login === creator);
  return s ? { state: s.state, description: s.description, createdAt: s.created_at } : null;
}

/** Classifier status description: `high — reason`. */
export function parseClassifierStatus(description) {
  const m = /^(low|medium|high)\s*[—-]\s*(.*)$/s.exec(String(description ?? "").trim());
  return m ? { tier: m[1], reason: m[2] } : null;
}

/**
 * Waiver commands: like sign-off, read from comments (bots excluded), bound to a commit.
 * @returns `{ onHead: [{ by, at }] (oldest first), stale: sha | null, beforeBase }`
 */
export function waiverCommands(comments, headSha, command, baseChangedAt = null, reviewer = null) {
  const onHead = [];
  let stale = null;
  let beforeBase = false;
  for (const l of commandLines(comments, command, reviewer)) {
    if (!onCommit(headSha, l.sha)) stale = l.sha;
    else if (!afterBaseChange(l.at, baseChangedAt)) beforeBase = true;
    else onHead.push({ by: l.login, at: l.at });
  }
  return { onHead, stale, beforeBase };
}

/**
 * The waiver for the head: the latest by someone with write access counts; only by others ⇒ not counted (named);
 * only other shas ⇒ stale; nothing ⇒ null.
 */
export function pickWaiver({ onHead, stale, beforeBase = false }, waiverWriters) {
  const counted = onHead.filter((w) => waiverWriters.has(w.by));
  if (counted.length) return { ...counted.at(-1), counted: true };
  if (onHead.length) return { ...onHead.at(-1), counted: false };
  if (beforeBase) return { by: null, at: null, counted: false, beforeBase: true };
  return stale ? { by: null, at: null, counted: false, stale } : null;
}
