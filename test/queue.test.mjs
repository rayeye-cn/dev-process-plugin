// Merge queue: decisions (ported from the reference implementation's mergeQueue tests; asserts codes, renders both
// languages) and the CLI orchestration against an in-memory GitHub forge.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../engine/cli/args.mjs";
import { runQueue } from "../engine/cli/merge-queue.mjs";
import { evaluate, isBot, statusDescription, WAIVER_TRAILER } from "../engine/core/gate.mjs";
import { t, tr } from "../engine/core/messages/index.mjs";
import * as queue from "../engine/core/queue.mjs";
import { copilot } from "../engine/reviewer/copilot.mjs";
import { AUTHOR, file, HEAD, policy } from "./helpers.mjs";

const ok = (name, id = 1, conclusion = "success") => ({ name, id, status: "completed", conclusion });
// Ported cases use a heavy release check that only runs for releases (skippable); the fixture policy has none.
const CHECKS = { required: ["checks", "tests"], skippable: ["release-gate"] };
const allGreen = () => [ok("checks"), ok("tests"), ok("release-gate", 1, "skipped")];
const en = { ...policy, language: "en" };

describe("merge-commit title keeps the Conventional-Commits shape", () => {
  it("with a type prefix ⇒ 'merge PR #N' goes after the prefix (scope and ! kept)", () => {
    assert.equal(queue.mergeCommitTitle("feat: report installs and usage (#121)", 122), "feat: 合并 PR #122 report installs and usage (#121)");
    assert.equal(queue.mergeCommitTitle("fix(update): never downgrade", 5), "fix(update): 合并 PR #5 never downgrade");
    assert.equal(queue.mergeCommitTitle("fix(update): never downgrade", 5, { lang: "en" }), "fix(update): merge PR #5 never downgrade");
    assert.equal(queue.mergeCommitTitle("feat(api)!: drop v1", 9, { lang: "en" }), "feat(api)!: merge PR #9 drop v1");
  });

  it("without a type prefix ⇒ 'Merge PR #N <title>'; the term and the reference are the forge's (GitLab: MR !N)", () => {
    assert.equal(queue.mergeCommitTitle("any title", 7), "合并 PR #7 any title");
    assert.equal(queue.mergeCommitTitle("any title", 7, { lang: "en" }), "Merge PR #7 any title");
    assert.equal(queue.mergeCommitTitle("  any title ", 3, { lang: "zh", pr: "MR" }), "合并 MR !3 any title");
  });
});

describe("readiness", () => {
  const base = { draft: false, conflicted: false, checkRuns: allGreen(), gate: { ok: true }, branch: "main", ...CHECKS };

  it("all required checks pass (a skippable one may be skipped) and the gate passes ⇒ ready", () => {
    assert.deepEqual(queue.readiness(base), { state: "ready", code: "queue.ready", params: {} });
  });

  it("draft, a check not run or still running, the gate unmet ⇒ wait, not ejected", () => {
    assert.equal(queue.readiness({ ...base, draft: true }).code, "queue.wait.draft");
    assert.deepEqual(queue.readiness({ ...base, checkRuns: [ok("checks"), ok("release-gate")] }), { state: "wait", code: "queue.wait.checkMissing", params: { name: "tests" } });
    const running = queue.readiness({ ...base, checkRuns: [ok("checks"), { name: "tests", id: 2, status: "in_progress", conclusion: null }, ok("release-gate")] });
    assert.deepEqual(running, { state: "wait", code: "queue.wait.checkRunning", params: { name: "tests" } });
    const unmet = { ok: false, code: "queue.gate.unmet", params: { gate: "risk-gate", n: 1, first: { code: "missing.signoff", params: {} } } };
    assert.deepEqual(queue.readiness({ ...base, gate: unmet }), { state: "wait", code: unmet.code, params: unmet.params });
    assert.deepEqual(queue.readiness({ ...base, gate: undefined }), { state: "wait", code: "queue.wait.gatePending", params: { gate: "risk-gate" } });
  });

  it("a PR from a fork never enters the queue (its code would run with the repository's permissions)", () => {
    assert.deepEqual(queue.readiness({ ...base, fromFork: true }), { state: "eject", code: "queue.eject.fork", params: { pr: "PR" } });
  });

  it("only skippable checks may pass by being skipped; a skipped required check (tests, for a fork) fails", () => {
    const r = queue.readiness({ ...base, checkRuns: [ok("checks"), ok("tests", 1, "skipped"), ok("release-gate", 1, "skipped")] });
    assert.deepEqual(r, { state: "eject", code: "queue.eject.checkFailed", params: { name: "tests", conclusion: "skipped" } });
    assert.equal(queue.readiness({ ...base, checkRuns: [ok("checks"), ok("tests"), ok("release-gate", 1, "neutral")] }).state, "ready");
  });

  it("a conflict or a failed required check ⇒ ejected", () => {
    assert.deepEqual(queue.readiness({ ...base, conflicted: true }), { state: "eject", code: "queue.eject.conflict", params: { branch: "main" } });
    assert.equal(queue.readiness({ ...base, checkRuns: [ok("checks"), ok("tests", 1, "failure"), ok("release-gate")] }).state, "eject");
  });

  it("a check that ran several times ⇒ the latest run counts", () => {
    const runs = [ok("checks"), ok("tests", 1, "failure"), ok("tests", 9, "success"), ok("release-gate")];
    assert.equal(queue.readiness({ ...base, checkRuns: runs }).state, "ready");
  });

  it("the checks come from the policy: required plus skippable (skippable ones must have run, maybe skipped)", () => {
    assert.deepEqual(queue.queueChecks(CHECKS.required, CHECKS.skippable), ["checks", "tests", "release-gate"]);
    assert.deepEqual(queue.queueChecks(["a", "b"], ["b"]), ["a", "b"]);
    assert.deepEqual(queue.queueChecks(), policy.checks.required);
    const { required, skippable, ...defaults } = base;
    assert.equal(queue.readiness({ ...defaults, checkRuns: [ok("checks"), ok("tests")] }).state, "ready");
  });

  it("after CI, before merging: closed, new commits, a changed target branch or a removed label block the merge", () => {
    const latest = { state: "open", headSha: "h", baseRef: "main", labels: [{ name: "merge-queue" }] };
    assert.equal(queue.mergeBlocker(latest, "h", "main"), null);
    assert.deepEqual(queue.mergeBlocker({ ...latest, state: "closed" }, "h", "main"), { code: "queue.block.closed", params: { pr: "PR" } });
    assert.deepEqual(queue.mergeBlocker({ ...latest, headSha: "x" }, "h", "main"), { code: "queue.block.newCommits", params: { pr: "PR" } });
    assert.deepEqual(queue.mergeBlocker({ ...latest, baseRef: "dev" }, "h", "main"), { code: "queue.block.otherBase", params: { actual: "dev" } });
    assert.deepEqual(queue.mergeBlocker({ ...latest, labels: [] }, "h", "main"), { code: "queue.block.unlabeled", params: { label: "merge-queue" } });
    assert.equal(queue.mergeBlocker({ ...latest, labels: [{ name: "ship-it" }] }, "h", "main", { label: "ship-it" }), null);
    assert.equal(tr("zh", queue.mergeBlocker({ ...latest, labels: [] }, "h", "main")), "merge-queue 标签已被摘掉");
    assert.equal(tr("en", queue.mergeBlocker({ ...latest, state: "closed" }, "h", "main", { prTerm: "MR" })), "the MR is closed");
  });

  it("one CI wait per run: after it the run ends whatever happened; it continues only when more are queued", () => {
    // no CI waited for (not ready, ejected on a conflict) ⇒ look at the next one
    assert.equal(queue.afterProcessing({ outcome: "waiting", ranCi: false }, 2), "next");
    assert.equal(queue.afterProcessing({ outcome: "ejected", ranCi: false }, 2), "next");
    // CI waited for: red and ejected, a failed pre-merge check, merged — all end the run; more queued ⇒ continue
    assert.equal(queue.afterProcessing({ outcome: "ejected", ranCi: true }, 1), "dispatch");
    assert.equal(queue.afterProcessing({ outcome: "waiting", ranCi: true }, 1), "dispatch");
    assert.equal(queue.afterProcessing({ outcome: "merged", ranCi: true }, 1), "dispatch");
    assert.equal(queue.afterProcessing({ outcome: "ejected", ranCi: true }, 0), "stop");
    assert.equal(queue.afterProcessing({ outcome: "merged", ranCi: true }, 0), "stop");
    // the target branch moved during the test ⇒ always another run to re-test
    assert.equal(queue.afterProcessing({ outcome: "retry", ranCi: true }, 0), "dispatch");
  });

  it("the queue takes labeled PRs only, by number ascending; the label comes from the policy", () => {
    const pr = (number, labels) => ({ number, labels: labels.map((name) => ({ name })) });
    const prs = [pr(9, ["merge-queue"]), pr(3, []), pr(4, ["merge-queue", "risk:high"]), pr(2, ["ship-it"])];
    assert.deepEqual(queue.queueOrder(prs).map((p) => p.number), [4, 9]);
    assert.deepEqual(queue.queueOrder(prs, "ship-it").map((p) => p.number), [2]);
  });
});

describe("re-judging each PR before testing and merging", () => {
  const NOW = Date.parse("2026-11-18T12:00:00Z");
  const signoff = [{ login: AUTHOR, type: "User", body: `/signoff ${HEAD.slice(0, 12)}` }];
  // A real AI review of the head: every tier needs one.
  const aiReal = { login: "copilot-pull-request-reviewer[bot]", type: "Bot", state: "COMMENTED", commitId: HEAD, submittedAt: "2026-11-18T10:00:00Z", body: "<!-- ccr-overview-v2 -->\noverview" };
  // Two branches on one commit, one PR each: statuses are stored per commit (shared); sign-offs and approvals per PR.
  const judge = (number, comments, gateStatus = null, over = {}) => {
    const data = { number, baseRef: "main", author: AUTHOR, headSha: HEAD, files: [file("src/host/a.tsx")], reviews: [aiReal], comments, threads: [], gateStatus, ...over };
    return { result: evaluate({ policy, reviewer: copilot, ...data }), data };
  };
  const pr = (number) => ({ number, headSha: HEAD });
  const opts = { policy, now: NOW };
  const desc = (r, p = policy) => statusDescription(r, { lang: p.language, gate: p.names.gateContext, pr: "PR" });
  const stored = (state, description, createdAt = "2026-11-18T11:00:00Z") => ({ state, description, createdAt });
  const satisfied = stored("success", desc(judge(1, signoff).result));

  it("two PRs on one commit, one signed: the shared success lets only the signed one through", () => {
    const signed = queue.gateVerdict(judge(1, signoff, satisfied), pr(1), "main", opts);
    const unsigned = queue.gateVerdict(judge(2, [], satisfied), pr(2), "main", opts);
    assert.deepEqual(signed, { ok: true, code: "queue.gate.ok", params: { gate: "risk-gate", tier: "medium" }, refresh: false, waiver: null });
    assert.equal(unsigned.ok, false);
    assert.equal(unsigned.code, "queue.gate.unmet");
    assert.equal(unsigned.params.first.code, "missing.signoff");
    assert.ok(tr("zh", unsigned).includes("/signoff"));
    assert.ok(tr("en", unsigned).startsWith("risk-gate re-evaluation not satisfied: Author @alice"));
    // The shared success is wrong for the unsigned PR: ask the gate workflow to re-judge THIS PR.
    assert.equal(unsigned.refresh, true);
    const checks = { draft: false, conflicted: false, checkRuns: allGreen(), branch: "main", ...CHECKS };
    assert.equal(queue.readiness({ ...checks, gate: signed }).state, "ready");
    assert.equal(queue.readiness({ ...checks, gate: unsigned }).state, "wait");
  });

  it("the re-judge passes but the stored status (the one the protection reads) is old or missing ⇒ not through, refresh", () => {
    const failed = stored("failure", "medium：还差 1 项，见 PR 里的 risk-gate 评论");
    assert.deepEqual(queue.gateVerdict(judge(1, signoff, failed), pr(1), "main", opts), { ok: false, code: "queue.gate.staleStatus", params: { gate: "risk-gate" }, refresh: true });
    assert.equal(queue.gateVerdict(judge(1, signoff, null), pr(1), "main", opts).refresh, true);
    // Unmet, and the stored status already says so ⇒ no need to ask again.
    const unmet = judge(2, [], null);
    const same = stored("failure", desc(unmet.result));
    const v = queue.gateVerdict(judge(2, [], same), pr(2), "main", opts);
    assert.equal(v.ok, false);
    assert.equal(v.refresh, false);
  });

  it("the stored description is compared in the project's language", () => {
    const enSatisfied = stored("success", desc(judge(1, signoff).result, en));
    assert.equal(enSatisfied.description, "medium: satisfied (1 person)");
    assert.equal(queue.gateVerdict(judge(1, signoff, enSatisfied), pr(1), "main", { policy: en, now: NOW }).ok, true);
    assert.equal(queue.gateVerdict(judge(1, signoff, satisfied), pr(1), "main", { policy: en, now: NOW }).refresh, true);
  });

  it("the gate is re-judging ⇒ wait for it; pending for too long means that run died, ask again", () => {
    const running = stored("pending", "重判中", new Date(NOW - 60_000).toISOString());
    assert.deepEqual(queue.gateVerdict(judge(1, signoff, running), pr(1), "main", opts), { ok: false, code: "queue.gate.running", params: { gate: "risk-gate" }, refresh: false });
    const staleMs = policy.queue.gatePendingStaleMin * 60_000;
    const dead = stored("pending", "重判中", new Date(NOW - staleMs - 1).toISOString());
    const v = queue.gateVerdict(judge(1, signoff, dead), pr(1), "main", opts);
    assert.equal(v.ok, false);
    assert.equal(v.refresh, true);
  });

  it("the head or the target branch changed around the load ⇒ not through, and no refresh", () => {
    const moved = queue.gateVerdict(judge(1, signoff, satisfied), { number: 1, headSha: "f".repeat(40) }, "main", opts);
    assert.deepEqual(moved, { ok: false, code: "queue.gate.newCommits", params: { pr: "PR" }, refresh: false });
    const j = judge(1, signoff, satisfied);
    const otherBase = queue.gateVerdict({ ...j, data: { ...j.data, baseRef: "dev" } }, pr(1), "main", opts);
    assert.deepEqual(otherBase, { ok: false, code: "queue.gate.otherBase", params: { actual: "dev", branch: "main" }, refresh: false });
    assert.equal(tr("zh", otherBase), "目标分支是 dev，不是 main");
  });

  it("a PR whose AI review was waived: the verdict names who waived it; the merge commit records it as a trailer", () => {
    const notice = { ...aiReal, body: "Copilot was unable to review this pull request because the user who requested the review has insufficient remaining quota." };
    const waiver = { by: "carol", at: "2026-11-19T08:00:00Z", counted: true };
    const approval = { login: "bob", type: "User", state: "APPROVED", commitId: HEAD, submittedAt: "2026-11-19T09:00:00Z", association: "MEMBER" };
    const over = { reviews: [notice, approval], waiver };
    const status = stored("success", desc(judge(1, signoff, null, over).result));
    const v = queue.gateVerdict(judge(1, signoff, status, over), pr(1), "main", opts);
    assert.equal(v.ok, true);
    assert.deepEqual(v.waiver, waiver);
    // not waived ⇒ none
    assert.equal(queue.gateVerdict(judge(1, signoff, satisfied), pr(1), "main", opts).waiver, null);

    const msg = queue.mergeCommitMessage({ branch: "main", base: "07c3c3f3abcdef", ciUrl: "https://x/runs/1", waiver, waiverCommand: policy.commands.waiver, lang: "zh" });
    const lines = msg.split("\n");
    assert.equal(lines[0], "合并队列在 main@07c3c3f 上重跑 CI 通过：https://x/runs/1");
    assert.ok(msg.includes(`AI 评审已豁免：\`carol\` 于 2026-11-19T08:00:00Z 发了 \`${policy.commands.waiver}\``));
    // a git trailer: last paragraph, language-neutral key
    assert.equal(lines.at(-2), "");
    assert.equal(lines.at(-1), `${WAIVER_TRAILER} carol 2026-11-19T08:00:00Z`);
    assert.equal(lines.at(-1), "AI-Review-Waived: carol 2026-11-19T08:00:00Z");
    assert.ok(!msg.includes("@carol"));
    const enMsg = queue.mergeCommitMessage({ branch: "main", base: "07c3c3f3abcdef", ciUrl: "u", waiver, waiverCommand: "/waive", lang: "en" });
    assert.equal(enMsg.split("\n")[0], "Merge queue re-ran CI on main@07c3c3f and it passed: u");
    assert.equal(enMsg.split("\n").at(-1), "AI-Review-Waived: carol 2026-11-19T08:00:00Z");
    const plain = queue.mergeCommitMessage({ branch: "main", base: "07c3c3f3abcdef", ciUrl: "u", waiver: null, waiverCommand: "x", lang: "zh" });
    assert.ok(!plain.includes("豁免"));
    assert.ok(!plain.includes(WAIVER_TRAILER));
  });
});

describe("re-test cap when the target branch keeps moving", () => {
  it("the count lives in this PR's queue status description, language-neutral; another PR's count or a non-pending status ⇒ 0", () => {
    const note = queue.attemptNote(130, 2, t("zh", "queue.status.testing", { branch: "main", sha: "abc1234ffff" }), 3);
    assert.equal(note, "#130 (2/3) 在 main@abc1234 上重跑 CI");
    assert.equal(queue.attemptsSoFar({ state: "pending", description: note }, 130), 2);
    assert.equal(queue.attemptsSoFar({ state: "pending", description: note }, 13), 0);
    assert.equal(queue.attemptsSoFar({ state: "failure", description: note }, 130), 0);
    assert.equal(queue.attemptsSoFar({ state: "pending", description: t("zh", "queue.status.notMerged", { why: { code: "queue.block.newCommits", params: { pr: "PR" } } }) }, 130), 0);
    assert.equal(queue.attemptsSoFar(null, 130), 0);
    // written in one language, read in any
    const enNote = queue.attemptNote(130, 2, t("en", "queue.status.voided", { branch: "main" }), 3);
    assert.equal(enNote, "#130 (2/3) voided (main moved during the test), to be re-tested");
    assert.equal(queue.attemptsSoFar({ state: "pending", description: enNote }, 130), 2);
    assert.equal(queue.attemptsSoFar({ state: "pending", description: queue.attemptNote(130, 1, "x") }, 130), 1);
  });

  it("the target branch moved during every test: attempts 1 and 2 re-test, attempt 3 stops", () => {
    assert.equal(policy.queue.maxAttempts, 3);
    let status = null;
    const decisions = [];
    for (let run = 0; run < 5; run++) {
      const attempt = queue.attemptsSoFar(status, 130) + 1;
      const next = queue.afterCi({ conclusion: "success", baseMoved: true, attempt, cap: policy.queue.maxAttempts });
      decisions.push(next);
      if (next !== "retry") break;
      status = { state: "pending", description: queue.attemptNote(130, attempt, t("zh", "queue.status.voided", { branch: "main" }), 3) };
    }
    assert.deepEqual(decisions, ["retry", "retry", "give-up"]);
  });

  it("red CI ⇒ eject; green and the target branch did not move ⇒ merge", () => {
    assert.equal(queue.afterCi({ conclusion: "failure", baseMoved: false, attempt: 1 }), "eject");
    assert.equal(queue.afterCi({ conclusion: "timed_out", baseMoved: false, attempt: 3 }), "eject");
    assert.equal(queue.afterCi({ conclusion: "success", baseMoved: false, attempt: 3 }), "merge");
    assert.equal(queue.afterCi({ conclusion: "success", baseMoved: true, attempt: 1, cap: 1 }), "give-up");
  });
});

describe("after merging", () => {
  it("the queue closes the issues the PR links: only open ones in this repository (case-insensitive name)", () => {
    const repo = "acme/widgets";
    const refs = [
      { number: 137, state: "OPEN", repository: { nameWithOwner: repo } },
      { number: 131, state: "CLOSED", repository: { nameWithOwner: repo } },
      { number: 9, state: "OPEN", repository: { nameWithOwner: "acme/gadgets" } },
      { number: 140, state: "OPEN", repository: { nameWithOwner: "Acme/Widgets" } },
    ];
    assert.deepEqual(queue.issuesToClose(refs, repo), [137, 140]);
    assert.deepEqual(queue.issuesToClose(null, repo), []);
  });

  it("the merged commit's base is one first parent away, or the commit count for a rebase", () => {
    assert.equal(queue.mergedBaseDepth("merge", 4), 1);
    assert.equal(queue.mergedBaseDepth("squash", 4), 1);
    assert.equal(queue.mergedBaseDepth("rebase", 4), 4);
    assert.equal(queue.mergedBaseDepth("rebase", null), 1);
  });

  it("the candidate branch is named after the queue context unless the policy sets a prefix", () => {
    assert.equal(queue.candidateBranch(policy, 7), "merge-queue/pr-7");
    assert.equal(queue.candidateBranch({ ...policy, names: { ...policy.names, queueContext: "mq" } }, 7), "mq/pr-7");
    assert.equal(queue.candidateBranch({ ...policy, queue: { ...policy.queue, branchPrefix: "tmp/q-" } }, 7), "tmp/q-7");
  });
});

describe("queue texts", () => {
  it("render in both languages with nested reasons", () => {
    const why = { code: "queue.eject.checkFailed", params: { name: "tests", conclusion: "failure" } };
    assert.equal(t("zh", "queue.status.ejected", { why }), "出队：必需检查 tests 结论是 failure");
    assert.equal(t("en", "queue.status.ejected", { why }), "ejected: required check tests concluded failure");
    const unmet = { gate: "risk-gate", n: 3, first: { code: "missing.changesRequested", params: { logins: ["bob"] } } };
    assert.equal(t("zh", "queue.gate.unmet", unmet), "risk-gate 重判未满足（共 3 项）：@bob 要求修改：处理后请对方重新评审");
    assert.equal(t("en", "queue.gate.unmet", unmet), "risk-gate re-evaluation not satisfied (3 items): @bob requested changes: address them and ask for a re-review");
    assert.equal(
      t("en", "queue.comment.ejected", { why, label: "merge-queue", run: "https://run/1" }),
      "Merge queue: removed from the queue: required check tests concluded failure. Once fixed, add the `merge-queue` label again to re-queue.\n\nQueue run: https://run/1",
    );
    assert.equal(t("zh", "queue.comment.ejected", { why, label: "merge-queue" }), "合并队列：已出队——必需检查 tests 结论是 failure。处理后重新打 `merge-queue` 标签入队。");
  });
});

describe("shared helpers the queue CLI relies on", () => {
  it("argument parsing: without --repo, another flag is never taken as the repository name", () => {
    assert.deepEqual(parseArgs(["--dry-run"]), { _: [], "dry-run": true });
    assert.deepEqual(parseArgs(["prompt", "--pr", "5"]), { _: ["prompt"], pr: "5" });
    assert.equal(parseArgs(["--repo", "o/r", "--dry-run"]).repo, "o/r");
  });

  it("only the exact AI reviewer accounts are bots; a human called copilotdev is not", () => {
    assert.equal(copilot.isReviewer("copilot-pull-request-reviewer[bot]"), true);
    assert.equal(copilot.isReviewer("copilot-pull-request-reviewer"), true);
    assert.equal(copilot.isReviewer("Copilot"), true);
    assert.equal(isBot("copilotdev", "User", copilot), false);
    assert.equal(isBot("github-actions[bot]", "Bot", copilot), true);
  });
});

/* ───────────────────────────── CLI orchestration ───────────────────────────── */

const BASE = "1".repeat(40);
const MOVED = "2".repeat(40);
const CAND = "3".repeat(40);
const MERGED = "4".repeat(40);
const T0 = Date.parse("2026-11-20T00:00:00Z");
const OVERVIEW = "<!-- ccr-overview-v2 -->\nok";
const NOTICE = "Copilot was unable to review this pull request because the user who requested the review has insufficient remaining quota.";

const rawPull = (over = {}) => ({
  number: 7,
  title: "feat(api): add export",
  state: "open",
  head: { sha: HEAD, repo: { full_name: "o/r" } },
  base: { ref: "main" },
  labels: [{ name: "merge-queue" }],
  draft: false,
  mergeable_state: "clean",
  commits: 2,
  ...over,
});
const gateStatus = (description, state = "success") => ({ context: "risk-gate", state, description, creator: { login: "github-actions[bot]" }, created_at: "2026-11-18T10:00:00Z" });
const signedComment = { login: AUTHOR, type: "User", body: `/signoff ${HEAD.slice(0, 7)}`, createdAt: "2026-11-18T09:00:00Z" };
const aiReview = (body = OVERVIEW) => ({ login: "copilot-pull-request-reviewer[bot]", type: "Bot", state: "COMMENTED", commitId: HEAD, submittedAt: "2026-11-18T08:00:00Z", body });
const change = (over = {}) => ({
  number: 7,
  author: AUTHOR,
  headSha: HEAD,
  baseRef: "main",
  labels: [],
  files: [file("src/a.ts")],
  reviews: [aiReview()],
  comments: [signedComment],
  threads: [],
  statuses: [gateStatus("medium：已满足（1 人）")],
  baseChangedAt: null,
  ...over,
});
const green = () => [ok("checks", 1), ok("tests", 2)];

/**
 * In-memory GitHub for the queue: REST routes over a little state (refs, statuses, pulls), a fake clock for the CI poll.
 * `duringCi(h)` runs when CI is dispatched on the candidate branch (the world changes while CI runs).
 */
function harness({
  pulls = [rawPull()],
  changes = { 7: change() },
  checkRuns = { [HEAD]: green() },
  queueStatus = null,
  writers = [],
  ci = "success",
  duringCi = null,
  trialConflict = false,
  mergeError = null,
  parents = { [MERGED]: BASE },
  closing = [],
} = {}) {
  const calls = [];
  const writes = [];
  const refs = new Map([["main", BASE]]);
  const statuses = new Map();
  if (queueStatus) statuses.set(`${HEAD}|merge-queue`, { context: "merge-queue", ...queueStatus });
  let clock = T0;
  const h = { calls, writes, refs, pulls };
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const routes = [
    ["GET", /^\/repos\/o\/r$/, () => ({ default_branch: "main" })],
    ["GET", /^\/repos\/o\/r\/pulls\?state=open&base=main$/, () => structuredClone(pulls)],
    ["GET", /^\/repos\/o\/r\/pulls\/(\d+)$/, (m) => structuredClone(pulls.find((p) => p.number === Number(m[1])))],
    ["GET", /^\/repos\/o\/r\/commits\/(\w+)\/check-runs\?per_page=100$/, (m) => ({ check_runs: checkRuns[m[1]] ?? [] })],
    ["GET", /^\/repos\/o\/r\/commits\/(\w+)\/status$/, (m) => ({ statuses: [...statuses.entries()].filter(([k]) => k.startsWith(`${m[1]}|`)).map(([, s]) => s) })],
    ["GET", /^\/repos\/o\/r\/commits\/(\w+)$/, (m) => ({ parents: parents[m[1]] ? [{ sha: parents[m[1]] }] : [] })],
    ["GET", /^\/repos\/o\/r\/git\/ref\/heads\/(.+)$/, (m) => ({ object: { sha: refs.get(m[1]) } })],
    ["POST", /^\/repos\/o\/r\/git\/refs$/, (m, b) => refs.set(b.ref.replace(/^refs\/heads\//, ""), b.sha) && {}],
    ["DELETE", /^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/, (m) => refs.delete(m[1]) && null],
    [
      "POST",
      /^\/repos\/o\/r\/merges$/,
      (m, b) => {
        if (trialConflict) throw fail(409, "Merge conflict");
        refs.set(b.base, CAND);
        return { sha: CAND };
      },
    ],
    [
      "POST",
      /^\/repos\/o\/r\/actions\/workflows\/([^/]+)\/dispatches$/,
      (m, b) => {
        if (b.ref !== "main" && duringCi) duringCi(h);
        return null;
      },
    ],
    ["GET", /^\/repos\/o\/r\/actions\/workflows\/[^/]+\/runs\?/, () => ({ workflow_runs: [{ id: 55, head_sha: CAND, created_at: new Date(clock).toISOString() }] })],
    ["GET", /^\/repos\/o\/r\/actions\/runs\/55$/, () => ({ id: 55, status: "completed", conclusion: ci, html_url: "https://ci/55" })],
    [
      "PUT",
      /^\/repos\/o\/r\/pulls\/(\d+)\/merge$/,
      () => {
        if (mergeError) throw fail(405, mergeError);
        return { sha: MERGED, merged: true };
      },
    ],
    ["DELETE", /^\/repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/, () => []],
    ["PATCH", /^\/repos\/o\/r\/issues\/(\d+)$/, () => ({})],
  ];
  const handle = async (method, url, body) => {
    calls.push([method, url, body]);
    for (const [m, re, fn] of routes) {
      const mm = m === method && re.exec(url);
      if (mm) return fn(mm, body);
    }
    throw fail(404, `${method} ${url} → 404`);
  };
  h.forge = {
    id: "github",
    prTerm: "PR",
    ciIdentity: "github-actions[bot]",
    repo: "o/r",
    owner: "o",
    name: "r",
    rest: {
      get: (u) => handle("GET", u),
      post: (u, b) => handle("POST", u, b ?? {}),
      put: (u, b) => handle("PUT", u, b ?? {}),
      patch: (u, b) => handle("PATCH", u, b ?? {}),
      delete: (u) => handle("DELETE", u),
      paginate: (u) => handle("GET", u),
    },
    graphql: async (q, v) => {
      calls.push(["GRAPHQL", q.includes("closingIssuesReferences") ? "closingIssues" : "?", v]);
      return { repository: { pullRequest: { closingIssuesReferences: { nodes: closing } } } };
    },
    loadChange: async (number) => structuredClone(changes[number]),
    hasWriteAccess: async (login) => writers.includes(login),
    setStatus: async (sha, context, state, description, url) => {
      writes.push(["status", sha, context, state, description, url]);
      statuses.set(`${sha}|${context}`, { context, state, description });
    },
    postComment: async (n, body) => writes.push(["comment", n, body]),
    runUrl: () => "https://run/1",
  };
  h.run = (p = policy, opts = {}) =>
    runQueue({ forge: h.forge, policy: p, reviewer: copilot, env: {}, log: () => {}, sleep: async (ms) => void (clock += ms), now: () => clock, ...opts });
  h.dispatches = () => calls.filter(([m, u]) => m === "POST" && u.includes("/dispatches")).map(([, u, b]) => [u.split("/").at(-2), b]);
  h.statusWrites = (context = "merge-queue") => writes.filter((w) => w[0] === "status" && w[2] === context).map((w) => [w[3], w[4]]);
  h.comments = () => writes.filter((w) => w[0] === "comment").map((w) => [w[1], w[2]]);
  h.merges = () => calls.filter(([m, u]) => m === "PUT" && u.endsWith("/merge")).map(([, , b]) => b);
  h.labelRemovals = () => calls.filter(([m, u]) => m === "DELETE" && u.includes("/labels/")).map(([, u]) => u);
  return h;
}

describe("merge-queue CLI", () => {
  it("not ready because a required check failed ⇒ ejected: label removed, failure status, a comment; no CI", async () => {
    const h = harness({ checkRuns: { [HEAD]: [ok("checks"), ok("tests", 2, "failure")] } });
    const { branch, results } = await h.run();
    assert.equal(branch, "main");
    assert.deepEqual(results, [{ number: 7, outcome: "ejected", ranCi: false, step: "next" }]);
    assert.deepEqual(h.labelRemovals(), ["/repos/o/r/issues/7/labels/merge-queue"]);
    assert.deepEqual(h.statusWrites(), [["failure", "出队：必需检查 tests 结论是 failure"]]);
    assert.deepEqual(h.comments(), [[7, "合并队列：已出队——必需检查 tests 结论是 failure。处理后重新打 `merge-queue` 标签入队。\n\n队列运行：https://run/1"]]);
    assert.deepEqual(h.dispatches(), []);
  });

  it("a PR from a fork is ejected before any gate work (English)", async () => {
    const h = harness({ pulls: [rawPull({ head: { sha: HEAD, repo: { full_name: "someone/r" } } })] });
    await h.run(en);
    assert.equal(h.statusWrites()[0][1], "ejected: PRs from forks don't enter the queue (their code would run in CI with this repository's permissions); open the PR from a branch in this repository");
    assert.ok(!h.calls.some(([m]) => m === "GRAPHQL"));
  });

  it("not ready yet (a check still running) ⇒ left in the queue untouched; the next PR is looked at", async () => {
    const running = [ok("checks"), { name: "tests", id: 3, status: "in_progress", conclusion: null }];
    const OTHER = "9".repeat(40);
    const h = harness({
      pulls: [rawPull(), rawPull({ number: 5, title: "fix: wait", head: { sha: OTHER, repo: { full_name: "o/r" } } })],
      checkRuns: { [HEAD]: green(), [OTHER]: running },
      writers: ["bob"],
    });
    const { results } = await h.run();
    assert.deepEqual(
      results.map((r) => [r.number, r.outcome, r.step]),
      [
        [5, "waiting", "next"],
        [7, "merged", "stop"],
      ],
    );
    assert.ok(!h.writes.some((w) => w[1] === OTHER || w[1] === 5));
  });

  it("a passing candidate merges at the tested head with the Conventional-Commits title; a waiver becomes a trailer", async () => {
    const waived = change({
      reviews: [aiReview(NOTICE), { login: "bob", type: "User", state: "APPROVED", commitId: HEAD, submittedAt: "2026-11-18T10:00:00Z", association: "MEMBER" }],
      comments: [signedComment, { login: "carol", type: "User", body: `/waive-ai-review ${HEAD.slice(0, 7)}`, createdAt: "2026-11-18T09:30:00Z" }],
    });
    const closing = [
      { number: 3, state: "OPEN", repository: { nameWithOwner: "o/r" } },
      { number: 4, state: "CLOSED", repository: { nameWithOwner: "o/r" } },
    ];
    const h = harness({ changes: { 7: waived }, writers: ["bob", "carol"], closing });
    const { results } = await h.run();
    assert.deepEqual(results, [{ number: 7, outcome: "merged", ranCi: true, step: "stop" }]);
    // CI on the candidate branch, told which base it was built on
    assert.deepEqual(h.dispatches(), [["ci.yml", { ref: "merge-queue/pr-7", inputs: { pr: "7", base: BASE } }]]);
    assert.ok(h.calls.some(([m, u, b]) => m === "POST" && u.endsWith("/merges") && b.base === "merge-queue/pr-7" && b.head === HEAD && b.commit_message === "merge-queue: 在 main@1111111 上试合 #7"));
    assert.ok(!h.refs.has("merge-queue/pr-7"), "the candidate branch is deleted");
    assert.deepEqual(h.statusWrites(), [
      ["pending", "#7 (1/3) 在 main@1111111 上重跑 CI"],
      ["success", "已在 main@1111111 上验证"],
    ]);
    assert.equal(h.writes.find((w) => w[3] === "success")[5], "https://ci/55");
    assert.deepEqual(h.merges(), [
      {
        merge_method: "merge",
        sha: HEAD,
        commit_title: "feat(api): 合并 PR #7 add export",
        commit_message:
          "合并队列在 main@1111111 上重跑 CI 通过：https://ci/55\n\n" +
          "AI 评审已豁免：`carol` 于 2026-11-18T09:30:00Z 发了 `/waive-ai-review`，多要了他人批准顶替。\n\n" +
          "AI-Review-Waived: carol 2026-11-18T09:30:00Z",
      },
    ]);
    assert.deepEqual(h.labelRemovals(), ["/repos/o/r/issues/7/labels/merge-queue"]);
    // linked issues: only the open one is closed, with a comment
    assert.deepEqual(h.comments(), [[3, "由 #7 合入关闭（4444444）。合并队列以 CI 身份合入时平台不会按 Closes 自动关闭，由队列代关。"]]);
    assert.deepEqual(
      h.calls.filter(([m]) => m === "PATCH").map(([, u, b]) => [u, b]),
      [["/repos/o/r/issues/3", { state: "closed", state_reason: "completed" }]],
    );
  });

  it("names, checks, merge method and language come from the policy", async () => {
    const custom = {
      ...en,
      names: { ...policy.names, queueLabel: "ship-it", queueContext: "mq", ciWorkflow: "build.yml" },
      checks: { required: ["build"], skippable: ["release-gate"] },
      queue: { ...policy.queue, mergeMethod: "squash", maxAttempts: 5 },
    };
    const h = harness({
      pulls: [rawPull({ labels: [{ name: "ship-it" }] })],
      checkRuns: { [HEAD]: [ok("build"), ok("release-gate", 2, "skipped")] },
      changes: { 7: change({ statuses: [gateStatus("medium: satisfied (1 person)")] }) },
    });
    const { results } = await h.run(custom);
    assert.equal(results[0].outcome, "merged");
    assert.deepEqual(h.dispatches(), [["build.yml", { ref: "mq/pr-7", inputs: { pr: "7", base: BASE } }]]);
    assert.deepEqual(h.statusWrites("mq"), [
      ["pending", "#7 (1/5) re-running CI on main@1111111"],
      ["success", "verified on main@1111111"],
    ]);
    const [merge] = h.merges();
    assert.equal(merge.merge_method, "squash");
    assert.equal(merge.commit_title, "feat(api): merge PR #7 add export");
    assert.equal(merge.commit_message, "Merge queue re-ran CI on main@1111111 and it passed: https://ci/55");
    assert.deepEqual(h.labelRemovals(), ["/repos/o/r/issues/7/labels/ship-it"]);
  });

  it("red CI ⇒ ejected right away with the run link", async () => {
    const h = harness({ ci: "failure" });
    const { results } = await h.run();
    assert.deepEqual(results, [{ number: 7, outcome: "ejected", ranCi: true, step: "stop" }]);
    assert.deepEqual(h.statusWrites(), [
      ["pending", "#7 (1/3) 在 main@1111111 上重跑 CI"],
      ["failure", "出队：在最新 main 上 CI 结论是 failure（https://ci/55）"],
    ]);
    assert.equal(h.merges().length, 0);
    assert.equal(h.comments().length, 1);
  });

  it("the target branch moves during every test: the attempt counter goes up across runs and the third run ejects", async () => {
    let queueStatus = null;
    const seen = [];
    for (let run = 1; run <= 3; run++) {
      const h = harness({ queueStatus, duringCi: (x) => x.refs.set("main", MOVED) });
      const { results } = await h.run();
      seen.push([results[0].outcome, results[0].step, h.statusWrites().at(-1)]);
      queueStatus = { state: h.statusWrites().at(-1)[0], description: h.statusWrites().at(-1)[1] };
      if (run < 3) assert.deepEqual(h.dispatches().at(-1), ["merge-queue.yml", { ref: "main" }]);
      else assert.equal(h.dispatches().filter(([w]) => w === "merge-queue.yml").length, 0);
    }
    assert.deepEqual(seen, [
      ["retry", "dispatch", ["pending", "#7 (1/3) 作废（main 在测试期间动了），待重测"]],
      ["retry", "dispatch", ["pending", "#7 (2/3) 作废（main 在测试期间动了），待重测"]],
      [
        "ejected",
        "stop",
        ["failure", "出队：同一提交已在队列里连续测了 3 次仍没合成（main 在测试期间一直在动，或队列运行中途中断），停止自动重测；等 main 稳定后重新入队"],
      ],
    ]);
  });

  it("a run killed half-way counts as an attempt (its testing status carries the counter)", async () => {
    const h = harness({ queueStatus: { state: "pending", description: "#7 (2/3) 在 main@1111111 上重跑 CI" }, duringCi: (x) => x.refs.set("main", MOVED) });
    const { results } = await h.run();
    assert.equal(results[0].outcome, "ejected");
    assert.equal(h.statusWrites()[0][1], "#7 (3/3) 在 main@1111111 上重跑 CI");
  });

  it("the stored gate status disagrees with the re-judge ⇒ dispatch the gate workflow for this PR; no CI", async () => {
    const h = harness({ changes: { 7: change({ statuses: [gateStatus("medium：还差 1 项，见 PR 里的 risk-gate 评论", "failure")] }) } });
    const { results } = await h.run();
    assert.deepEqual(results, [{ number: 7, outcome: "waiting", ranCi: false, step: "next" }]);
    assert.deepEqual(h.dispatches(), [["risk-gate.yml", { ref: "main", inputs: { pr: "7" } }]]);
    assert.deepEqual(h.writes, []);
  });

  it("unmet and the stored status already says so ⇒ waits without asking again", async () => {
    const h = harness({ changes: { 7: change({ comments: [], statuses: [gateStatus("medium：还差 1 项，见 PR 里的 risk-gate 评论", "failure")] }) } });
    const { results } = await h.run();
    assert.equal(results[0].outcome, "waiting");
    assert.deepEqual(h.dispatches(), []);
  });

  it("a gate error counts as not satisfied", async () => {
    const h = harness();
    h.forge.loadChange = async () => {
      throw new Error("boom");
    };
    const { results } = await h.run();
    assert.equal(results[0].outcome, "waiting");
    assert.deepEqual(h.writes, []);
  });

  it("the candidate does not merge into the latest target branch ⇒ ejected, the temporary branch removed", async () => {
    const h = harness({ trialConflict: true });
    const { results } = await h.run();
    assert.deepEqual(results, [{ number: 7, outcome: "ejected", ranCi: false, step: "next" }]);
    assert.deepEqual(h.statusWrites(), [["failure", "出队：与最新 main 合不起来（冲突），请先更新分支"]]);
    assert.ok(!h.refs.has("merge-queue/pr-7"));
  });

  it("the label is removed while CI runs ⇒ not merged, the counter is cleared, left in place", async () => {
    const h = harness({ duringCi: (x) => (x.pulls[0].labels = []) });
    const { results } = await h.run();
    assert.deepEqual(results, [{ number: 7, outcome: "waiting", ranCi: true, step: "stop" }]);
    assert.deepEqual(h.statusWrites().at(-1), ["pending", "没合：merge-queue 标签已被摘掉"]);
    assert.equal(queue.attemptsSoFar({ state: "pending", description: h.statusWrites().at(-1)[1] }, 7), 0);
    assert.equal(h.merges().length, 0);
    assert.deepEqual(h.labelRemovals(), []);
  });

  it("the forge refuses the merge ⇒ ejected with its message", async () => {
    const h = harness({ mergeError: "Base branch was modified" });
    const { results } = await h.run();
    assert.equal(results[0].outcome, "ejected");
    assert.deepEqual(h.statusWrites().at(-1), ["failure", "出队：合并被拒：Base branch was modified"]);
  });

  it("the merged commit's base is not the tested one ⇒ CI re-runs on the target branch with the pre-merge base, and a comment", async () => {
    const h = harness({ parents: { [MERGED]: MOVED } });
    await h.run();
    assert.deepEqual(h.dispatches().at(-1), ["ci.yml", { ref: "main", inputs: { pr: "7", base: MOVED } }]);
    assert.deepEqual(h.comments().at(-1), [
      7,
      "合并队列：本 PR 测的是 main@1111111，合入时 main 已到 2222222，合进去的组合没有被完整测过。已在 main 上补跑 CI，请值班看结果。",
    ]);
  });

  it("a rebase merge walks back over the replayed commits to find the base", async () => {
    const MID = "5".repeat(40);
    const rebase = { ...policy, queue: { ...policy.queue, mergeMethod: "rebase" } };
    const fine = harness({ parents: { [MERGED]: MID, [MID]: BASE } });
    await fine.run(rebase);
    assert.equal(fine.merges()[0].merge_method, "rebase");
    assert.equal(fine.dispatches().length, 1, "only the candidate's CI");
    const moved = harness({ parents: { [MERGED]: MID, [MID]: MOVED } });
    await moved.run(rebase);
    assert.deepEqual(moved.dispatches().at(-1), ["ci.yml", { ref: "main", inputs: { pr: "7", base: MOVED } }]);
  });

  it("more queued after the one that waited for CI ⇒ another run is dispatched", async () => {
    const h = harness({ pulls: [rawPull(), rawPull({ number: 8, title: "docs: more" })], changes: { 7: change(), 8: change({ number: 8 }) } });
    const { results } = await h.run();
    assert.deepEqual(results, [{ number: 7, outcome: "merged", ranCi: true, step: "dispatch" }]);
    assert.deepEqual(h.dispatches().at(-1), ["merge-queue.yml", { ref: "main" }]);
  });

  it("a success left on an open PR by a killed run is reset to pending", async () => {
    const h = harness({ pulls: [rawPull({ labels: [] })], queueStatus: { state: "success", description: "已在 main@1111111 上验证" } });
    await h.run();
    assert.deepEqual(h.statusWrites(), [["pending", "需要经合并队列合入（打 merge-queue 标签）"]]);
  });

  it("dry run writes nothing and dispatches nothing", async () => {
    const stale = harness({
      changes: { 7: change({ statuses: [] }) },
      queueStatus: { state: "success", description: "x" },
      checkRuns: { [HEAD]: green() },
    });
    const { results } = await stale.run(policy, { dryRun: true });
    assert.equal(results[0].outcome, "waiting");
    const ejecting = harness({ checkRuns: { [HEAD]: [ok("checks"), ok("tests", 2, "failure")] } });
    await ejecting.run(policy, { dryRun: true });
    const ready = harness();
    await ready.run(policy, { dryRun: true });
    for (const h of [stale, ejecting, ready]) {
      assert.deepEqual(h.writes, []);
      assert.ok(!h.calls.some(([m]) => m !== "GET" && m !== "GRAPHQL"), JSON.stringify(h.calls.filter(([m]) => m !== "GET")));
    }
  });

  it("queue modes native and train exit 0 without touching the forge", () => {
    const cli = fileURLToPath(new URL("../engine/cli/merge-queue.mjs", import.meta.url));
    for (const mode of ["native", "train"]) {
      const root = mkdtempSync(join(tmpdir(), "dp-queue-"));
      try {
        mkdirSync(join(root, ".dev-process"));
        writeFileSync(join(root, ".dev-process", "config.json"), JSON.stringify({ queue: { mode } }));
        const env = { ...process.env, DEV_PROCESS_ROOT: root, GITHUB_REPOSITORY: "", GH_TOKEN: "", GITHUB_TOKEN: "" };
        const out = execFileSync(process.execPath, [cli], { env, encoding: "utf8" });
        assert.ok(out.includes(`queue mode "${mode}"`), out);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
