// Answers validation, policy derivation and the template context contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { AnswersError, validateAnswers } from "../tools/answers.mjs";
import { aiCliFor, buildContext, instructionPaths, policyFrom, stepsYaml, yamlScalar } from "../tools/context.mjs";
import { WORKFLOW_STRINGS } from "../templates/github/strings.mjs";

const raw = JSON.parse(readFileSync(new URL("./fixtures/answers.json", import.meta.url), "utf8"));

describe("answers", () => {
  it("the fixture validates and keeps its values", () => {
    const a = validateAnswers(raw);
    assert.equal(a.language, "zh");
    assert.deepEqual(a.people.codeOwners, ["alice", "bob"]);
    assert.equal(a.ci.releaseGate.timeoutMin, 90);
    assert.deepEqual(a.ci.setup[0], { uses: "actions/setup-node@v4", with: { "node-version": 24, cache: "npm" } });
  });

  it("defaults: code owners and on-call fall back to trusted authors; loops on; lowOnly docs", () => {
    const a = validateAnswers({ project: { name: "x" }, repo: "o/r", defaultBranch: "main", people: { trustedAuthors: ["a1"] }, ci: { tests: [{ run: "make test" }] } });
    assert.deepEqual(a.people.codeOwners, ["a1"]);
    assert.deepEqual(a.people.onCall, ["a1"]);
    assert.deepEqual(a.loops, { sweep: true, eval: true, metrics: true });
    assert.deepEqual(a.paths.lowOnly, ["docs/**"]);
    assert.equal(a.ci.releaseGate, null);
  });

  it("errors name the field", () => {
    const bad = (over, re) => assert.throws(() => validateAnswers({ ...raw, ...over }), (e) => e instanceof AnswersError && re.test(e.message));
    bad({ repo: "nope" }, /answers\.repo/);
    bad({ language: "fr" }, /answers\.language/);
    bad({ reviewer: "x" }, /answers\.reviewer/);
    bad({ people: { trustedAuthors: [] } }, /people\.trustedAuthors/);
    bad({ people: { trustedAuthors: ["bad login!"] } }, /people\.trustedAuthors\[0\]/);
    bad({ ci: { checks: [{ run: "a", uses: "b" }] } }, /ci\.checks\[0\]/);
    bad({ ci: {} }, /answers\.ci/);
    bad({ queue: { mode: "train" } }, /queue\.mode/);
    bad({ ci: { ...raw.ci, testsRunner: "self-hosted", selfHostedLabels: [] } }, /ci\.selfHostedLabels/);
    bad({ ci: { ...raw.ci, testsRunner: "hosted", selfHostedLabels: [] } }, /ci\.selfHostedLabels/); // the fixture's release gate is self-hosted
  });

  it("runner labels may be empty when nothing runs self-hosted (found in the sandbox E2E)", () => {
    const a = validateAnswers({ ...raw, ci: { ...raw.ci, testsRunner: "hosted", releaseGate: { ...raw.ci.releaseGate, runner: "hosted" }, selfHostedLabels: [] } });
    assert.deepEqual(a.ci.selfHostedLabels, []);
  });
});

describe("answers: GitLab", () => {
  const gl = (over = {}) => ({
    forge: "gitlab",
    gitlab: { url: "https://gitlab.example.com/", tier: "free" },
    project: { name: "x" },
    repo: "grp/sub/app",
    defaultBranch: "main",
    people: { trustedAuthors: ["john.doe", "dev_1"] },
    ci: { tests: [{ run: "npm test" }] },
    ...over,
  });
  it("nested groups, dotted usernames, Claude by default, an image for the jobs, the URL without a trailing slash", () => {
    const a = validateAnswers(gl());
    assert.equal(a.forge, "gitlab");
    assert.deepEqual(a.gitlab, { url: "https://gitlab.example.com", tier: "free" });
    assert.equal(a.reviewer, "claude");
    assert.equal(a.repo, "grp/sub/app");
    assert.equal(a.ci.image, "node:24");
    assert.equal(a.queue.mode, "self");
    assert.equal(validateAnswers({ ...gl(), gitlab: { url: "https://gl.x", tier: "premium" }, queue: { mode: "train" } }).queue.mode, "train");
  });
  it("refuses Copilot, GitHub actions as steps, merge trains on Free, the native GitHub queue, a bad URL", () => {
    const bad = (over, re) => assert.throws(() => validateAnswers(gl(over)), (e) => e instanceof AnswersError && re.test(e.message));
    bad({ reviewer: "copilot" }, /copilot is only available on GitHub/);
    bad({ ci: { tests: [{ uses: "actions/setup-node@v4" }] } }, /ci\.tests\[0\].*run, not uses/);
    bad({ queue: { mode: "train" } }, /merge trains need GitLab Premium/);
    bad({ queue: { mode: "native" } }, /queue\.mode/);
    bad({ gitlab: { url: "gitlab.example.com" } }, /gitlab\.url/);
    bad({ repo: "app" }, /group\/…\/name/);
  });
  it("renders the GitLab names and schedules into the policy", () => {
    const c = buildContext(validateAnswers(gl({ loops: { sweep: false, eval: true, metrics: true } })));
    assert.deepEqual([c.policy.names.ciWorkflow, c.policy.names.gateWorkflow, c.policy.names.queueWorkflow, c.policy.names.aiReviewWorkflow], ["ci", "risk-gate", "merge-queue", "ai-review"]);
    assert.deepEqual(c.policy.gitlab, { url: "https://gitlab.example.com", tier: "free", schedules: ["poll", "metrics"] });
    assert.equal(c.loops.eval, false, "the review eval is not ported to GitLab yet");
    assert.equal(c.ciFile, ".gitlab-ci.yml");
  });
});

describe("policy from answers", () => {
  const a = validateAnswers(raw);
  const p = policyFrom(a);

  it("process files are always high; required checks follow the CI jobs; the release gate is skippable", () => {
    for (const x of [".github/**", "**/CLAUDE.md", ".claude/**", ".mcp.json", ".dev-process/**", "src/auth/**"]) assert.ok(p.highPaths.includes(x), x);
    assert.deepEqual(p.checks, { required: ["checks", "tests"], skippable: ["release-gate"] });
    assert.equal(p.queue.ciTimeoutMin, 180); // heavy release gate
    assert.equal(policyFrom({ ...a, ci: { ...a.ci, releaseGate: null } }).queue.ciTimeoutMin, 120);
  });

  it("instruction paths follow the reviewer", () => {
    assert.deepEqual(p.paths.instructions, instructionPaths("copilot").instructions);
    assert.equal(policyFrom({ ...a, reviewer: "claude" }).paths.security, ".dev-process/ai-review/security.md");
  });
});

describe("context", () => {
  it("YAML helpers: safe scalars stay plain, others are quoted; steps render as a block", () => {
    assert.equal(yamlScalar("npm test"), "npm test");
    assert.equal(yamlScalar("a: b"), '"a: b"');
    assert.equal(yamlScalar("yes"), '"yes"');
    assert.equal(yamlScalar(24), "24");
    assert.equal(
      stepsYaml([{ uses: "actions/setup-node@v4", with: { "node-version": 24 } }, { name: "Build", run: "npm ci\nnpm run build" }, { run: "echo ${{ github.sha }}" }]),
      [
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 24",
        "      - name: Build",
        "        run: |",
        "          npm ci",
        "          npm run build",
        '      - run: "echo ${{ github.sha }}"',
      ].join("\n"),
    );
  });

  it("the context carries the documented fields", () => {
    const c = buildContext(validateAnswers(raw));
    assert.equal(c.pr, "PR");
    assert.equal(c.ai, "Copilot");
    assert.equal(c.isCopilot, true);
    assert.equal(c.ci.testsRunsOn, "ubuntu-latest");
    assert.equal(c.ci.releaseGate.runsOn, '["self-hosted","macOS"]');
    assert.equal(c.queue.jobTimeoutMin, 200);
    assert.ok(c.codeownersLines.includes("/src/auth/ @alice @bob"));
    assert.ok(c.codeownersLines.includes("/**/CLAUDE.md @alice @bob"));
    assert.equal(c.loops.sweep, true);
    assert.equal(buildContext(validateAnswers({ ...raw, paths: { ...raw.paths, security: [] } })).loops.sweep, false);
    assert.equal(c.s, WORKFLOW_STRINGS.zh);
  });

  it("AI CLI commands per reviewer family read the prompt and output files from the environment", () => {
    for (const id of ["copilot", "claude"]) {
      const cli = aiCliFor(id);
      for (const cmd of [cli.noTools, cli.readOnly]) {
        assert.ok(cmd.includes('"$PROMPT_FILE"') && cmd.includes('"$OUT_FILE"'), `${id}: ${cmd}`);
      }
    }
    assert.match(aiCliFor("claude").readOnly, /--tools "Read,Grep,Glob"/);
    assert.match(aiCliFor("claude").envYaml, /secrets\.ANTHROPIC_API_KEY/);
    assert.equal(aiCliFor("copilot").permission, "copilot-requests: write");
  });

  it("workflow strings have the same keys in both languages", () => {
    assert.deepEqual(Object.keys(WORKFLOW_STRINGS.en).sort(), Object.keys(WORKFLOW_STRINGS.zh).sort());
  });
});
