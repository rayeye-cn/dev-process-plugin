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
  });
});

describe("policy from answers", () => {
  const a = validateAnswers(raw);
  const p = policyFrom(a);

  it("process files are always high; required checks follow the CI jobs; the release gate is skippable", () => {
    for (const x of [".github/**", "CLAUDE.md", ".dev-process/**", "src/auth/**"]) assert.ok(p.highPaths.includes(x), x);
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
    assert.ok(c.codeownersLines.includes("/CLAUDE.md @alice @bob"));
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
