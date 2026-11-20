/**
 * Merge queue decisions (pure, no I/O) for queue mode "self": a queue built on the forge's API for repositories where
 * the forge's own merge queue is not available. The process and its I/O are in cli/merge-queue.mjs.
 *
 * Every decision returns data or `{ code, params }` (rendered by the message catalog in the project's language).
 * Machine-read tokens are language-neutral: the attempt counter at the start of the queue status (ATTEMPT_TOKEN) and the
 * waiver trailer in the merge commit (WAIVER_TRAILER, core/gate.mjs).
 */
import { statusDescription, WAIVER_TRAILER } from "./gate.mjs";
import { t } from "./messages/index.mjs";
import { DEFAULTS } from "./policy.mjs";

const item = (code, params = {}) => ({ code, params });

/**
 * Attempt counter at the start of the queue status description: `#<number> (<attempt>/<cap>) ` followed by localized
 * text. Read back by attemptsSoFar in any language.
 */
export const ATTEMPT_TOKEN = /^#(\d+) \((\d+)(?:\/\d+)?\) /;

/**
 * Merge-commit title in the Conventional-Commits shape: `feat(scope)!: merge PR #122 <title>`. A title without a type
 * prefix becomes `Merge PR #N <title>`. The "merge PR #N" part is localized.
 */
export function mergeCommitTitle(title, number, { lang = DEFAULTS.language, pr = "PR" } = {}) {
  const text = String(title ?? "").trim();
  const m = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/s.exec(text);
  if (!m) return `${t(lang, "queue.commit.title", { pr, number, start: true })} ${text}`;
  return `${m[1]}${m[2] ?? ""}${m[3] ?? ""}: ${t(lang, "queue.commit.title", { pr, number, start: false })} ${m[4]}`;
}

/** Checks the queue waits for: the required ones plus the skippable ones (which may also conclude skipped / neutral). */
export function queueChecks(required = DEFAULTS.checks.required, skippable = DEFAULTS.checks.skippable) {
  return [...new Set([...required, ...skippable])];
}

/**
 * Readiness of one change.
 * @param input.checkRuns  check runs on the head: `{ name, id, status, conclusion }`.
 * @param input.gate       the queue's own re-judge of this change (gateVerdict); absent ⇒ wait.
 * @param input.branch     target branch (wording only).
 * @returns `{ state: 'ready' | 'wait' | 'eject', code, params }`
 */
export function readiness({
  fromFork = false,
  draft = false,
  conflicted = false,
  checkRuns = [],
  gate,
  required = DEFAULTS.checks.required,
  skippable = DEFAULTS.checks.skippable,
  branch,
  gateContext = DEFAULTS.names.gateContext,
  prTerm = "PR",
}) {
  // A fork's code would run in this repository's CI (on the candidate branch) with the repository's permissions.
  if (fromFork) return { state: "eject", ...item("queue.eject.fork", { pr: prTerm }) };
  if (draft) return { state: "wait", ...item("queue.wait.draft") };
  if (conflicted) return { state: "eject", ...item("queue.eject.conflict", { branch }) };
  for (const name of queueChecks(required, skippable)) {
    // A check with the same name may have run several times: the latest (highest id) counts.
    const run = checkRuns.filter((c) => c.name === name).sort((a, b) => b.id - a.id)[0];
    if (!run) return { state: "wait", ...item("queue.wait.checkMissing", { name }) };
    if (run.status !== "completed") return { state: "wait", ...item("queue.wait.checkRunning", { name }) };
    // Only skippable checks may pass by being skipped; a skipped required check (e.g. tests skipped for a fork) fails.
    const passing = run.conclusion === "success" || (skippable.includes(name) && ["skipped", "neutral"].includes(run.conclusion));
    if (!passing) return { state: "eject", ...item("queue.eject.checkFailed", { name, conclusion: run.conclusion }) };
  }
  if (!gate?.ok) return { state: "wait", ...(gate?.code ? item(gate.code, gate.params) : item("queue.wait.gatePending", { gate: gateContext })) };
  return { state: "ready", ...item("queue.ready") };
}

/**
 * Can the queue's re-judge let this change through? judgeChange loads by number, so it judged THIS change; here we also
 * check that the head and the target branch did not move around the load, and compare with the stored gate status
 * written by the CI identity (`data.gateStatus`, the one the branch protection reads). Statuses are stored per commit:
 * two changes on one commit share one result, so the stored status alone is not enough.
 * @param judged  judgeChange's `{ result, data }`
 * @param pr      the queued change `{ number, headSha }`
 * @returns `{ ok, code, params, refresh, waiver? }`; refresh = the stored status disagrees, ask the gate workflow to re-run.
 */
export function gateVerdict({ result, data }, pr, branch, { policy = DEFAULTS, prTerm = "PR", now = Date.now() } = {}) {
  const gate = policy.names.gateContext;
  if (data.headSha !== pr.headSha) return { ok: false, ...item("queue.gate.newCommits", { pr: prTerm }), refresh: false };
  if (data.baseRef !== branch) return { ok: false, ...item("queue.gate.otherBase", { actual: data.baseRef, branch }), refresh: false };
  const stored = data.gateStatus;
  // A pending status younger than gatePendingStaleMin: the gate is running; older: that run died, ask again.
  if (stored?.state === "pending" && now - Date.parse(stored.createdAt ?? "") < policy.queue.gatePendingStaleMin * 60_000) {
    return { ok: false, ...item("queue.gate.running", { gate }), refresh: false };
  }
  const description = statusDescription(result, { lang: policy.language, gate, pr: prTerm });
  const refresh = stored?.state !== (result.ok ? "success" : "failure") || stored?.description !== description;
  if (!result.ok) return { ok: false, ...item("queue.gate.unmet", { gate, n: result.missing.length, first: result.missing[0] }), refresh };
  if (refresh) return { ok: false, ...item("queue.gate.staleStatus", { gate }), refresh };
  // A change whose AI review was waived records who waived it in the merge commit.
  const waiver = result.aiReview?.waived ? result.aiReview.waiver : null;
  return { ok: true, ...item("queue.gate.ok", { gate, tier: result.tier }), refresh: false, waiver };
}

/**
 * Merge-commit message: which target-branch commit CI was re-run on; a waived AI review adds a localized line and the
 * language-neutral trailer `AI-Review-Waived: <by> <at>` (metrics count it; a merge commit cannot be edited later, unlike
 * comments and labels). Logins are written plain or in backticks, never with @: nobody needs a notification from a commit.
 */
export function mergeCommitMessage({ branch, base, ciUrl, waiver, waiverCommand = DEFAULTS.commands.waiver, lang = DEFAULTS.language }) {
  const lines = [t(lang, "queue.commit.body", { branch, sha: base, url: ciUrl })];
  if (waiver) {
    lines.push("", t(lang, "queue.commit.waived", { by: waiver.by, at: waiver.at, cmd: waiverCommand }));
    lines.push("", `${WAIVER_TRAILER} ${waiver.by ?? "?"}${waiver.at ? ` ${waiver.at}` : ""}`);
  }
  return lines.join("\n");
}

/** Queue status description with the attempt counter: `#<number> (<attempt>/<cap>) <text>`. */
export function attemptNote(number, attempt, text, cap = null) {
  return `#${number} (${attempt}${cap ? `/${cap}` : ""}) ${text}`;
}

/**
 * How many times this change was tested in a row on its current head: read from the head's latest queue status.
 * Another change's counter, or a status that is not pending ⇒ 0.
 */
export function attemptsSoFar(status, number) {
  if (status?.state !== "pending") return 0;
  const m = ATTEMPT_TOKEN.exec(String(status.description ?? ""));
  return m && Number(m[1]) === Number(number) ? Number(m[2]) : 0;
}

/**
 * After CI: red ⇒ 'eject'; green and the target branch did not move ⇒ 'merge';
 * it moved ⇒ 'retry' below the cap, 'give-up' at it (stop re-testing and eject).
 */
export function afterCi({ conclusion, baseMoved, attempt, cap = DEFAULTS.queue.maxAttempts }) {
  if (conclusion !== "success") return "eject";
  if (!baseMoved) return "merge";
  return attempt >= cap ? "give-up" : "retry";
}

/** Queue order: labeled changes by number, ascending (roughly first come, first served, and deterministic). */
export function queueOrder(prs, label = DEFAULTS.names.queueLabel) {
  return prs.filter((p) => p.labels?.some((l) => l.name === label)).sort((a, b) => a.number - b.number);
}

/**
 * What to do after one change. A run waits for CI at most once (the queue job's time limit covers one CI run):
 * no CI waited for (not ready, ejected on a conflict) ⇒ 'next', look at the next one; CI waited for ⇒ this run ends,
 * and when the target branch moved (retry) or more changes are queued ⇒ 'dispatch' another run, else 'stop'.
 * @param result     `{ outcome: 'merged' | 'retry' | 'ejected' | 'waiting', ranCi }`
 * @param remaining  how many queued changes come after this one
 */
export function afterProcessing({ outcome, ranCi }, remaining) {
  if (!ranCi) return "next";
  return outcome === "retry" || remaining > 0 ? "dispatch" : "stop";
}

/**
 * Issues the change closes (`Closes #n`) that the queue must close itself after merging: still open, in this repository.
 * @param refs `{ number, state, repository: { nameWithOwner } }` (GitHub closingIssuesReferences nodes)
 */
export function issuesToClose(refs, repo) {
  return (refs ?? [])
    .filter((i) => i.state === "OPEN" && String(i.repository?.nameWithOwner ?? "").toLowerCase() === String(repo).toLowerCase())
    .map((i) => i.number);
}

/**
 * Can it still merge after waiting for CI? `latest` is the change reloaded (`{ state, headSha, baseRef, labels }`).
 * @returns null when it can, else `{ code, params }`
 */
export function mergeBlocker(latest, testedHead, branch, { label = DEFAULTS.names.queueLabel, prTerm = "PR" } = {}) {
  if (latest.state !== "open") return item("queue.block.closed", { pr: prTerm });
  if (latest.headSha !== testedHead) return item("queue.block.newCommits", { pr: prTerm });
  if (latest.baseRef !== branch) return item("queue.block.otherBase", { actual: latest.baseRef });
  if (!latest.labels?.some((l) => l.name === label)) return item("queue.block.unlabeled", { label });
  return null;
}

/** Temporary branch the candidate (target branch + change) is built on. */
export function candidateBranch(policy, number) {
  return `${policy.queue.branchPrefix ?? `${policy.names.queueContext}/pr-`}${number}`;
}

/**
 * How many first parents to walk back from the merged commit to reach the target branch as it was before the merge:
 * one for a merge or squash commit; the change's commit count for a rebase (each commit is replayed).
 */
export function mergedBaseDepth(mergeMethod, commits) {
  return mergeMethod === "rebase" && Number.isInteger(commits) && commits > 0 ? commits : 1;
}
