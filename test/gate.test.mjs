// risk-gate decisions (ported from the reference implementation's riskGate tests; asserts codes, renders both languages).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as gate from "../engine/core/gate.mjs";
import { copilot } from "../engine/reviewer/copilot.mjs";
import { AUTHOR, file, HEAD, OLD, policy } from "./helpers.mjs";

const codes = (items) => items.map((x) => x.code);
const textOf = (r, lang = "zh") => gate.explain(r, lang).missing.join("\n");
const approve = (login, commitId = HEAD, extra = {}) => ({ login, type: "User", state: "APPROVED", commitId, submittedAt: "2026-11-18T10:00:00Z", association: "MEMBER", ...extra });
const signoff = (sha = HEAD.slice(0, 12), login = AUTHOR) => ({ login, type: "User", body: `looked\n/signoff ${sha}`, createdAt: "2026-11-18T09:00:00Z" });
const aiThread = (replies = [], isOutdated = false) => ({
  isResolved: false,
  isOutdated,
  path: "src/a.ts",
  line: 3,
  comments: [{ login: "copilot-pull-request-reviewer", type: "Bot", body: "null deref here" }, ...replies.map((r) => ({ type: "User", ...r }))],
});
const COPILOT = "copilot-pull-request-reviewer[bot]";
const OVERVIEW = "<!-- ccr-overview-v2 -->\n\n### Approval recommended\n\nNo issues.";
const NOTICE =
  "Copilot was unable to review this pull request because the user who requested the review has insufficient remaining quota.\n\n" +
  "An organization owner can choose the repository organization as the billing source.";
const aiReview = (commitId = HEAD, body = OVERVIEW, submittedAt = "2026-11-18T08:00:00Z") => ({ login: COPILOT, type: "Bot", state: "COMMENTED", commitId, submittedAt, body });

/** Includes a real AI review of the head unless `ai: false`. */
function run(over = {}) {
  const { ai = true, reviews = [], ...rest } = over;
  return gate.evaluate({
    policy,
    reviewer: copilot,
    author: AUTHOR,
    headSha: HEAD,
    files: [file("src/host/a.tsx")],
    comments: [],
    threads: [],
    classifier: null,
    ...rest,
    reviews: ai ? [aiReview(), ...reviews] : [...reviews],
  });
}

describe("tier comes from the change", () => {
  it("docs only ⇒ low; code ⇒ medium; tests only are medium too", () => {
    assert.equal(gate.computeTier([file("docs/a.md"), file("ROADMAP.md")], policy).tier, "low");
    assert.equal(gate.computeTier([file("src/host/a.tsx")], policy).tier, "medium");
    assert.equal(gate.computeTier([file("tests/gate/x.test.ts")], policy).tier, "medium");
  });

  it("a high path ⇒ high, including the old path of a rename", () => {
    for (const f of ["src/update/settings.ts", ".github/workflows/ci.yml", "CLAUDE.md", "package.json", ".dev-process/config.json"]) {
      assert.equal(gate.computeTier([file(f)], policy).tier, "high", f);
    }
    assert.equal(gate.computeTier([file("src/x/moved.ts", 1, "src/update/old.ts")], policy).tier, "high");
  });

  it("non-doc changes over the threshold are at least medium; docs and lock files don't count", () => {
    const big = gate.computeTier([file("src/host/a.tsx", policy.sizeThresholdLines + 1)], policy);
    assert.equal(big.tier, "medium");
    assert.ok(codes(big.reasons).includes("tier.size"));
    const docsBig = gate.computeTier([file("docs/a.md", 5000)], policy);
    assert.equal(docsBig.tier, "low");
    assert.equal(docsBig.changedLines, 0);
  });

  it("the AI second opinion only raises the tier", () => {
    assert.equal(run({ classifier: { tier: "high", reason: "new privileged channel" } }).tier, "high");
    assert.equal(run({ files: [file("src/update/a.ts")], classifier: { tier: "low", reason: "small" } }).tier, "high");
    assert.equal(run({ classifier: { tier: "bogus", reason: "" } }).tier, "medium");
  });
});

describe("people", () => {
  it("low + trusted author needs nobody", () => {
    const r = run({ files: [file("docs/a.md")] });
    assert.equal(r.ok, true);
    assert.equal(r.needSignoff, false);
    assert.equal(r.needOthers, 0);
  });

  it("medium: the author's sign-off is enough; unsigned ⇒ blocked with the command to post", () => {
    assert.equal(run({ comments: [signoff()] }).ok, true);
    const r = run();
    assert.equal(r.ok, false);
    assert.ok(textOf(r).includes(`/signoff ${HEAD.slice(0, 12)}`));
    assert.ok(textOf(r, "en").includes(`/signoff ${HEAD.slice(0, 12)}`));
  });

  it("high: sign-off + one approval from someone else on the head", () => {
    const files = [file("src/update/a.ts")];
    assert.equal(run({ files, comments: [signoff()] }).ok, false);
    assert.equal(run({ files, comments: [signoff()], reviews: [approve("bob")] }).ok, true);
  });

  it("sign-off only by the author, only for the head; an old commit asks to sign again", () => {
    assert.equal(run({ comments: [signoff(HEAD.slice(0, 12), "bob")] }).signed, false);
    assert.equal(run({ comments: [{ ...signoff(), type: "Bot" }] }).signed, false);
    assert.equal(run({ comments: [signoff(HEAD.slice(0, 6))] }).signed, false); // fewer than 7 hex
    const stale = run({ comments: [signoff(OLD.slice(0, 12))] });
    assert.equal(stale.signed, false);
    const m = stale.missing.find((x) => x.code === "missing.signoff");
    assert.equal(m.params.prev, "stale");
    assert.ok(textOf(stale).includes("有新提交要重签"));
  });

  it("approvals on old commits, by bots or the AI, by the author, or without write access don't count", () => {
    const r = run({
      files: [file("src/update/a.ts")],
      comments: [signoff()],
      reviews: [approve("bob", OLD), approve("copilot-pull-request-reviewer", HEAD, { type: "Bot" }), approve(AUTHOR), approve("outsider", HEAD, { association: "CONTRIBUTOR" })],
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.approvers, []);
    assert.deepEqual(r.staleApprovers, ["bob"]);
    assert.deepEqual(r.uncountedApprovers, ["outsider"]);
    assert.ok(textOf(r).includes("批的是旧提交"));
  });

  it("approvers need real write access (org membership is not enough)", () => {
    const files = [file("src/update/a.ts")];
    const member = approve("org-member-readonly");
    assert.equal(run({ files, comments: [signoff()], reviews: [member], writers: new Set() }).ok, false);
    assert.deepEqual(run({ files, comments: [signoff()], reviews: [member], writers: new Set() }).uncountedApprovers, ["org-member-readonly"]);
    assert.equal(run({ files, comments: [signoff()], reviews: [member], writers: new Set(["org-member-readonly"]) }).ok, true);
  });

  it("an untrusted author needs one more approval at every tier", () => {
    const r = run({ author: "someone-new", files: [file("docs/a.md")] });
    assert.equal(r.trusted, false);
    assert.equal(r.needOthers, 1);
    assert.equal(r.ok, false);
    assert.equal(run({ author: "someone-new", files: [file("docs/a.md")], reviews: [approve("bob")] }).ok, true);
  });

  it("a later 'changes requested' by the same person voids the approval and blocks", () => {
    const r = run({ comments: [signoff()], reviews: [approve("bob"), { ...approve("bob"), state: "CHANGES_REQUESTED", submittedAt: "2026-11-18T11:00:00Z" }] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.changesRequestedBy, ["bob"]);
  });
});

describe("every AI comment needs an answer", () => {
  it("unanswered ⇒ blocked; code moved (outdated) ⇒ passes", () => {
    assert.equal(run({ comments: [signoff()], threads: [aiThread()] }).ok, false);
    assert.equal(run({ comments: [signoff()], threads: [aiThread([], true)] }).ok, true);
  });

  it("a tagged reply answers (full-width colon too); untagged or bot replies don't", () => {
    assert.equal(run({ comments: [signoff()], threads: [aiThread([{ login: AUTHOR, body: "wrong：cannot be null here" }])] }).ok, true);
    assert.equal(run({ comments: [signoff()], threads: [aiThread([{ login: AUTHOR, body: "Intended: on purpose" }])] }).ok, true);
    assert.equal(run({ comments: [signoff()], threads: [aiThread([{ login: AUTHOR, body: "ok" }])] }).ok, false);
    assert.equal(run({ comments: [signoff()], threads: [aiThread([{ login: "github-actions[bot]", body: "fixed: x", type: "Bot" }])] }).ok, false);
  });

  it("threads opened by humans are not this gate's business", () => {
    const human = { ...aiThread(), comments: [{ login: "bob", type: "User", body: "change this" }] };
    assert.equal(run({ comments: [signoff()], threads: [human] }).ok, true);
  });

  it("round cap reached with unanswered comments ⇒ suggest reconsidering; notices are not rounds", () => {
    const rounds = Array.from({ length: policy.reviewRoundCap }, (_, i) => aiReview(HEAD, OVERVIEW, `2026-11-18T0${i}:00:00Z`));
    assert.equal(run({ ai: false, reviews: rounds, threads: [aiThread()] }).rethink, true);
    assert.equal(run({ ai: false, reviews: rounds.slice(1), threads: [aiThread()] }).rethink, false);
    const withNotice = [...rounds.slice(1), aiReview(HEAD, NOTICE, "2026-11-18T09:00:00Z")];
    assert.equal(run({ ai: false, reviews: withNotice, threads: [aiThread()] }).aiRounds, policy.reviewRoundCap - 1);
    assert.equal(run({ ai: false, reviews: withNotice, threads: [aiThread()] }).rethink, false);
  });
});

describe("output", () => {
  it("status descriptions fit in 140 characters; the comment lists what is missing (both languages)", () => {
    const r = run({ files: [file("src/update/a.ts")], threads: [aiThread()] });
    for (const lang of ["zh", "en"]) {
      assert.ok([...gate.statusDescription(r, { lang })].length <= 140);
      const md = gate.render(r, HEAD, { lang, gate: "risk-gate", ai: "Copilot" });
      assert.ok(md.includes("**high**"));
      assert.ok(md.includes("- [ ] "));
      assert.ok(md.includes("src/a.ts:3"));
    }
    assert.ok(gate.render(r, HEAD, { lang: "zh", ai: "Copilot" }).includes("risk-gate：**high**"));
    assert.ok(gate.render(r, HEAD, { lang: "en", ai: "Copilot" }).includes("risk-gate: **high**"));
  });

  it("the satisfied line follows the queue mode", () => {
    const ok = run({ files: [file("docs/a.md")] });
    assert.ok(gate.render(ok, HEAD, { lang: "en", ai: "Copilot", queueMode: "self", queueLabel: "merge-queue", base: "main" }).includes("latest main"));
    assert.ok(gate.render(ok, HEAD, { lang: "en", ai: "Copilot", queueMode: "native" }).includes("merge queue"));
    assert.ok(gate.render(ok, HEAD, { lang: "zh", ai: "Copilot", queueMode: "train" }).includes("合并列车"));
  });

  it("the second opinion is trusted only from the CI identity", () => {
    const statuses = [
      { context: "risk-classifier", description: "low — tiny", creator: { login: "someone" } },
      { context: "risk-gate", description: "x", creator: { login: "github-actions[bot]" } },
      { context: "risk-classifier", description: "high — new privileged channel", creator: { login: "github-actions[bot]" } },
    ];
    assert.deepEqual(gate.trustedClassifier(statuses), { tier: "high", reason: "new privileged channel" });
    assert.equal(gate.trustedClassifier(statuses.slice(0, 2)), null);
  });

  it("classifier status descriptions read back", () => {
    assert.deepEqual(gate.parseClassifierStatus("high — new channel"), { tier: "high", reason: "new channel" });
    assert.equal(gate.parseClassifierStatus("whatever"), null);
  });

  it("the stored gate result is trusted only from the CI identity", () => {
    const statuses = [
      { context: "risk-gate", state: "success", description: "ok", created_at: "2026-11-18T12:00:00Z", creator: { login: "someone" } },
      { context: "risk-classifier", state: "success", description: "low — x", created_at: "2026-11-18T11:30:00Z", creator: { login: "github-actions[bot]" } },
      { context: "risk-gate", state: "failure", description: "1 missing", created_at: "2026-11-18T11:00:00Z", creator: { login: "github-actions[bot]" } },
    ];
    assert.deepEqual(gate.trustedGateStatus(statuses), { state: "failure", description: "1 missing", createdAt: "2026-11-18T11:00:00Z" });
    assert.equal(gate.trustedGateStatus(statuses.slice(0, 2)), null);
  });
});

describe("the AI must really review the head", () => {
  const docs = [file("docs/a.md")];
  const waiver = (counted = true, by = "carol") => ({ by, at: "2026-11-19T08:00:00Z", counted });

  it("real reviews carry the overview marker (any version); notices and humans with the marker don't count", () => {
    assert.equal(copilot.isRealReview({ login: COPILOT, body: OVERVIEW }), true);
    assert.equal(copilot.isRealReview({ login: "copilot-pull-request-reviewer", body: "<!-- ccr-overview-v3 -->\nx" }), true);
    assert.equal(copilot.isRealReview({ login: COPILOT, body: NOTICE }), false);
    assert.equal(copilot.isRealReview({ login: COPILOT, body: null }), false);
    assert.equal(copilot.isRealReview({ login: "alice", body: OVERVIEW }), false);
  });

  it("only a quota notice on the head ⇒ blocked, quoting it and the waiver; notices are not rounds", () => {
    const r = run({ ai: false, files: docs, reviews: [aiReview(HEAD, NOTICE)] });
    assert.equal(r.ok, false);
    assert.equal(r.aiRounds, 0);
    assert.equal(r.aiReview.reviewedHead, false);
    assert.equal(r.aiReview.waived, false);
    assert.equal(r.aiReview.notice, "Copilot was unable to review this pull request because the user who requested the review has insufficient remaining quota.");
    const why = textOf(r);
    assert.ok(why.includes(`等 Copilot 评审当前提交 ${HEAD.slice(0, 7)}`));
    assert.ok(why.includes("insufficient remaining quota"));
    assert.ok(why.includes(`\`${policy.commands.waiver} ${HEAD.slice(0, 12)}\``));
    assert.ok(textOf(r, "en").includes(`Wait for Copilot to review the head commit ${HEAD.slice(0, 7)}`));
  });

  it("a real review only on an old commit ⇒ blocked; on the head ⇒ passes (low too)", () => {
    const old = run({ ai: false, files: docs, reviews: [aiReview(OLD)] });
    assert.equal(old.ok, false);
    assert.equal(old.aiReview.notice, null);
    assert.equal(run({ ai: false, files: docs }).ok, false);
    assert.equal(run({ files: docs }).ok, true);
    assert.equal(run({ files: docs }).aiReview.reviewedHead, true);
  });

  it("a waiver by someone with write access ⇒ no AI wait, one more approval instead (the author may post it)", () => {
    const base = { ai: false, files: docs, reviews: [aiReview(HEAD, NOTICE)] };
    const r = run({ ...base, waiver: waiver(true, AUTHOR) });
    assert.equal(r.aiReview.waived, true);
    assert.equal(r.needOthers, policy.aiReviewWaiverExtraApprovals);
    assert.equal(r.ok, false);
    assert.ok(textOf(r).includes("AI 评审已豁免"));
    assert.ok(!codes(r.missing).includes("missing.aiReview"));
    assert.equal(run({ ...base, waiver: waiver(true, AUTHOR), reviews: [aiReview(HEAD, NOTICE), approve("bob")] }).ok, true);
    const medium = run({ ai: false, comments: [signoff()], waiver: waiver() });
    assert.equal(medium.needSignoff, true);
    assert.equal(medium.needOthers, policy.aiReviewWaiverExtraApprovals);
  });

  it("a waiver without write access does not count, and says why", () => {
    const r = run({ ai: false, files: docs, waiver: waiver(false, "outsider") });
    assert.equal(r.aiReview.waived, false);
    assert.equal(r.ok, false);
    assert.ok(textOf(r).includes("豁免命令是 `outsider` 发的（没有写权限），不算"));
  });

  it("with a real review on the head the waiver does nothing", () => {
    const r = run({ files: docs, waiver: waiver() });
    assert.equal(r.aiReview.waived, false);
    assert.equal(r.needOthers, 0);
    assert.equal(r.ok, true);
  });

  it("the comment states the head's AI review; a waiver names who and when, without @", () => {
    assert.ok(gate.render(run({ files: docs }), HEAD, { lang: "zh", ai: "Copilot" }).includes("当前提交：已评审"));
    assert.ok(gate.render(run({ ai: false, files: docs }), HEAD, { lang: "zh", ai: "Copilot" }).includes("当前提交：还没评审"));
    const done = run({ ai: false, files: docs, waiver: waiver(true, "bob"), reviews: [approve(AUTHOR)] });
    assert.equal(done.ok, false); // the author's own approval does not count
    const ok = run({ ai: false, author: "carol", files: docs, waiver: waiver(true, "bob"), reviews: [approve(AUTHOR)] });
    assert.equal(ok.ok, true);
    const md = gate.render(ok, HEAD, { lang: "zh", ai: "Copilot" });
    assert.ok(md.includes("当前提交：没评审，已豁免：`bob` 于 2026-11-19T08:00:00Z"));
    assert.ok(!md.includes("@bob"));
    assert.ok(gate.render(ok, HEAD, { lang: "en", ai: "Copilot" }).includes("waived by `bob` at 2026-11-19T08:00:00Z"));
  });

  it("waivers are read like sign-offs: line start, head commit, not bots; old commits ask to re-post", () => {
    const C = policy.commands.waiver;
    const c = (login, body, type = "User") => ({ login, type, body, createdAt: `t-${login}` });
    const comments = [
      c("carol", `quota is gone\n${C} ${HEAD.slice(0, 7)}`),
      c("some-bot[bot]", `${C} ${HEAD.slice(0, 7)}`, "Bot"),
      c("bob", `${C} ${OLD.slice(0, 12)}`),
      c("alice", `by the way ${C} ${HEAD.slice(0, 7)}`), // not at line start
      c("outsider", `${C} ${HEAD.slice(0, 6)}`), // fewer than 7 hex
    ];
    const cmds = gate.waiverCommands(comments, HEAD, C);
    assert.deepEqual(cmds, { onHead: [{ by: "carol", at: "t-carol" }], stale: OLD.slice(0, 12), beforeBase: false });
    assert.deepEqual(gate.pickWaiver(cmds, new Set(["carol"])), { by: "carol", at: "t-carol", counted: true });
    assert.deepEqual(gate.pickWaiver(cmds, new Set()), { by: "carol", at: "t-carol", counted: false });
    assert.deepEqual(gate.pickWaiver({ onHead: [], stale: OLD.slice(0, 12) }, new Set()), { by: null, at: null, counted: false, stale: OLD.slice(0, 12) });
    assert.equal(gate.pickWaiver({ onHead: [], stale: null }, new Set()), null);
    const two = gate.waiverCommands([c("outsider", `${C} ${HEAD}`), c("carol", `${C} ${HEAD}`)], HEAD, C);
    const picked = gate.pickWaiver(two, new Set(["carol"]));
    assert.equal(picked.by, "carol");
    assert.equal(picked.counted, true);
  });

  it("several command lines in one comment are all read; the time is the last edit; sign-off uses the same parser", () => {
    const C = policy.commands.waiver;
    const body = `before:\n${C} ${OLD.slice(0, 7)}\nnow:\n${C} ${HEAD.slice(0, 7)}`;
    const cmds = gate.waiverCommands([{ login: "carol", type: "User", body, createdAt: "t0", updatedAt: "t1" }], HEAD, C);
    assert.deepEqual(cmds, { onHead: [{ by: "carol", at: "t1" }], stale: OLD.slice(0, 7), beforeBase: false });
    assert.deepEqual(gate.commandLines([{ login: "a", type: "User", body: `/signoff ${OLD.slice(0, 7)}\n/signoff ${HEAD.slice(0, 7)}` }], "/signoff"), [
      { login: "a", sha: OLD.slice(0, 7), at: null },
      { login: "a", sha: HEAD.slice(0, 7), at: null },
    ]);
    const signed = gate.findSignoff([{ login: AUTHOR, type: "User", body: `/signoff ${OLD.slice(0, 12)}\n/signoff ${HEAD.slice(0, 12)}`, createdAt: "c" }], AUTHOR, HEAD);
    assert.deepEqual(signed, { sha: HEAD.slice(0, 12), at: "c" });
  });

  it("the commands come from the policy (GitLab uses a prefix without a slash)", () => {
    const gl = { ...policy, commands: { signoff: "signoff:", waiver: "waive-ai-review:" } };
    const r = gate.evaluate({ policy: gl, reviewer: copilot, author: AUTHOR, headSha: HEAD, files: [file("src/a.ts")], reviews: [aiReview()], comments: [{ login: AUTHOR, type: "User", body: `signoff: ${HEAD.slice(0, 7)}` }], threads: [] });
    assert.equal(r.signed, true);
    assert.equal(r.ok, true);
  });

  it("only a waiver for another sha ⇒ still waits, saying it is not the head", () => {
    const r = run({ ai: false, files: docs, waiver: { by: null, at: null, counted: false, stale: OLD.slice(0, 12) } });
    assert.equal(r.ok, false);
    assert.equal(r.aiReview.waived, false);
    assert.ok(textOf(r).includes(`评论里的豁免命令写的是 ${OLD.slice(0, 12)}，不是当前提交`));
  });

  it("first sentence of a notice: strip HTML comments, split on full stops, cap length", () => {
    assert.equal(gate.firstSentence(NOTICE), "Copilot was unable to review this pull request because the user who requested the review has insufficient remaining quota.");
    assert.equal(gate.firstSentence("<!-- x -->\n出错了。请稍后再试。"), "出错了。");
    assert.equal(gate.firstSentence("a".repeat(500)).length, 160);
  });
});

describe("after a target-branch change, earlier reviews, sign-offs, approvals and waivers don't count", () => {
  const BASE_AT = "2026-11-19T12:00:00Z";
  const before = "2026-11-19T11:00:00Z";
  const after = "2026-11-19T13:00:00Z";
  const signoffAt = (at) => ({ ...signoff(), createdAt: at });

  it("the base-change time is the later of timeline and event; only strictly later times count", () => {
    assert.equal(gate.latestTime(null, BASE_AT), BASE_AT);
    assert.equal(gate.latestTime(before, BASE_AT), BASE_AT);
    assert.equal(gate.latestTime(after, BASE_AT), after);
    assert.equal(gate.latestTime(null, "", undefined), null);
    assert.equal(gate.afterBaseChange(after, BASE_AT), true);
    assert.equal(gate.afterBaseChange(BASE_AT, BASE_AT), false);
    assert.equal(gate.afterBaseChange(before, BASE_AT), false);
    assert.equal(gate.afterBaseChange(null, BASE_AT), false);
    assert.equal(gate.afterBaseChange(null, null), true);
  });

  it("the bypass (review a side branch, then retarget) is blocked, explaining each item", () => {
    const reviewsBefore = [aiReview(HEAD, OVERVIEW, before)];
    assert.equal(run({ ai: false, reviews: reviewsBefore, comments: [signoffAt(before)] }).ok, true);
    const r = run({ ai: false, reviews: reviewsBefore, comments: [signoffAt(before)], baseChangedAt: BASE_AT });
    assert.equal(r.ok, false);
    assert.equal(r.aiReview.reviewedHead, false);
    assert.equal(r.aiReview.staleBase, true);
    assert.equal(r.signed, false);
    const why = textOf(r);
    assert.ok(why.includes("在改目标分支之前、看的是旧 diff"));
    assert.ok(why.includes("之前的签署在改目标分支之前（diff 变了），要重签"));
    assert.ok(codes(r.reasons).includes("base.changed"));
    const again = run({ ai: false, reviews: [...reviewsBefore, aiReview(HEAD, OVERVIEW, after)], comments: [signoffAt(before), signoffAt(after)], baseChangedAt: BASE_AT });
    assert.equal(again.ok, true);
  });

  it("approvals before the base change don't count; later ones do", () => {
    const files = [file("src/update/a.ts")];
    const r = run({ files, comments: [signoffAt(after)], reviews: [approve("bob", HEAD, { submittedAt: before })], baseChangedAt: BASE_AT, ai: false });
    assert.deepEqual(r.approvers, []);
    assert.deepEqual(r.baseStaleApprovers, ["bob"]);
    assert.ok(textOf(r).includes("@bob 批在改目标分支之前，需重新批准"));
    const ok = run({ files, comments: [signoffAt(after)], reviews: [aiReview(HEAD, OVERVIEW, after), approve("bob", HEAD, { submittedAt: after })], baseChangedAt: BASE_AT, ai: false });
    assert.equal(ok.ok, true);
  });

  it("a waiver before the base change does not count and asks to re-post", () => {
    const C = policy.commands.waiver;
    const cmds = gate.waiverCommands([{ login: "carol", type: "User", body: `${C} ${HEAD.slice(0, 7)}`, createdAt: before }], HEAD, C, BASE_AT);
    assert.deepEqual(cmds, { onHead: [], stale: null, beforeBase: true });
    const waiver = gate.pickWaiver(cmds, new Set(["carol"]));
    assert.deepEqual(waiver, { by: null, at: null, counted: false, beforeBase: true });
    const r = run({ ai: false, files: [file("docs/a.md")], waiver, baseChangedAt: BASE_AT });
    assert.equal(r.ok, false);
    assert.ok(textOf(r).includes("豁免命令发在改目标分支之前，要重发"));
  });

  it("re-request the AI only when all reviews predate the change and it is not requested", () => {
    const stale = run({ ai: false, reviews: [aiReview(HEAD, OVERVIEW, before)], baseChangedAt: BASE_AT }).aiReview;
    assert.equal(gate.needAiRerequest(stale, [], copilot), true);
    assert.equal(gate.needAiRerequest(stale, ["alice"], copilot), true);
    assert.equal(gate.needAiRerequest(stale, ["Copilot"], copilot), false);
    const fresh = run({ ai: false, reviews: [aiReview(HEAD, OVERVIEW, after)], baseChangedAt: BASE_AT }).aiReview;
    assert.equal(gate.needAiRerequest(fresh, [], copilot), false);
    assert.equal(gate.needAiRerequest(run({ ai: false }).aiReview, [], copilot), false);
  });

  it("notices before the change are not today's cause; rounds count only after the change", () => {
    const notice = aiReview(HEAD, NOTICE, "2026-11-19T10:00:00Z");
    const r = run({ ai: false, reviews: [notice, aiReview(HEAD, OVERVIEW, before)], baseChangedAt: BASE_AT });
    assert.equal(r.aiReview.notice, null);
    assert.equal(r.aiRounds, 0);
    assert.equal(run({ ai: false, reviews: [aiReview(HEAD, OVERVIEW, before), aiReview(HEAD, OVERVIEW, after)], baseChangedAt: BASE_AT }).aiRounds, 1);
  });

  it("signed the head before the change, then an old sign-off later: still explained as a base change", () => {
    const comments = [{ ...signoff(), createdAt: before }, { ...signoff(OLD.slice(0, 12)), createdAt: after }];
    assert.deepEqual(gate.findSignoff(comments, AUTHOR, HEAD, BASE_AT), { stale: OLD.slice(0, 12), beforeBase: true });
  });
});

describe("Claude on GitLab: the hint says what people can do there", async () => {
  const { t } = await import("../engine/core/messages/index.mjs");
  it("push again, not re-run the job (people cannot re-run the bot's jobs on GitLab)", () => {
    const p = { ai: "Claude", reviewer: "claude", sha: "a".repeat(40), queueLabel: "merge-queue", staleBase: false, notice: null, ignored: null, cmd: "/waive-ai-review aaaa", extra: 1 };
    assert.match(t("en", "missing.aiReview", { ...p, pr: "MR" }), /push again/);
    assert.match(t("en", "missing.aiReview", { ...p, pr: "PR" }), /re-run the AI review job/);
  });
});

