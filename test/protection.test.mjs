// Branch protection derived from the policy, and the consistency checks of the process files.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyGithubRuleset } from "../engine/cli/apply-protection.mjs";
import { checkConsistency, codeownersToGlob, globToCodeowners, parseApplyTo, parseCodeowners, processPaths } from "../engine/core/consistency.mjs";
import { tr } from "../engine/core/messages/index.mjs";
import { githubRuleset, requiredContexts, RULESET_NAME } from "../engine/core/protection.mjs";
import { withDefaults } from "../engine/core/policy.mjs";
import { policy } from "./helpers.mjs";

describe("GitHub ruleset", () => {
  it("self-built queue: 0 base approvals, stale dismissed, code owners, threads, merge commits, checks bound to Actions", () => {
    const rs = githubRuleset({ ...policy, checks: { required: ["checks", "tests"], skippable: ["pack-gate"] } });
    assert.equal(rs.name, RULESET_NAME);
    assert.deepEqual(rs.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
    assert.deepEqual(rs.bypass_actors, [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }]);
    const pr = rs.rules.find((r) => r.type === "pull_request").parameters;
    assert.equal(pr.required_approving_review_count, 0);
    assert.equal(pr.dismiss_stale_reviews_on_push, true);
    assert.equal(pr.require_code_owner_review, true);
    assert.equal(pr.required_review_thread_resolution, true);
    assert.deepEqual(pr.allowed_merge_methods, ["merge"]);
    const checks = rs.rules.find((r) => r.type === "required_status_checks").parameters.required_status_checks;
    assert.deepEqual(checks.map((c) => c.context), ["checks", "tests", "pack-gate", "risk-gate", "merge-queue"]);
    assert.ok(checks.every((c) => c.integration_id === 15368));
    assert.equal(rs.rules.some((r) => r.type === "merge_queue"), false);
  });

  it("native queue: merge_queue rule instead of the queue status; names and method follow the policy", () => {
    const p = withDefaults({ queue: { mode: "native", mergeMethod: "squash" }, names: { gateContext: "gate" } });
    const rs = githubRuleset(p);
    assert.deepEqual(requiredContexts(p), ["checks", "tests", "gate"]);
    assert.equal(rs.rules.find((r) => r.type === "merge_queue").parameters.merge_method, "SQUASH");
    assert.deepEqual(rs.rules.find((r) => r.type === "pull_request").parameters.allowed_merge_methods, ["squash"]);
  });

  it("apply: updates the ruleset found by name, creates it otherwise; dry run writes nothing", async () => {
    const calls = [];
    const forge = (existing) => ({
      owner: "o",
      name: "r",
      rest: {
        get: async (u) => (calls.push(["GET", u]), existing),
        put: async (u, b) => (calls.push(["PUT", u]), { id: 9, name: b.name, enforcement: "active" }),
        post: async (u, b) => (calls.push(["POST", u]), { id: 10, name: b.name, enforcement: "active" }),
      },
    });
    const quiet = { log: () => {} };
    assert.equal((await applyGithubRuleset(forge([{ id: 9, name: RULESET_NAME }]), policy, quiet)).action, "update");
    assert.deepEqual(calls.at(-1), ["PUT", "/repos/o/r/rulesets/9"]);
    assert.equal((await applyGithubRuleset(forge([{ id: 1, name: "other" }]), policy, quiet)).action, "create");
    assert.deepEqual(calls.at(-1), ["POST", "/repos/o/r/rulesets"]);
    const before = calls.length;
    await applyGithubRuleset(forge([]), policy, { ...quiet, dryRun: true });
    assert.equal(calls.length, before + 1); // only the GET
  });
});

describe("consistency of the process files", () => {
  const good = withDefaults({
    trustedAuthors: ["alice", "bob"],
    highPaths: [".github/**", "**/CLAUDE.md", ".claude/**", ".mcp.json", ".dev-process/**", "src/update/**"],
    securityPaths: ["src/update/**"],
    lowOnlyPaths: ["docs/**"],
  });
  const codeowners = ["# owners", ...good.highPaths.map((g) => `${globToCodeowners(g)} @alice @bob`)].join("\n");
  const claudeMd = "sign with `/signoff <head sha>`; waive with `/waive-ai-review <head sha>`";
  const applyTo = '---\napplyTo: "src/update/**"\n---\nrules';
  const tracked = [".github/workflows/ci.yml", "CLAUDE.md", ".dev-process/config.json", "src/update/a.ts", "docs/a.md"];
  const codesOf = (fs) => fs.map((f) => f.code);

  it("a consistent setup has no findings", () => {
    assert.deepEqual(checkConsistency({ policy: good, codeowners, applyTo, claudeMd, tracked }), []);
  });

  it("CODEOWNERS ↔ highPaths, round-trips the pattern shapes, owners trusted and at least two", () => {
    assert.equal(codeownersToGlob("/src/update/"), "src/update/**");
    assert.equal(codeownersToGlob("/CLAUDE.md"), "CLAUDE.md");
    assert.equal(globToCodeowners("src/update/**"), "/src/update/");
    assert.deepEqual(parseCodeowners("/a/ @x @org/team\n# c\n[Section]\n"), [{ glob: "a/**", owners: ["x", "org/team"] }]);
    const drift = checkConsistency({ policy: good, codeowners: codeowners.replace("/src/update/ @alice @bob", "/src/other/ @alice @carol") });
    assert.deepEqual(codesOf(drift).sort(), ["consistency.codeownersMismatch", "consistency.ownerNotTrusted"]);
    const one = checkConsistency({ policy: good, codeowners: codeowners.replace("/CLAUDE.md @alice @bob", "/CLAUDE.md @alice") });
    assert.deepEqual(codesOf(one), ["consistency.singleOwner"]);
    assert.equal(one[0].level, "warn");
  });

  it("applyTo ↔ securityPaths", () => {
    assert.deepEqual(parseApplyTo(applyTo), ["src/update/**"]);
    assert.equal(parseApplyTo("no front matter"), null);
    assert.deepEqual(codesOf(checkConsistency({ policy: good, applyTo: '---\napplyTo: "x/**"\n---' })), ["consistency.applyToMismatch"]);
    assert.deepEqual(codesOf(checkConsistency({ policy: good, applyTo: "none" })), ["consistency.applyToMissing"]);
  });

  it("process files are high, per forge", () => {
    assert.deepEqual(processPaths(good), [".github/**", "**/CLAUDE.md", ".claude/**", ".mcp.json", ".dev-process/**"]);
    assert.deepEqual(processPaths({ ...good, forge: "gitlab" }), [".gitlab-ci.yml", ".gitlab/**", "**/CLAUDE.md", ".claude/**", ".mcp.json", ".dev-process/**"]);
    assert.deepEqual(processPaths(good).map(globToCodeowners), ["/.github/", "/**/CLAUDE.md", "/.claude/", "/.mcp.json", "/.dev-process/"]);
    const f = checkConsistency({ policy: { ...good, highPaths: ["src/update/**"] } });
    assert.deepEqual(codesOf(f), ["consistency.processNotHigh"]);
  });

  it("commands: waiver differs from sign-off, costs an approval, and CLAUDE.md names both", () => {
    const f = checkConsistency({ policy: { ...good, commands: { signoff: "/x", waiver: "/x" }, aiReviewWaiverExtraApprovals: 0 }, claudeMd: "" });
    assert.deepEqual(codesOf(f).sort(), ["consistency.claudeMdSignoff", "consistency.claudeMdWaiver", "consistency.waiverFree", "consistency.waiverIsSignoff"]);
  });

  it("people per tier: monotonic, low none, high two; a one-person team is a warning", () => {
    assert.deepEqual(codesOf(checkConsistency({ policy: { ...good, requiredHumans: { low: 1, medium: 0, high: 1 } } })).sort(), [
      "consistency.highUnderTwo",
      "consistency.humansDecrease",
      "consistency.lowNeedsPeople",
    ]);
    const solo = checkConsistency({ policy: { ...good, trustedAuthors: ["alice"] } });
    assert.deepEqual(codesOf(solo), ["consistency.oneTrustedAuthor"]);
    assert.equal(solo[0].level, "warn");
  });

  it("tracked files: none both high and low; every high/security glob matches something", () => {
    const f = checkConsistency({ policy: { ...good, lowOnlyPaths: ["docs/**", "CLAUDE.md"], highPaths: [...good.highPaths, "src/nothing/**"] }, tracked });
    assert.deepEqual(codesOf(f).sort(), ["consistency.deadGlobs", "consistency.highAndLow"]);
    assert.deepEqual(f.find((x) => x.code === "consistency.highAndLow").params.files, ["CLAUDE.md"]);
  });

  it("every finding renders in both languages", () => {
    const f = checkConsistency({
      policy: { ...good, commands: { signoff: "/x", waiver: "/x" }, requiredHumans: { low: 1, medium: 0, high: 1 }, trustedAuthors: ["alice"], highPaths: ["nope/**"] },
      codeowners: "/a/ @z",
      applyTo: "x",
      claudeMd: "",
      tracked,
    });
    assert.ok(f.length >= 8);
    for (const x of f) for (const lang of ["zh", "en"]) assert.equal(typeof tr(lang, x), "string");
  });
});
