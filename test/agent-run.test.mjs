// The role-agent runner's flow with an in-memory GitHub, worktree and Claude (no network, no git, no model).
import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeArgs, parsePorcelainZ, priorBranch, runRepo } from "../engine/cli/agent-run.mjs";
import { deniedActions, failureReason } from "../engine/core/agent-result.mjs";
import { validateTeam } from "../engine/core/team.mjs";

const team = validateTeam({
  version: 1,
  language: "en",
  people: [
    { login: "lead-a", roles: ["product"], lead: true },
    { login: "dev-b", roles: ["dev"] },
    { login: "ui-d", roles: ["ui"] },
  ],
  roles: {
    product: { instructions: ".dev-process/agents/product.md", next: ["ui", "dev"], paths: [".prd/**", "docs/**"], tools: ["Read", "Grep", "Glob", "Edit", "Write"], triage: true },
    ui: { instructions: ".dev-process/agents/ui.md", next: ["dev"], paths: ["design/**"], tools: ["Read", "Grep", "Glob", "Edit", "Write"] },
    dev: { instructions: ".dev-process/agents/dev.md", next: ["product"], paths: ["**"], tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"], allow: ["Bash(npm test *)"], setup: ["npm ci"], network: ["registry.npmjs.org"], model: "opus" },
  },
  neverNotify: ["quiet-x"],
  autoQueueLow: true,
});

/** In-memory GitHub: issues, comments, PRs; records every write. */
function fakeOps({ issues = [], pulls = [], readyBy = {} } = {}) {
  const writes = [];
  const comments = {};
  let nextNumber = 100;
  const byNo = (n) => issues.find((i) => i.number === n) ?? pulls.find((p) => p.number === n);
  const ops = {
    writes,
    comments,
    issuesWithLabel: async (l) => issues.filter((i) => i.state === "open" && i.labels.includes(l)).map((i) => ({ ...i, labels: [...i.labels], assignees: [...i.assignees] })),
    labeledBy: async (n) => readyBy[n] ?? "lead-a",
    issueComments: async (n) => comments[n] ?? [],
    addLabels: async (n, ls) => {
      if (!ls.length) return;
      writes.push(["addLabels", n, ls]);
      byNo(n)?.labels.push(...ls);
    },
    removeLabels: async (n, ls) => {
      if (!ls.length) return;
      writes.push(["removeLabels", n, ls]);
      const o = byNo(n);
      if (o) o.labels = o.labels.filter((l) => !ls.includes(l));
    },
    setAssignees: async (n, _cur, ls) => {
      writes.push(["setAssignees", n, ls]);
      if (byNo(n)) byNo(n).assignees = [...ls];
    },
    comment: async (n, body) => {
      writes.push(["comment", n, body]);
      (comments[n] ??= []).push({ login: "me", body });
    },
    createIssue: async (o) => {
      const number = nextNumber++;
      writes.push(["createIssue", number, o]);
      issues.push({ number, state: "open", isPull: false, labels: [...o.labels], assignees: [...o.assignees], title: o.title, body: o.body });
      return number;
    },
    createPull: async (o) => {
      const number = nextNumber++;
      writes.push(["createPull", number, o]);
      return { number, url: `https://example.test/pull/${number}` };
    },
    agentPulls: async () => pulls,
    dropReviewers: async (n, ls) => writes.push(["dropReviewers", n, ls]),
    closeIssue: async (n) => {
      writes.push(["closeIssue", n]);
      byNo(n).state = "closed";
    },
  };
  return ops;
}

function fakeWork({ files = [], setupOk = true } = {}) {
  const calls = [];
  return {
    calls,
    readDefault: async (p) => `# instructions for ${p}`,
    prepare: async (issue, role, run, branch = null, from = null) => {
      calls.push(["prepare", issue.number, role, branch, from]);
      return { dir: `/w/${issue.number}`, branch: branch ?? `agent/${role}/${issue.number}-${run}`, base: branch ? null : from };
    },
    setup: async (dir, cmds) => (calls.push(["setup", cmds]), setupOk ? { ok: true } : { ok: false, why: "npm ci → 1" }),
    changedFiles: async () => files,
    commitAndPush: async (dir, branch, msg) => calls.push(["commitAndPush", branch, msg]),
    cleanup: async (dir) => calls.push(["cleanup", dir]),
  };
}

const answer = (o) => async () => JSON.stringify({ type: "result", structured_output: o });
const issue = (o) => ({ number: 1, title: "Task", body: "Body", state: "open", isPull: false, labels: [], assignees: [], ...o });
const go = (o) => runRepo({ team, base: "main", mode: "full", run: "R1", ...o });

test("claudeArgs: restricted, dontAsk, role tools and rules, inescapable sandbox, credential paths unreadable", () => {
  const a = claudeArgs(team, "dev", { allowRead: ["/w/1"] });
  for (const f of ["--restricted", "--strict-mcp-config", "-p"]) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(a[a.indexOf("--tools") + 1], "Read,Grep,Glob,Edit,Write,Bash");
  assert.ok(a.includes("Bash(npm test *)"));
  assert.ok(!a.includes("Bash"), "never a bare Bash rule");
  assert.equal(a[a.indexOf("--model") + 1], "opus");
  const s = JSON.parse(a[a.indexOf("--settings") + 1]);
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.failIfUnavailable, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.equal(s.sandbox.network.strictAllowlist, true);
  assert.deepEqual(s.sandbox.network.allowedDomains, ["registry.npmjs.org"]);
  for (const p of ["~/.config/gh", "~/.ssh", "~/Library/Keychains"]) assert.ok(s.sandbox.filesystem.denyRead.includes(p), p);
  assert.deepEqual(s.sandbox.filesystem.allowRead, ["/w/1"]);
  assert.ok(s.permissions.deny.includes("Bash(git push *)"));
  assert.equal(JSON.parse(a[a.indexOf("--json-schema") + 1]).required[0], "status");
  assert.ok(!claudeArgs(team, "ui").includes("--model"));
});

test("not in the team: does nothing", async () => {
  const ops = fakeOps({ issues: [issue({ labels: ["role:dev", "agent:ready"], assignees: ["stranger"] })] });
  const r = await go({ login: "stranger", ops, work: fakeWork(), claude: answer({}) });
  assert.equal(r.idle, "notInTeam");
  assert.deepEqual(ops.writes, []);
});

test("dev task with changes: claim, commit, PR (Refs, never-notify dropped), hand-off to product, cleanup", async () => {
  const ops = fakeOps({ issues: [issue({ number: 7, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  const work = fakeWork({ files: ["src/total.ts", "tests/total.test.ts"] });
  const r = await go({
    login: "dev-b",
    ops,
    work,
    claude: answer({ status: "done", summary: "Fixed @quiet-x total, see #3", next: "product", handoff: "please accept", pr: { title: "fix: total", body: "Rounding\n/signoff abcdef1", verification: "npm test → 12 passed" } }),
  });
  assert.equal(r.task.result, "handoff:product");
  const pr = ops.writes.find((w) => w[0] === "createPull")[2];
  assert.equal(pr.base, "main");
  assert.match(pr.head, /^agent\/dev\/7-R1$/);
  assert.match(pr.body, /^Refs #7/);
  assert.match(pr.body, /npm test → 12 passed/);
  assert.match(pr.body, /<!-- dev-process:agent run=R1 role=dev issue=7 -->/);
  assert.doesNotMatch(pr.body, /^\s*\/signoff\s+[0-9a-f]{7}/m, "model text never becomes a sign-off line");
  assert.deepEqual(ops.writes.find((w) => w[0] === "dropReviewers")[2], ["quiet-x"]);
  assert.deepEqual(work.calls.find((c) => c[0] === "setup")[1], ["npm ci"]);
  assert.match(work.calls.find((c) => c[0] === "commitAndPush")[2], /Agent-Run: R1\nAgent-Role: dev\nRefs: #7/);
  assert.ok(work.calls.some((c) => c[0] === "cleanup"));
  // hand-off: product label + ready, assigned to the product person; the comment mentions nobody
  const finalIssue = (await ops.issuesWithLabel("agent:ready")).find((i) => i.number === 7);
  assert.deepEqual(finalIssue.labels.sort(), ["agent:ready", "role:product"]);
  assert.deepEqual(finalIssue.assignees, ["lead-a"]);
  const handoff = ops.writes.filter((w) => w[0] === "comment").at(-1)[2];
  assert.doesNotMatch(handoff, /(^|[^A-Za-z0-9])@[A-Za-z0-9]/);
  assert.doesNotMatch(handoff, /#3/);
});

test("finished with a PR and nothing next: Closes, issue waits in review", async () => {
  const ops = fakeOps({ issues: [issue({ number: 8, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  const r = await go({ login: "dev-b", ops, work: fakeWork({ files: ["src/a.ts"] }), claude: answer({ status: "done", summary: "ok", next: "done", pr: { title: "fix", body: "b" } }) });
  assert.equal(r.task.result, "review");
  assert.match(ops.writes.find((w) => w[0] === "createPull")[2].body, /^Closes #8/);
  assert.ok(ops.writes.some((w) => w[0] === "addLabels" && w[2].includes("agent:review")));
});

test("protected or out-of-scope changes are never committed", async () => {
  const ops = fakeOps({ issues: [issue({ number: 9, labels: ["role:ui", "agent:ready"], assignees: ["ui-d"] })] });
  const work = fakeWork({ files: ["design/a.md", ".github/workflows/ci.yml", "src/x.ts"] });
  const r = await go({ login: "ui-d", ops, work, claude: answer({ status: "done", summary: "s", next: "dev", pr: { title: "t", body: "b" } }) });
  assert.equal(r.task.result, "refusedPaths");
  assert.ok(!work.calls.some((c) => c[0] === "commitAndPush"));
  assert.ok(!ops.writes.some((w) => w[0] === "createPull"));
  assert.ok(ops.writes.some((w) => w[0] === "addLabels" && w[2].includes("agent:blocked")));
});

test("a hand-off the team file does not allow stops for a person", async () => {
  const ops = fakeOps({ issues: [issue({ number: 10, labels: ["role:ui", "agent:ready"], assignees: ["ui-d"] })] });
  const r = await go({ login: "ui-d", ops, work: fakeWork(), claude: answer({ status: "done", summary: "s", next: "product" }) });
  assert.equal(r.task.result, "badHandoff");
  assert.ok(ops.writes.some((w) => w[0] === "addLabels" && w[2].includes("agent:blocked")));
});

test("needs_human / failed setup / unusable answer: blocked with a comment", async () => {
  for (const [claude, work, expect] of [
    [answer({ status: "needs_human", summary: "which design?", next: "dev", questions: ["A or B?"] }), fakeWork(), "human"],
    [answer({ status: "done", summary: "x", next: "done" }), fakeWork({ setupOk: false }), "failed"],
    [async () => "garbage", fakeWork(), "failed"],
  ]) {
    const ops = fakeOps({ issues: [issue({ number: 11, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
    const r = await go({ login: "dev-b", ops, work, claude });
    assert.equal(r.task.result, expect);
    assert.ok(ops.writes.some((w) => w[0] === "addLabels" && w[2].includes("agent:blocked")));
    assert.ok(work.calls.some((c) => c[0] === "cleanup"), "worktree cleaned up");
  }
});

test("no changes, done: comment and close the issue", async () => {
  const ops = fakeOps({ issues: [issue({ number: 12, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  const r = await go({ login: "dev-b", ops, work: fakeWork(), claude: answer({ status: "done", summary: "already fine", next: "done" }) });
  assert.equal(r.task.result, "done");
  assert.ok(ops.writes.some((w) => w[0] === "closeIssue" && w[1] === 12));
});

test("triage: assigns role-less ready issues, splits sub-tasks, hands to the chosen role", async () => {
  const ops = fakeOps({ issues: [issue({ number: 20, labels: ["agent:ready"], assignees: [] })] });
  const work = fakeWork();
  const r = await go({
    login: "lead-a",
    ops,
    work,
    claude: answer({ status: "done", summary: "It is a UI task", next: "ui", triage: { role: "ui", subtasks: [{ title: "Copy for @quiet-x", body: "write it", role: "product" }, { title: "bad", body: "", role: "ops" }] } }),
  });
  assert.deepEqual(r.assigned, [{ number: 20, role: "product", login: "lead-a" }]);
  assert.equal(r.task.result, "triaged:ui");
  assert.ok(!work.calls.some((c) => c[0] === "setup"), "triage runs no setup");
  const created = ops.writes.filter((w) => w[0] === "createIssue");
  assert.equal(created.length, 1, "sub-task with an unknown role is dropped");
  assert.doesNotMatch(created[0][2].title, /@q/);
  assert.deepEqual(created[0][2].labels, ["role:product", "agent:ready"]);
  const parent = (await ops.issuesWithLabel("agent:ready")).find((i) => i.number === 20);
  assert.ok(parent.labels.includes("role:ui"));
  assert.deepEqual(parent.assignees, ["ui-d"]);
});

test("comment mode: runs, comments, commits nothing, stops for a person", async () => {
  const ops = fakeOps({ issues: [issue({ number: 30, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  const work = fakeWork({ files: ["src/a.ts"] });
  const r = await go({ login: "dev-b", mode: "comment", ops, work, claude: answer({ status: "done", summary: "would fix", next: "product", pr: { title: "t", body: "b" } }) });
  assert.equal(r.task.result, "comment");
  assert.ok(!work.calls.some((c) => c[0] === "commitAndPush"));
  assert.ok(!ops.writes.some((w) => w[0] === "createPull"));
  assert.match(ops.writes.filter((w) => w[0] === "comment").at(-1)[2], /comment-only/);
});

test("housekeeping: stale working issue stopped; low agent PR queued once per head; medium reminded once", async () => {
  const pulls = [
    { number: 50, labels: ["risk:low"], headSha: "aaaaaaa1", ref: "agent/dev/1-R0", body: "" },
    { number: 51, labels: ["risk:medium"], headSha: "bbbbbbb1", ref: "agent/dev/2-R0", body: "" },
    { number: 52, labels: ["risk:low", "release"], headSha: "ccccccc1", ref: "agent/dev/3-R0", body: "" },
  ];
  const ops = fakeOps({ issues: [issue({ number: 40, labels: ["role:dev", "agent:working"], assignees: ["dev-b"] })], pulls });
  const r1 = await go({ login: "dev-b", ops, work: fakeWork(), claude: answer({}) });
  assert.deepEqual(r1.stale, [40]);
  assert.deepEqual(r1.queued, [50]);
  assert.deepEqual(r1.reminded, [51]);
  const reminder = ops.comments[51][0].body;
  assert.doesNotMatch(reminder, /^\s*\/signoff/m);
  // the queue ejected #50 (label gone): not re-queued for the same head; #51 not reminded twice
  pulls[0].labels = ["risk:low"];
  for (const n of [50, 51]) ops.comments[n] = ops.comments[n].map((c) => ({ ...c, login: "dev-b" }));
  const r2 = await go({ login: "dev-b", ops, work: fakeWork(), claude: answer({}) });
  assert.deepEqual(r2.queued, []);
  assert.deepEqual(r2.reminded, []);
});

test("parsePorcelainZ: raw non-ASCII paths, a leading-space status, renames as delete + add", () => {
  assert.deepEqual(parsePorcelainZ(" M keep.txt\0D  .github/保护.yml\0A  moved.yml\0?? .prd/写标/新.md\0"), ["keep.txt", ".github/保护.yml", "moved.yml", ".prd/写标/新.md"]);
});

test("a known secret in the changes: nothing is committed", async () => {
  const ops = fakeOps({ issues: [issue({ number: 60, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  const work = { ...fakeWork({ files: ["src/a.ts"] }), changedText: async () => "+const t = 'sk-ant-oat01-SECRETSECRET';" };
  const r = await go({ login: "dev-b", ops, work, secrets: ["sk-ant-oat01-SECRETSECRET"], claude: answer({ status: "done", summary: "s", next: "done", pr: { title: "t", body: "b" } }) });
  assert.equal(r.task.result, "failed");
  assert.ok(!work.calls.some((c) => c[0] === "commitAndPush"));
  assert.doesNotMatch(JSON.stringify(ops.writes), /SECRETSECRET/);
});

test("the commit message keeps model text neutralized (no live closing keyword or mention)", async () => {
  const ops = fakeOps({ issues: [issue({ number: 61, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  const work = fakeWork({ files: ["src/a.ts"] });
  await go({ login: "dev-b", ops, work, claude: answer({ status: "done", summary: "s", next: "done", pr: { title: "fix: closes #12 for @quiet-x", body: "b" } }) });
  const msg = work.calls.find((c) => c[0] === "commitAndPush")[2];
  assert.doesNotMatch(msg, /#12/);
  assert.doesNotMatch(msg, /@quiet/);
});

test("the PR body ends with the repository's PR template (its empty Closes line removed)", async () => {
  const ops = fakeOps({ issues: [issue({ number: 62, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  const work = { ...fakeWork({ files: ["src/a.ts"] }), readDefault: async (p) => (p === ".github/pull_request_template.md" ? "Closes #\n\n## Risk\n\n## Sign-off\n" : "# i") };
  await go({ login: "dev-b", ops, work, claude: answer({ status: "done", summary: "s", next: "done", pr: { title: "t", body: "b" } }) });
  const body = ops.writes.find((w) => w[0] === "createPull")[2].body;
  assert.match(body, /^Closes #62/);
  assert.match(body, /---\n\n## Risk\n\n## Sign-off$/);
  assert.equal(body.match(/Closes #/g).length, 1);
});

test("opening the PR fails after the push: an existing PR for the branch is used, otherwise the branch is named", async () => {
  for (const [existing, expect] of [[{ number: 77, url: "u" }, "review"], [null, "failed"]]) {
    const ops = fakeOps({ issues: [issue({ number: 63, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
    ops.createPull = async () => {
      throw new Error("fetch failed");
    };
    ops.openPullForBranch = async () => existing;
    const r = await go({ login: "dev-b", ops, work: fakeWork({ files: ["src/a.ts"] }), claude: answer({ status: "done", summary: "s", next: "done", pr: { title: "t", body: "b" } }) });
    assert.equal(r.task.result, expect);
    if (!existing) assert.match(ops.writes.filter((w) => w[0] === "comment").at(-1)[2], /agent\/dev\/63-R1/);
  }
});

test("stopping for a person keeps the work: a draft PR, linked in the blocked comment", async () => {
  const ops = fakeOps({ issues: [issue({ number: 64, labels: ["role:product", "agent:ready"], assignees: ["lead-a"] })] });
  const work = fakeWork({ files: [".prd/64-discount.md"] });
  const r = await go({ login: "lead-a", ops, work, claude: answer({ status: "needs_human", summary: "draft written", next: "ui", questions: ["Rounding?"], pr: { title: "docs: discount PRD", body: "b" } }) });
  assert.equal(r.task.result, "human");
  const pr = ops.writes.find((w) => w[0] === "createPull");
  assert.equal(pr[2].draft, true);
  assert.match(pr[2].body, /^Refs #64/);
  assert.match(ops.writes.filter((w) => w[0] === "comment").at(-1)[2], new RegExp(`#${pr[1]}`));
});

test("the next run continues the draft PR on its branch, updates it and marks it ready", async () => {
  const ops = fakeOps({ issues: [issue({ number: 65, labels: ["role:product", "agent:ready"], assignees: ["lead-a"] })] });
  const calls = [];
  ops.agentPullForIssue = async (login, n, role) => (n === 65 && role === "product" ? { number: 80, ref: "agent/product/65-R0", draft: true, nodeId: "PR_N" } : null);
  ops.updatePull = async (n, o) => calls.push(["updatePull", n, o]);
  ops.markReady = async (id) => calls.push(["markReady", id]);
  const work = fakeWork({ files: [".prd/65-discount.md"] });
  let prompt = "";
  const r = await go({ login: "lead-a", ops, work, claude: async (dir, p) => ((prompt = p), JSON.stringify({ structured_output: { status: "done", summary: "final", next: "ui", pr: { title: "docs: discount PRD", body: "b" } } })) });
  assert.equal(r.task.result, "handoff:ui");
  assert.deepEqual(work.calls.find((c) => c[0] === "prepare"), ["prepare", 65, "product", "agent/product/65-R0", null]);
  assert.match(work.calls.find((c) => c[0] === "commitAndPush")[1], /^agent\/product\/65-R0$/);
  assert.ok(!ops.writes.some((w) => w[0] === "createPull"), "no second PR");
  assert.equal(calls[0][0], "updatePull");
  assert.deepEqual(calls[1], ["markReady", "PR_N"]);
  assert.match(prompt, /continuing earlier work/);
});

test("a hand-off with a PR names its branch; the next role builds on it and targets it (stacked PR)", async () => {
  const ops = fakeOps({ issues: [issue({ number: 70, labels: ["role:product", "agent:ready"], assignees: ["lead-a"] })] });
  await go({ login: "lead-a", ops, work: fakeWork({ files: [".prd/70.md"] }), claude: answer({ status: "done", summary: "prd", next: "dev", pr: { title: "prd", body: "b" } }) });
  const handoff = ops.comments[70].at(-1).body;
  assert.match(handoff, /kind=handoff from=product to=dev branch=agent\/product\/70-R1/);
  // the dev machine (comments now come from lead-a's runner)
  ops.comments[70] = ops.comments[70].map((c) => ({ ...c, login: "lead-a" }));
  const work = fakeWork({ files: ["src/a.ts"] });
  let prompt = "";
  await go({ login: "dev-b", run: "R2", ops, work, claude: async (d, p) => ((prompt = p), JSON.stringify({ structured_output: { status: "done", summary: "code", next: "done", pr: { title: "feat", body: "b" } } })) });
  assert.deepEqual(work.calls.find((c) => c[0] === "prepare"), ["prepare", 70, "dev", null, "agent/product/70-R1"]);
  assert.equal(ops.writes.filter((w) => w[0] === "createPull").at(-1)[2].base, "agent/product/70-R1");
  assert.match(prompt, /previous role's branch `agent\/product\/70-R1`/);
  assert.match(prompt, /`Bash\(npm test \*\)`/);
});

test("priorBranch: only a participant's hand-off to this role, only an agent branch name", () => {
  const c = (login, body) => ({ login, body });
  const m = (f) => `x <!-- dev-process:agent ${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(" ")} -->`;
  const t = { people: [{ login: "lead-a" }] };
  assert.equal(priorBranch(t, [c("lead-a", m({ kind: "handoff", from: "product", to: "dev", branch: "agent/product/7-R1" }))], "dev"), "agent/product/7-R1");
  assert.equal(priorBranch(t, [c("outsider", m({ kind: "handoff", from: "product", to: "dev", branch: "agent/product/7-R1" }))], "dev"), null);
  assert.equal(priorBranch(t, [c("lead-a", m({ kind: "handoff", from: "product", to: "dev", branch: "main" }))], "dev"), null);
  assert.equal(priorBranch(t, [c("lead-a", m({ kind: "handoff", from: "product", to: "ui", branch: "agent/product/7-R1" }))], "dev"), null);
});

test("deniedActions lists refused commands; they are named in the issue comment", async () => {
  const raw = JSON.stringify({ structured_output: { status: "done", summary: "s", next: "done" }, permission_denials: [{ tool_name: "Bash", tool_input: { command: "cd x && npm test" } }] });
  assert.deepEqual(deniedActions(raw), ["cd x && npm test"]);
  const ops = fakeOps({ issues: [issue({ number: 71, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  await go({ login: "dev-b", ops, work: fakeWork({ files: ["src/a.ts"] }), claude: async () => raw });
  assert.match(ops.comments[71].at(-1).body, /cd x && npm test/);
});

test("finished with no change while earlier PRs are open: waits in review; closed once they all merge", async () => {
  const ops = fakeOps({ issues: [issue({ number: 90, labels: ["role:product", "agent:ready"], assignees: ["lead-a"] })] });
  let prs = [{ number: 91, state: "open", merged: false, ref: "agent/dev/90-R1" }];
  ops.pullsForIssue = async () => prs;
  const r = await go({ login: "lead-a", ops, work: fakeWork(), claude: answer({ status: "done", summary: "accepted", next: "done" }) });
  assert.equal(r.task.result, "review");
  assert.ok(!ops.writes.some((w) => w[0] === "closeIssue"));
  prs = [{ number: 91, state: "closed", merged: true, ref: "agent/dev/90-R1" }];
  const r2 = await go({ login: "lead-a", ops, work: fakeWork(), claude: answer({}) });
  assert.deepEqual(r2.closed, [90]);
  assert.ok(ops.writes.some((w) => w[0] === "closeIssue" && w[1] === 90));
});

test("a stacked PR says Refs even at the end of the chain", async () => {
  const ops = fakeOps({ issues: [issue({ number: 92, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  ops.comments[92] = [{ login: "lead-a", body: "x <!-- dev-process:agent run=R0 kind=handoff from=product to=dev branch=agent/product/92-R0 -->" }];
  await go({ login: "dev-b", ops, work: fakeWork({ files: ["src/a.ts"] }), claude: answer({ status: "done", summary: "s", next: "done", pr: { title: "t", body: "b" } }) });
  const pr = ops.writes.find((w) => w[0] === "createPull")[2];
  assert.equal(pr.base, "agent/product/92-R0");
  assert.match(pr.body, /^Refs #92/);
});

test("comment mode shows the verification, questions, hand-off notes and refused commands", async () => {
  const ops = fakeOps({ issues: [issue({ number: 72, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  const raw = JSON.stringify({
    structured_output: { status: "done", summary: "would fix", next: "product", handoff: "check the copy", questions: ["Rounding mode?"], pr: { title: "t", body: "b", verification: "npm test -- tests/a → 6 passed, 0 failed" } },
    permission_denials: [{ tool_name: "Bash", tool_input: { command: "npm test | tail" } }],
  });
  await go({ login: "dev-b", mode: "comment", ops, work: fakeWork({ files: ["src/a.ts"] }), claude: async () => raw });
  const body = ops.comments[72].at(-1).body;
  assert.match(body, /comment-only/);
  assert.match(body, /\*\*Verification\*\*/);
  assert.match(body, /6 passed, 0 failed/);
  assert.match(body, /Rounding mode\?/);
  assert.match(body, /check the copy/);
  assert.match(body, /npm test \| tail/);
  // nothing reported: says so
  const ops2 = fakeOps({ issues: [issue({ number: 73, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  await go({ login: "dev-b", mode: "comment", ops: ops2, work: fakeWork(), claude: answer({ status: "done", summary: "s", next: "done" }) });
  assert.match(ops2.comments[73].at(-1).body, /reported no verification commands/);
});

test("failureReason names why a run gave no answer; the failed comment carries it", async () => {
  assert.equal(failureReason(""), "Claude printed nothing");
  assert.equal(failureReason(JSON.stringify({ is_error: true, result: "Invalid API key · Please run /login" })), "Invalid API key · Please run /login");
  assert.equal(failureReason(JSON.stringify({ is_error: true, result: "claude exited 1: error: unknown option '--restricted'" })), "claude exited 1: error: unknown option '--restricted'");
  assert.match(failureReason(JSON.stringify({ type: "result", terminal_reason: "max_turns" })), /no structured answer \(max_turns\)/);
  assert.equal(failureReason("panic: something\nat x"), "panic: something at x");
  const ops = fakeOps({ issues: [issue({ number: 74, labels: ["role:dev", "agent:ready"], assignees: ["dev-b"] })] });
  const logs = [];
  await go({ login: "dev-b", ops, work: fakeWork(), log: (s) => logs.push(s), claude: async () => JSON.stringify({ is_error: true, result: "Invalid API key sk-ant-oat01-SECRETSECRETX" }), secrets: ["sk-ant-oat01-SECRETSECRETX"] });
  const body = ops.comments[74].at(-1).body;
  assert.match(body, /Invalid API key/);
  assert.doesNotMatch(body + logs.join(" "), /SECRETSECRETX/);
});
