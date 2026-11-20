// GitLab setup (apply-protection on GitLab) against an in-memory GitLab: what a fresh project gets, idempotence, warnings.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyGitlab } from "../engine/cli/apply-protection.mjs";
import { gitlabFindings } from "../engine/cli/doctor.mjs";
import { tr } from "../engine/core/messages/index.mjs";
import { gitlabPlan } from "../engine/core/protection.mjs";
import { createGitlab } from "../engine/forge/gitlab.mjs";
import { policy } from "./helpers.mjs";

const P = "/projects/grp%2Fapp";
const BOT = "project_9_bot_ab12";
const pol = { ...policy, forge: "gitlab", reviewer: "claude", gitlab: { url: "https://gl.example", tier: "free", schedules: ["poll", "metrics"] } };

/** A tiny GitLab: a project, its protected branches, variables, triggers, schedules, hooks and members; two tokens. */
function world({ blockHooks = false, members = [], branches = [], tokens = [] } = {}) {
  const st = { project: { id: 9, default_branch: "main", only_allow_merge_if_pipeline_succeeds: false }, protected: null, variables: [], triggers: [], schedules: [], hooks: [], writes: [] };
  const who = (init) => (init.headers["private-token"] === "glpat-bot-token-123456" ? BOT : "owner");
  const routes = [
    ["GET", /^\/user$/, (b, init) => ({ username: who(init), bot: who(init) === BOT })],
    ["GET", new RegExp(`^${P}$`), () => st.project],
    ["PUT", new RegExp(`^${P}$`), (b) => Object.assign(st.project, b)],
    ["GET", new RegExp(`^${P}/protected_branches/main$`), () => st.protected ?? { status: 404 }],
    ["DELETE", new RegExp(`^${P}/protected_branches/main$`), () => ((st.protected = null), null)],
    ["POST", new RegExp(`^${P}/protected_branches$`), (b) => (st.protected = { name: b.name, push_access_levels: [{ access_level: b.push_access_level }], merge_access_levels: [{ access_level: b.merge_access_level }], allow_force_push: b.allow_force_push })],
    ["GET", new RegExp(`^${P}/variables\\?`), () => st.variables],
    ["DELETE", new RegExp(`^${P}/variables/(\\w+)\\?filter\\[environment_scope\\]=(.+)$`), (b, i, m) => ((st.variables = st.variables.filter((v) => !(v.key === m[1] && v.environment_scope === decodeURIComponent(m[2])))), null)],
    ["GET", new RegExp(`^${P}/variables/(\\w+)`), (b, i, m) => st.variables.find((v) => v.key === m[1]) ?? { status: 404 }],
    ["POST", new RegExp(`^${P}/variables$`), (b) => (st.variables.push(b), b)],
    ["POST", new RegExp(`^${P}/access_tokens$`), () => ({ token: "glpat-bot-token-123456", user_id: 77 })],
    ["GET", new RegExp(`^${P}/triggers$`), () => st.triggers],
    ["POST", new RegExp(`^${P}/triggers$`), (b, init) => (st.triggers.push({ description: b.description, token: "trig-1", owner: { username: who(init) } }), st.triggers.at(-1))],
    ["GET", new RegExp(`^${P}/pipeline_schedules`), () => st.schedules],
    ["POST", new RegExp(`^${P}/pipeline_schedules$`), (b, init) => (st.schedules.push({ ...b, id: st.schedules.length + 1, owner: { username: who(init) } }), st.schedules.at(-1))],
    ["POST", new RegExp(`^${P}/pipeline_schedules/(\\d+)/variables$`), (b, i, m) => ((st.schedules[Number(m[1]) - 1].variables = [b]), b)],
    ["GET", new RegExp(`^${P}/hooks$`), () => st.hooks],
    ["POST", new RegExp(`^${P}/hooks$`), (b) => (blockHooks ? { status: 422, message: "Invalid url given" } : (st.hooks.push({ id: 1, ...b }), st.hooks.at(-1)))],
    ["POST", new RegExp(`^${P}/labels$`), () => ({ id: 1 })],
    ["GET", new RegExp(`^${P}/members/all`), () => members],
    ["GET", new RegExp(`^${P}/protected_branches\\?`), () => branches],
    ["GET", new RegExp(`^${P}/access_tokens`), () => tokens],
  ];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v4/, "") + u.search;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (method !== "GET") st.writes.push([method, path.replace(/\?.*/, ""), who(init)]);
    for (const [m, re, fn] of routes) {
      const mm = m === method && re.exec(path);
      if (!mm) continue;
      const out = fn(body, init, mm);
      if (out && out.status) return new Response(JSON.stringify({ message: out.message ?? "404 Not found" }), { status: out.status });
      return new Response(JSON.stringify(out), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "404 Not found" }), { status: 404 });
  };
  return { st, fetch };
}
const ENV = { GITLAB_TOKEN: "glpat-owner-token", ANTHROPIC_API_KEY: "sk-ant-x" };
const run = async (w, opts = {}) => {
  const forge = await createGitlab({ repo: "grp/app", url: "https://gl.example", env: ENV, fetch: w.fetch }).ready();
  return applyGitlab(forge, pol, { env: ENV, fetch: w.fetch, log: () => {}, today: new Date("2026-11-20T00:00:00Z"), ...opts });
};
const summary = (r) => r.actions.map((a) => `${a.action} ${a.code}`);

describe("GitLab setup", () => {
  it("the plan: Free protects the branch and turns on the merge checks; Premium adds approval settings; schedules follow the policy", () => {
    const free = gitlabPlan(pol, { defaultBranch: "main" });
    assert.deepEqual(free.protectedBranch, { name: "main", push_access_level: 0, merge_access_level: 40, unprotect_access_level: 40, allow_force_push: false });
    assert.equal(free.approvals, undefined);
    assert.deepEqual(free.schedules.map((x) => x.task), ["poll", "metrics"]);
    const premium = gitlabPlan({ ...pol, gitlab: { ...pol.gitlab, tier: "premium" } }, { defaultBranch: "main" });
    assert.equal(premium.protectedBranch.code_owner_approval_required, true);
    assert.equal(premium.approvals.reset_approvals_on_push, true);
  });

  it("dry run on a fresh project: only reads, lists everything to create", async () => {
    const w = world();
    const r = await run(w, { dryRun: true });
    assert.deepEqual(w.st.writes, []);
    assert.deepEqual(summary(r).slice(0, 4), ["create gitlab.branch", "update gitlab.settings", "create gitlab.botToken", "create gitlab.apiKey"]);
  });

  it("for real: the token as a protected, masked, environment-scoped variable; trigger and schedules owned by the bot; the webhook to the trigger; a second run changes nothing", async () => {
    const w = world();
    await run(w);
    assert.deepEqual(w.st.protected.push_access_levels, [{ access_level: 0 }]);
    assert.equal(w.st.project.only_allow_merge_if_pipeline_succeeds, true);
    const tv = w.st.variables.find((v) => v.key === "DEV_PROCESS_TOKEN");
    assert.deepEqual([tv.protected, tv.masked, tv.environment_scope], [true, true, "dev-process-bot"]);
    assert.equal(w.st.variables.find((v) => v.key === "ANTHROPIC_API_KEY").protected, true);
    assert.deepEqual(w.st.triggers.map((x) => x.owner.username), [BOT]);
    assert.deepEqual(w.st.schedules.map((x) => [x.owner.username, x.variables[0].value]), [[BOT, "poll"], [BOT, "metrics"]]);
    const hook = w.st.hooks[0];
    assert.equal(hook.url, "https://gl.example/api/v4/projects/9/ref/main/trigger/pipeline?token={token}");
    assert.deepEqual(hook.url_variables, [{ key: "token", value: "trig-1" }]);
    assert.equal(hook.note_events && hook.merge_requests_events, true);
    assert.equal(hook.pipeline_events, false, "a trigger's own pipeline events would loop");
    assert.equal(w.st.project.merge_method, "merge");

    const before = w.st.writes.length;
    const again = await run(w);
    assert.ok(again.actions.every((a) => a.action === "ok"), JSON.stringify(summary(again)));
    assert.deepEqual(w.st.writes.slice(before).map(([m, p]) => `${m} ${p}`), [`POST ${P}/labels`], "only the label upsert writes");
  });

  it("a DEV_PROCESS_TOKEN with another environment scope is removed (the review job would read it)", async () => {
    const w = world();
    w.st.variables.push({ key: "DEV_PROCESS_TOKEN", value: "glpat-old-0000000000", environment_scope: "*", protected: true, masked: true });
    const r = await run(w);
    assert.ok(summary(r).includes("update gitlab.botTokenStray"));
    assert.deepEqual(w.st.variables.filter((v) => v.key === "DEV_PROCESS_TOKEN").map((v) => v.environment_scope), ["dev-process-bot"]);
  });

  it("a webhook the instance refuses is a warning (the poll still works); human Maintainers are warned", async () => {
    const w = world({ blockHooks: true, members: [{ username: "alice", access_level: 40 }, { username: BOT, access_level: 40, bot: true }, { username: "dev", access_level: 30 }] });
    const r = await run(w);
    assert.ok(summary(r).includes("warn gitlab.webhookBlocked"));
    assert.deepEqual(r.actions.find((a) => a.code === "gitlab.humanMaintainers").params.logins, ["alice"]);
  });
});

describe("doctor --remote on GitLab", () => {
  const doctor = async (w, now = new Date("2026-11-20T00:00:00Z")) => {
    const forge = await createGitlab({ repo: "grp/app", url: "https://gl.example", env: ENV, fetch: w.fetch }).ready();
    return gitlabFindings(forge, pol, { now, fetch: w.fetch });
  };
  it("a fresh project: the missing protection, settings and bot token are errors; nothing is written", async () => {
    const w = world();
    const found = await doctor(w);
    assert.deepEqual(w.st.writes, []);
    const errors = found.filter((x) => x.level === "error").map((x) => x.params.code);
    for (const c of ["gitlab.branch", "gitlab.settings", "gitlab.botToken"]) assert.ok(errors.includes(c), c);
    for (const x of found) for (const lang of ["zh", "en"]) assert.equal(typeof tr(lang, x), "string");
  });
  it("after the setup: clean, except what only doctor sees — a wildcard protected branch, a token about to expire", async () => {
    const w = world({ branches: [{ name: "main" }, { name: "release/*" }], tokens: [{ name: "dev-process-bot", active: true, expires_at: "2026-11-25" }] });
    await applyGitlab(await createGitlab({ repo: "grp/app", url: "https://gl.example", env: ENV, fetch: w.fetch }).ready(), pol, { env: ENV, fetch: w.fetch, log: () => {} });
    const found = await doctor(w);
    assert.deepEqual(found.map((x) => [x.level, x.code, x.params.code ?? x.params.days]), [["error", "doctor.gitlab.setup", "gitlab.wildcardBranch"], ["error", "doctor.gitlab.tokenExpiry", 5]]);
  });
});

