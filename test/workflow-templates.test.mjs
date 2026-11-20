// GitHub workflow templates: every template renders for every supported combination of answers, the output is
// structurally sound YAML (a small structural checker below; the plugin has no YAML dependency), and the properties the
// reference implementation relies on (who may check out what, which job holds which permission, the required check
// names, the merge-queue wake-up) hold in the rendered text.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { requiredContexts } from "../engine/core/protection.mjs";
import { validateAnswers } from "../tools/answers.mjs";
import { aiCliFor, buildContext, instructionPaths, policyFrom } from "../tools/context.mjs";
import { renderTemplate } from "../tools/template.mjs";
import { WORKFLOW_STRINGS } from "../templates/github/strings.mjs";

const raw = JSON.parse(readFileSync(new URL("./fixtures/answers.json", import.meta.url), "utf8"));
const WORKFLOWS = ["ci", "risk-gate", "risk-gate-events", "merge-queue", "nightly-review", "review-eval", "review-metrics"];
const templateOf = (w) => readFileSync(new URL(`../templates/github/workflows/${w}.yml.tmpl`, import.meta.url), "utf8");

/** Fixture answers with overrides (`ci` merged one level deep). */
const answersWith = (over = {}) => ({ ...raw, ...over, ci: { ...raw.ci, ...(over.ci ?? {}) } });

/**
 * Context for answers. The Claude reviewer adapter (engine/reviewer) is not there yet, so buildContext rejects
 * `reviewer: "claude"`; until it lands, derive the Claude context from the Copilot one by replacing every field the
 * contract says depends on the reviewer. Once the adapter exists, the real buildContext is used.
 */
function contextFor(over) {
  const a = validateAnswers(answersWith(over));
  try {
    return buildContext(a);
  } catch (e) {
    if (a.reviewer !== "claude" || !/unknown reviewer/.test(e.message)) throw e;
    const c = buildContext({ ...a, reviewer: "copilot" });
    const paths = instructionPaths("claude");
    return { ...c, reviewer: "claude", ai: "Claude", isCopilot: false, isClaude: true, policy: policyFrom(a), instructionsPath: paths.instructions, securityPath: paths.security, aiCli: aiCliFor("claude") };
  }
}

const VARIANTS = {
  "fixture (zh, Copilot, hosted tests, self-hosted release gate, classifier, self queue)": {},
  "en, Claude": { language: "en", reviewer: "claude" },
  "self-hosted tests": { ci: { testsRunner: "self-hosted" } },
  "hosted release gate": { ci: { releaseGate: { ...raw.ci.releaseGate, runner: "hosted" } } },
  "no release gate": { ci: { releaseGate: null } },
  "classifier off": { classifier: false },
  "native queue": { queue: { mode: "native" } },
  "checks only, no setup steps": { ci: { setup: [], tests: [] } },
  "en, Claude, tests only on self-hosted, no release gate, classifier off, native queue": {
    language: "en",
    reviewer: "claude",
    classifier: false,
    queue: { mode: "native" },
    ci: { checks: [], testsRunner: "self-hosted", releaseGate: null },
  },
};

const rendered = Object.entries(VARIANTS).map(([name, over]) => {
  const ctx = contextFor(over);
  const files = Object.fromEntries(WORKFLOWS.map((w) => [w, renderTemplate(templateOf(w), ctx, `${w}.yml.tmpl`)]));
  return { name, ctx, files };
});
const each = (fn) => {
  for (const r of rendered) fn(r);
};

/* ───────────────────────────── a structural YAML checker ───────────────────────────── */

/**
 * Checks the YAML subset the workflows use: block mappings and sequences indented by exactly 2 per level, `|` / `>-`
 * block scalars, quoted and plain scalars, one-line flow collections. Reports tabs, trailing whitespace, odd or
 * inconsistent indentation, a sequence under a key at the key's own indentation, keys mixed with items, duplicate keys,
 * keys without a value (only events under `on:` may be empty), and plain scalars YAML would misread (`: ` inside,
 * indicator first character, unbalanced `${{ }}`).
 * @returns `{ errors, top }` (top: the top-level keys in order)
 */
export function yamlShape(text) {
  const errors = [];
  const top = [];
  const at = (i, m) => errors.push(`line ${i + 1}: ${m}`);
  const checkScalar = (v, i) => {
    if (v.startsWith('"')) return /^"(?:[^"\\]|\\.)*"(?:\s+#.*)?$/.test(v) || at(i, `bad double-quoted scalar: ${v}`);
    if (v.startsWith("'")) return /^'(?:[^']|'')*'(?:\s+#.*)?$/.test(v) || at(i, `bad single-quoted scalar: ${v}`);
    if (v.startsWith("[")) return /^\[[^[\]{}]*\](?:\s+#.*)?$/.test(v) || at(i, `bad flow sequence: ${v}`);
    if (v.startsWith("{")) return /^\{\}(?:\s+#.*)?$/.test(v) || at(i, `bad flow mapping: ${v}`);
    const plain = v.replace(/\s+#.*$/, "");
    if (/^[!&*%@`|>?,]|^- /.test(plain)) at(i, `plain scalar starts with an indicator: ${v}`);
    if (/: |:$/.test(plain)) at(i, `plain scalar contains ": ": ${v}`);
    if ((plain.match(/\$\{\{/g) ?? []).length !== (plain.match(/\}\}/g) ?? []).length) at(i, `unbalanced \${{ }}: ${v}`);
    return true;
  };
  // Open blocks: indentation, what they hold ("map" | "seq" | "scalar" | null), their keys, the key that opened them.
  const stack = [{ indent: 0, kind: null, keys: new Set(), under: null }];
  let pending = null; // `key:` with nothing after it, waiting for its nested block
  let scalarAt = -1; // indentation of the key that opened a block scalar; deeper lines are its text
  text.split("\n").forEach((line, i) => {
    if (line.includes("\t")) at(i, "tab character");
    if (/[ \t]$/.test(line)) at(i, "trailing whitespace");
    if (!line.trim()) return;
    const indent = line.length - line.trimStart().length;
    if (scalarAt >= 0) {
      if (indent > scalarAt) return;
      scalarAt = -1;
    }
    let body = line.slice(indent);
    if (body.startsWith("#")) return;
    if (indent % 2) at(i, `odd indentation ${indent}`);
    if (pending) {
      if (indent > pending.indent) {
        if (indent !== pending.indent + 2) at(i, `"${pending.key}" must be followed by indentation ${pending.indent + 2}, got ${indent}`);
        stack.push({ indent, kind: null, keys: new Set(), under: pending.key });
      } else if (pending.under !== "on") at(pending.line, `"${pending.key}" has no value`);
      pending = null;
    }
    while (stack.length > 1 && stack.at(-1).indent > indent) stack.pop();
    let frame = stack.at(-1);
    if (frame.indent !== indent) return at(i, `indentation ${indent} matches no open block`);
    const item = body === "-" || body.startsWith("- ");
    const kind = item ? "seq" : "map";
    if (frame.kind && frame.kind !== kind) at(i, `a ${item ? "sequence item" : "key"} in a block of ${frame.kind === "seq" ? "sequence items" : "keys"}`);
    frame.kind ??= kind;
    let col = indent;
    if (item) {
      if (body === "-") return at(i, "empty sequence item");
      body = body.slice(2);
      col = indent + 2;
      frame = { indent: col, kind: null, keys: new Set(), under: frame.under };
      stack.push(frame);
    }
    const m = /^([A-Za-z0-9_][\w.-]*):(?: +(.*))?$/.exec(body);
    if (!m) {
      if (!item) return at(i, `expected "key: value": ${body}`);
      frame.kind = "scalar";
      return checkScalar(body, i);
    }
    const [, key, value] = m;
    if (frame.keys.has(key)) at(i, `duplicate key "${key}"`);
    frame.keys.add(key);
    frame.kind = "map";
    if (indent === 0) top.push(key);
    if (value === undefined || value === "" || value.startsWith("#")) pending = { indent: col, key, under: frame.under, line: i };
    else if (/^[|>][-+]?(?:\s+#.*)?$/.test(value)) scalarAt = col;
    else checkScalar(value, i);
  });
  if (pending && pending.under !== "on") at(pending.line, `"${pending.key}" has no value`);
  return { errors, top };
}

/* ───────────────────────────── jobs and steps of a rendered workflow ───────────────────────────── */

const stripComment = (v) => v.replace(/\s+#.*$/, "");

/** `{ id: { props: { key: { value, lines } }, permissions, steps, text } }` for the jobs under `jobs:`. */
function jobsOf(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  assert.ok(start >= 0, "no top-level jobs:");
  const jobs = {};
  let cur = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^ {2}([\w-]+):$/.exec(line);
    if (m) {
      cur = { id: m[1], lines: [] };
      jobs[m[1]] = cur;
    } else if (cur) cur.lines.push(line);
  }
  for (const j of Object.values(jobs)) {
    j.text = j.lines.join("\n");
    j.props = {};
    let key = null;
    for (const line of j.lines) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const m = /^ {4}([\w-]+):(?: (.*))?$/.exec(line);
      if (m) {
        key = m[1];
        j.props[key] = { value: stripComment(m[2] ?? ""), lines: [] };
      } else if (key) j.props[key].lines.push(line);
    }
    j.prop = (k) => j.props[k]?.value;
    j.permissions = Object.fromEntries(
      (j.props.permissions?.lines ?? [])
        .map((l) => /^ {6}([\w-]+): (\S+)/.exec(l))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
    j.steps = [];
    for (const line of j.props.steps?.lines ?? []) {
      if (/^ {6}- /.test(line)) j.steps.push({ lines: [] });
      j.steps.at(-1)?.lines.push(line);
    }
    for (const st of j.steps) st.text = st.lines.join("\n");
  }
  return jobs;
}

/** A step's key at the step level (`- key: v` or `  key: v` under the item). */
function stepKey(st, k) {
  for (const l of st.lines) {
    const m = new RegExp(`^ {6}(?:- | {2})${k}:(?: (.*))?$`).exec(l);
    if (m) return stripComment(m[1] ?? "");
  }
  return undefined;
}

/** A step's nested map (`with:` / `env:`) as `{ key: value }`. */
function stepBlock(st, k) {
  const out = {};
  let inside = false;
  for (const l of st.lines) {
    if (new RegExp(`^ {6}(?:- | {2})${k}:\\s*$`).test(l)) {
      inside = true;
      continue;
    }
    if (!inside || /^\s*#/.test(l) || !l.trim()) continue;
    const m = /^ {10}([\w-]+): ?(.*)$/.exec(l);
    if (m) out[m[1]] = stripComment(m[2]);
    else if (l.length - l.trimStart().length <= 8) break;
  }
  return out;
}

const checkouts = (job) => job.steps.filter((st) => stepKey(st, "uses") === "actions/checkout@v4");
const runsAi = (job, ctx) => job.text.includes(ctx.aiCli.install);

/* ───────────────────────────── the checker itself ───────────────────────────── */

describe("the structural YAML checker", () => {
  const errs = (src) => yamlShape(src).errors;
  it("accepts the shapes the workflows use", () => {
    const ok = [
      "name: x",
      "on:",
      "  pull_request:",
      "  workflow_dispatch:",
      "    inputs:",
      "      pr:",
      '        description: "a: b"',
      "permissions: {}",
      "jobs:",
      "  a:",
      "    if: >-",
      "      x == 'y' &&",
      "      z",
      "    runs-on: [self-hosted, macOS]",
      "    steps:",
      "      - uses: actions/checkout@v4 # pinned major",
      "        with:",
      "          ref: ${{ github.sha }}",
      "      - run: |",
      "          echo a: b",
      "",
    ].join("\n");
    assert.deepEqual(errs(ok), []);
    assert.deepEqual(yamlShape(ok).top, ["name", "on", "permissions", "jobs"]);
  });

  it("rejects what YAML or GitHub would misread", () => {
    const bad = (src, re) => assert.ok(errs(src).some((e) => re.test(e)), `${JSON.stringify(src)} → ${JSON.stringify(errs(src))}`);
    bad("a:\n\tb: 1\n", /tab/);
    bad("a: 1 \n", /trailing whitespace/);
    bad("a:\n   b: 1\n", /odd indentation|must be followed/);
    bad("a:\n    b: 1\n", /must be followed by indentation 2/);
    bad("jobs:\n  x:\n    steps:\n    - run: a\n", /has no value|sequence item in a block of keys/);
    bad("a: 1\na: 2\n", /duplicate key "a"/);
    bad("a:\n  - x\n  b: 1\n", /key in a block of sequence items/);
    bad("a: b: c\n", /contains ": "/);
    bad("a: !c\n", /indicator/);
    bad("a: ${{ x\n", /unbalanced/);
    bad('a: "x\n', /double-quoted/);
    bad("jobs:\n  x:\n", /"x" has no value/);
  });
});

/* ───────────────────────────── every variant, every workflow ───────────────────────────── */

describe("workflow templates render cleanly for every variant", () => {
  const people = [...raw.people.trustedAuthors, ...raw.people.codeOwners, ...raw.people.onCall];
  each(({ name, ctx, files }) => {
    it(`${name}: no template leftovers, sound structure, stable names, workflow-level permissions: {}`, () => {
      for (const w of WORKFLOWS) {
        const text = files[w];
        const where = `${name} / ${w}.yml`;
        text.split("\n").forEach((line, i) => {
          assert.doesNotMatch(line, /(?<!\$)\{\{/, `${where}:${i + 1}: template leftover: ${line}`);
          assert.equal((line.match(/\$\{\{/g) ?? []).length, (line.match(/\}\}/g) ?? []).length, `${where}:${i + 1}: unbalanced \${{ }}: ${line}`);
        });
        assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), `${where}: must end with exactly one newline`);
        assert.ok(!text.includes("\n\n\n"), `${where}: double blank line`);
        const { errors, top } = yamlShape(text);
        assert.deepEqual(errors, [], `${where}:\n${errors.join("\n")}`);
        for (const k of ["name", "on", "permissions", "jobs"]) assert.ok(top.includes(k), `${where}: no top-level ${k}`);
        assert.match(text, new RegExp(`^name: ${w}$`, "m"), `${where}: the workflow name must be the file stem`);
        assert.match(text, /^permissions: \{\}$/m, `${where}: workflow-level permissions must be {}`);
        // No mentions (people are notified) and no logins of the project's people in generated workflows.
        assert.doesNotMatch(text, /(^|[\s"'(])@[A-Za-z0-9][\w-]*(?![\w/-])/m, `${where}: @mention`);
        for (const p of people) assert.doesNotMatch(text, new RegExp(`\\b${p}\\b`), `${where}: login ${p}`);
      }
    });

    it(`${name}: every job has runs-on, a timeout and its own permissions; checkouts drop credentials; node is pinned`, () => {
      for (const w of WORKFLOWS) {
        for (const job of Object.values(jobsOf(files[w]))) {
          const where = `${name} / ${w} / ${job.id}`;
          assert.ok(job.prop("runs-on"), `${where}: runs-on`);
          assert.match(job.prop("timeout-minutes") ?? "", /^[1-9]\d*$/, `${where}: timeout-minutes`);
          // The relay is the only job without permissions of its own (it inherits the workflow's {}).
          if (w === "risk-gate-events") assert.equal(job.props.permissions, undefined, `${where}: the relay must get no permissions`);
          else assert.ok(Object.keys(job.permissions).length > 0, `${where}: per-job permissions`);
          for (const st of checkouts(job)) {
            // review-eval's run job keeps the credentials for one step to fetch the PR heads, then deletes them.
            if (w === "review-eval" && job.id === "run") continue;
            assert.equal(stepBlock(st, "with")["persist-credentials"], "false", `${where}: checkout must not persist credentials`);
          }
          for (const st of job.steps.filter((s) => stepKey(s, "uses") === "actions/setup-node@v4")) {
            assert.match(stepBlock(st, "with")["node-version"] ?? "", /^\d+$/, `${where}: setup-node without node-version`);
          }
        }
      }
    });

    it(`${name}: the engine scripts the workflows run exist`, () => {
      for (const w of WORKFLOWS) {
        for (const [, rel] of files[w].matchAll(/\.dev-process\/engine\/((?:cli|core)\/[\w-]+\.mjs)/g)) {
          assert.ok(existsSync(new URL(`../engine/${rel}`, import.meta.url)), `${w}: ${rel} is not in the engine`);
        }
      }
    });

    it(`${name}: job names never take a required check's or a status's name unless they are that check`, () => {
      const contexts = new Set([...requiredContexts(ctx.policy), ctx.policy.names.classifierContext]);
      const own = new Set(ctx.policy.checks.required.concat(ctx.policy.checks.skippable));
      for (const w of WORKFLOWS) {
        for (const job of Object.values(jobsOf(files[w]))) {
          const n = job.prop("name");
          if (!contexts.has(n)) continue;
          assert.ok(w === "ci" && own.has(n) && job.id === n, `${w} / ${job.id}: job name "${n}" is a check context`);
        }
      }
    });
  });
});

/* ───────────────────────────── ci.yml ───────────────────────────── */

describe("ci.yml", () => {
  each(({ name, ctx, files }) => {
    const text = files.ci;
    const jobs = jobsOf(text);
    it(`${name}: dispatch inputs pr and base (the merge queue's), per-PR concurrency`, () => {
      assert.match(text, /^on:\n {2}pull_request:\n {2}workflow_dispatch:\n {4}inputs:\n {6}pr:\n(?: {8}.*\n)+ {6}base:\n/m);
      assert.match(text, /^ {2}group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}$/m);
      assert.match(text, /^ {2}cancel-in-progress: true$/m);
    });

    it(`${name}: required-check jobs carry exactly the policy's names, untranslated`, () => {
      for (const c of ctx.policy.checks.required) {
        assert.ok(jobs[c], `job ${c} missing`);
        assert.equal(jobs[c].prop("name"), c);
      }
      assert.equal(Boolean(jobs.checks), ctx.ci.hasChecks);
      assert.equal(Boolean(jobs.tests), ctx.ci.hasTests);
      const names = Object.values(jobs).map((j) => j.prop("name"));
      for (const c of [...ctx.policy.checks.required, ...ctx.policy.checks.skippable]) assert.ok(names.includes(c), `no job named ${c}`);
    });

    it(`${name}: the release gate is skippable only through detect-release`, () => {
      const rg = ctx.ci.releaseGate;
      if (!rg) {
        assert.equal(jobs["detect-release"], undefined);
        assert.deepEqual(ctx.policy.checks.skippable, []);
        return;
      }
      const detect = jobs["detect-release"];
      assert.ok(detect);
      assert.equal(stepBlock(checkouts(detect)[0], "with")["fetch-depth"], "0");
      const env = stepBlock(detect.steps.find((s) => stepKey(s, "id") === "detect"), "env");
      assert.equal(env.PR_LABELS, "${{ toJSON(github.event.pull_request.labels.*.name) }}");
      for (const k of ["EVENT", "PR_BASE_SHA", "QUEUE_PR", "BASE_INPUT", "DEFAULT_BRANCH", "GH_TOKEN"]) assert.ok(env[k], `detect-release env ${k}`);
      assert.equal(detect.prop("outputs"), "");
      assert.match(detect.text, /release: \$\{\{ steps\.detect\.outputs\.release \}\}/);
      const gate = jobs[rg.name];
      assert.equal(gate.prop("name"), rg.name);
      assert.equal(gate.prop("needs"), ctx.ci.hasTests ? "[detect-release, tests]" : "[detect-release]");
      // Fail closed: a failed release detection runs the gate (and its first step fails) instead of skipping it into a pass.
      const tests = ctx.ci.hasTests ? "needs.tests.result == 'success' && " : "";
      assert.equal(gate.prop("if"), `\${{ !cancelled() && ${tests}(needs.detect-release.result != 'success' || needs.detect-release.outputs.release == 'true') }}`);
      const failClosed = gate.steps.find((st) => stepKey(st, "if") === "needs.detect-release.result != 'success'");
      assert.ok(failClosed, "no fail-closed step");
      assert.match(failClosed.text, /exit 1/);
      // before any real work: right after the fork guard (if any) and before the checkout
      assert.ok(gate.steps.indexOf(failClosed) < gate.steps.findIndex((st) => st.text.includes("actions/checkout")));
      assert.equal(gate.prop("timeout-minutes"), String(rg.timeoutMin));
    });

    it(`${name}: self-hosted runners never run fork PRs; forks are judged red, not skipped`, () => {
      const guarded = [
        ...(ctx.ci.hasTests ? [[jobs.tests, ctx.ci.selfHosted, ctx.ci.testsRunsOn]] : []),
        ...(ctx.ci.releaseGate ? [[jobs[ctx.ci.releaseGate.name], ctx.ci.releaseGate.selfHosted, ctx.ci.releaseGate.runsOn]] : []),
      ];
      for (const [job, selfHosted, labels] of guarded) {
        if (!selfHosted) {
          assert.equal(job.prop("runs-on"), "ubuntu-latest", job.id);
          assert.doesNotMatch(job.text, /self-hosted/, job.id);
          continue;
        }
        const fork = "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository";
        assert.equal(job.prop("runs-on"), `\${{ fromJSON((${fork}) && '["ubuntu-latest"]' || '${labels}') }}`, job.id);
        const first = job.steps[0];
        assert.equal(stepKey(first, "if"), fork, job.id);
        assert.match(first.text, /echo "::error::[^"]+"\n\s+exit 1/, job.id);
        assert.equal(job.prop("if")?.includes("head.repo") ?? false, false, `${job.id}: a fork must not be skipped`);
      }
    });
  });
});

/* ───────────────────────────── risk-gate.yml / risk-gate-events.yml ───────────────────────────── */

describe("risk-gate.yml", () => {
  each(({ name, ctx, files }) => {
    const text = files["risk-gate"];
    const jobs = jobsOf(text);
    const gate = jobs.gate;
    const judge = gate.steps.find((s) => stepKey(s, "id") === "judge");

    it(`${name}: triggers, and one concurrency group per PR on the whole workflow`, () => {
      assert.match(text, /^ {2}pull_request_target:\n {4}types: \[opened, synchronize, reopened, ready_for_review, edited\]$/m);
      assert.match(text, /^ {2}workflow_run:\n {4}workflows: \[risk-gate-events\]$/m);
      assert.match(text, /^concurrency:\n {2}group: risk-gate-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.issue\.number \|\| github\.event\.workflow_run\.pull_requests\[0\]\.number \|\| inputs\.pr \|\| github\.event\.workflow_run\.head_sha \}\}\n {2}cancel-in-progress: false$/m);
      for (const job of Object.values(jobs)) assert.equal(job.props.concurrency, undefined, `${job.id}: the group must stay workflow-level`);
    });

    it(`${name}: the judge step and BASE_CHANGED_AT`, () => {
      assert.ok(judge, "a step with id: judge");
      const env = stepBlock(judge, "env");
      assert.equal(env.BASE_CHANGED_AT, "${{ github.event.changes.base != null && github.event.pull_request.updated_at || '' }}");
      assert.match(judge.text, /risk-gate\.mjs --repo "\$GITHUB_REPOSITORY" --pr "\$PR"/);
      assert.match(judge.text, /risk-gate\.mjs --repo "\$GITHUB_REPOSITORY" --head-sha "\$HEAD_SHA"/);
      assert.deepEqual(gate.permissions, { contents: "read", "pull-requests": "write", issues: "write", statuses: "write", ...(ctx.queue.self ? { actions: "write" } : {}) });
    });

    it(`${name}: the gate wakes the self-built queue after a passing re-judge, and only then`, () => {
      const wake = gate.steps.find((s) => /gh workflow run/.test(s.text));
      if (!ctx.queue.self) {
        assert.equal(wake, undefined);
        assert.equal(gate.permissions.actions, undefined);
        return;
      }
      assert.equal(gate.permissions.actions, "write");
      assert.equal(stepKey(wake, "if"), "github.event_name == 'workflow_dispatch' && steps.judge.outputs.ok == 'true'");
      assert.equal(stepKey(wake, "run"), `gh workflow run ${ctx.policy.names.queueWorkflow} --repo "$GITHUB_REPOSITORY" --ref "$DEFAULT_BRANCH"`);
      assert.match(wake.text, /gh workflow run merge-queue\.yml /);
      assert.ok(gate.steps.indexOf(wake) > gate.steps.indexOf(judge), "wake-up after the judgment");
    });

    it(`${name}: the classifier exists only when enabled and can only feed the gate through the environment`, () => {
      const env = stepBlock(judge, "env");
      if (!ctx.classifier) {
        assert.equal(jobs.classify, undefined);
        assert.equal(gate.prop("needs"), undefined);
        assert.ok(!Object.keys(env).some((k) => k.startsWith("CLASSIFIER_")));
        assert.doesNotMatch(gate.prop("if"), /always\(\)/);
        return;
      }
      const c = jobs.classify;
      assert.equal(c.prop("if"), "github.event_name == 'pull_request_target' && vars.RISK_CLASSIFIER != 'off'");
      assert.equal(gate.prop("needs"), "classify");
      assert.match(gate.props.if.lines.join("\n"), /always\(\) &&/);
      for (const k of ["TIER", "REASON", "SHA"]) assert.equal(env[`CLASSIFIER_${k}`], `\${{ needs.classify.outputs.${k.toLowerCase()} }}`);
      assert.equal(stepBlock(checkouts(c)[0], "with").ref, "${{ github.event.pull_request.base.sha }}");
      const ai = c.steps.find((s) => stepKey(s, "id") === "classify");
      assert.equal(stepKey(ai, "continue-on-error"), "true");
      const aiEnv = stepBlock(ai, "env");
      assert.equal(aiEnv.PROMPT_FILE, "${{ runner.temp }}/prompt.txt");
      assert.equal(aiEnv.OUT_FILE, "${{ runner.temp }}/out.txt");
      assert.equal(aiEnv.HEAD_SHA, "${{ github.event.pull_request.head.sha }}");
      assert.ok(ai.text.includes(ctx.aiCli.install) && ai.text.includes(ctx.aiCli.noTools), "installs and runs the AI CLI without tools");
      assert.match(ai.text, /classify\.mjs parse --sha "\$HEAD_SHA" < "\$OUT_FILE"/);
      assert.match(c.text, /classify\.mjs prompt --repo "\$GITHUB_REPOSITORY" --pr "\$PR" > "\$RUNNER_TEMP\/prompt\.txt"/);
    });
  });

  it("risk-gate-events.yml is a relay with no permissions, no checkout, no secrets and no expressions", () => {
    each(({ name, files }) => {
      const text = files["risk-gate-events"];
      assert.match(text, /^on:\n {2}pull_request_review:\n {4}types: \[submitted, edited, dismissed\]\n {2}pull_request_review_comment:\n {4}types: \[created, edited, deleted\]$/m, name);
      assert.deepEqual(Object.keys(jobsOf(text)), ["relay"], name);
      assert.doesNotMatch(text, /uses:|secrets\.|\$\{\{/, name);
    });
  });
});

/* ───────────────────────────── pull_request_target ───────────────────────────── */

describe("pull_request_target workflows never check out the PR", () => {
  each(({ name, files }) => {
    it(name, () => {
      const targets = WORKFLOWS.filter((w) => /^ {2}pull_request_target:/m.test(files[w]));
      assert.deepEqual(targets.sort(), ["merge-queue", "risk-gate"]);
      for (const w of targets) {
        assert.doesNotMatch(files[w], /github\.event\.pull_request\.head\.(ref|repo)/, w);
        for (const job of Object.values(jobsOf(files[w]))) {
          for (const st of checkouts(job)) {
            const withs = stepBlock(st, "with");
            assert.ok(withs.ref, `${w} / ${job.id}: checkout needs an explicit base / default-branch ref`);
            assert.doesNotMatch(withs.ref, /head/, `${w} / ${job.id}`);
            assert.equal(withs.repository, undefined, `${w} / ${job.id}`);
          }
        }
      }
    });
  });
});

/* ───────────────────────────── merge-queue.yml ───────────────────────────── */

describe("merge-queue.yml (rendered only in self mode)", () => {
  each(({ name, ctx, files }) => {
    if (!ctx.queue.self) return;
    it(name, () => {
      const text = files["merge-queue"];
      const q = jobsOf(text).queue;
      assert.match(text, /^ {2}pull_request_target:\n {4}types: \[labeled\]$/m);
      const wf = /^ {4}workflows: \[(.*)\]$/m.exec(text)[1].split(", ");
      assert.deepEqual(wf, ["ci", "risk-gate"]);
      for (const w of wf) assert.ok(WORKFLOWS.includes(w));
      assert.match(text, /^ {4}- cron: "17 \* \* \* \*"/m);
      assert.match(text, /^ {2}workflow_dispatch:$/m);
      assert.match(text, /^concurrency:\n {2}group: merge-queue\n {2}cancel-in-progress: false$/m);
      assert.match(q.props.if.lines.join("\n"), new RegExp(`github\\.event\\.label\\.name == '${ctx.policy.names.queueLabel}'`));
      assert.equal(q.prop("timeout-minutes"), String(ctx.queue.jobTimeoutMin));
      assert.deepEqual(q.permissions, { contents: "write", "pull-requests": "write", issues: "write", statuses: "write", actions: "write", checks: "read" });
      assert.equal(stepBlock(checkouts(q)[0], "with").ref, "${{ github.event.repository.default_branch }}");
      assert.match(q.text, /node \.dev-process\/engine\/cli\/merge-queue\.mjs --repo "\$GITHUB_REPOSITORY"/);
    });
  });
});

/* ───────────────────────────── the AI jobs ───────────────────────────── */

describe("the jobs that run the AI CLI", () => {
  each(({ name, ctx, files }) => {
    it(`${name}: only the expected jobs run the AI, with the reviewer family's credentials and nothing more`, () => {
      const ai = [];
      for (const w of WORKFLOWS) {
        for (const job of Object.values(jobsOf(files[w]))) {
          const where = `${w} / ${job.id}`;
          if (!runsAi(job, ctx)) {
            assert.doesNotMatch(job.text, /secrets\.|copilot-requests/, `${where}: no AI, no AI credentials`);
            continue;
          }
          ai.push(where);
          if (ctx.isCopilot) assert.equal(job.permissions["copilot-requests"], "write", where);
          else assert.match(job.text, /\$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/, where);
          for (const p of ["issues", "pull-requests", "statuses", "actions"]) {
            if (where === "risk-gate / classify" && p === "pull-requests") assert.equal(job.permissions[p], "read", where);
            else assert.equal(job.permissions[p], undefined, `${where}: ${p}`);
          }
          assert.equal(job.permissions.contents, "read", where);
        }
      }
      assert.deepEqual(ai, [...(ctx.classifier ? ["risk-gate / classify"] : []), "nightly-review / sweep", "review-eval / run"]);
      if (ctx.isClaude) for (const w of WORKFLOWS) assert.doesNotMatch(files[w], /copilot/i, `${w} mentions Copilot in a Claude setup`);
    });
  });
});

/* ───────────────────────────── nightly-review.yml ───────────────────────────── */

describe("nightly-review.yml", () => {
  each(({ name, ctx, files }) => {
    it(name, () => {
      const text = files["nightly-review"];
      const { sweep, file } = jobsOf(text);
      assert.match(text, /^ {4}- cron: "[^"]+"/m);
      assert.match(text, /^concurrency:\n {2}group: nightly-review\n {2}cancel-in-progress: false$/m);
      assert.match(sweep.text, /area: \$\{\{ steps\.prompt\.outputs\.area \}\}/);
      assert.doesNotMatch(text, /\bsed\b/);
      const prompt = sweep.steps.find((s) => stepKey(s, "id") === "prompt");
      assert.ok(prompt.text.includes(`nightly-sweep.mjs prompt --cli ${ctx.aiCli.id} "$@"`));
      const lock = sweep.steps.findIndex((s) => stepKey(s, "run") === 'chmod -R a-w "$GITHUB_WORKSPACE"');
      const run = sweep.steps.findIndex((s) => s.text.includes(ctx.aiCli.readOnly));
      assert.ok(lock > sweep.steps.indexOf(prompt) && run > lock, "the workspace is read-only before the AI runs");
      const env = stepBlock(sweep.steps[run], "env");
      assert.ok(env.PROMPT_FILE && env.OUT_FILE);
      assert.match(sweep.text, /actions\/upload-artifact@v4/);
      assert.deepEqual(file.permissions, { contents: "read", issues: "write" });
      assert.equal(file.prop("needs"), "sweep");
      assert.match(file.text, /nightly-sweep\.mjs parse --area "\$AREA"/);
      assert.match(file.text, /nightly-sweep\.mjs file-issues --repo "\$GITHUB_REPOSITORY" --area "\$AREA"/);
      assert.equal(stepBlock(file.steps.find((s) => /file-issues/.test(s.text)), "env").AREA, "${{ needs.sweep.outputs.area }}");
    });
  });
});

/* ───────────────────────────── review-eval.yml ───────────────────────────── */

describe("review-eval.yml", () => {
  each(({ name, ctx, files }) => {
    it(name, () => {
      const text = files["review-eval"];
      const { run, report } = jobsOf(text);
      for (const p of [ctx.instructionsPath, ctx.securityPath, ctx.policy.paths.evalCases, ".dev-process/engine/cli/review-eval.mjs", ".dev-process/engine/core/findings.mjs", ".dev-process/engine/core/eval.mjs"]) {
        assert.ok(text.includes(`      - "${p}"\n`), `push paths: ${p}`);
      }
      assert.match(text, new RegExp(`^ {4}branches: \\["${ctx.defaultBranch}"\\]$`, "m"));
      // The credentials kept by the checkout are deleted before any AI runs, and that is verified.
      const fetch = run.steps.findIndex((s) => /git fetch --quiet origin/.test(s.text));
      assert.match(run.steps[fetch].text, /--unset-all "http\.\$GITHUB_SERVER_URL\/\.extraheader"/);
      assert.match(run.steps[fetch].text, /extraheader\$' > \/dev\/null; then\n\s+echo "::error::[^"]+"\n\s+exit 1/);
      const evalStep = run.steps.find((s) => s.text.includes(ctx.aiCli.readOnly));
      assert.ok(run.steps.indexOf(evalStep) > fetch);
      const t = evalStep.text;
      assert.ok(t.includes(`review-eval.mjs prompt "$id" --cli ${ctx.aiCli.id}`));
      assert.ok(t.includes('review-eval.mjs head "$id"'));
      assert.doesNotMatch(t, /cases\.json"\)\.find|require\(/, "the head comes from the CLI, not from reading the cases in the workflow");
      // The answers leave the workspace before the AI runs; the AI runs in a read-only worktree with the env contract.
      const rm = t.indexOf("rm -rf .dev-process/review-evals");
      assert.ok(rm > 0 && rm < t.indexOf(ctx.aiCli.readOnly));
      const lock = t.indexOf('chmod -R a-w "$wt"');
      assert.ok(lock > 0 && lock < t.indexOf(ctx.aiCli.readOnly), "each worktree is read-only before the AI runs in it");
      assert.ok(t.includes(`export PROMPT_FILE="$RUNNER_TEMP/prompts/$n.txt" OUT_FILE="$RUNNER_TEMP/raw/$n.tmp"`));
      assert.ok(t.includes(`if (cd "$wt" && ${ctx.aiCli.readOnly}); then`));
      // Index-named files while the AI runs; ids only at the end.
      assert.ok(t.includes('mv "$RUNNER_TEMP/raw/$n.txt" "$RUNNER_TEMP/out/${ids[$((n-1))]}.txt"'));
      assert.equal(report.prop("needs"), "run");
      assert.equal(report.prop("if"), "always()");
      assert.deepEqual(report.permissions, { contents: "read", issues: "write" });
      assert.match(report.text, /review-eval\.mjs score --out-dir "\$RUNNER_TEMP\/out" --report-issue --repo "\$GITHUB_REPOSITORY"/);
    });
  });
});

/* ───────────────────────────── review-metrics.yml ───────────────────────────── */

describe("review-metrics.yml", () => {
  it("weekly, read-only except its report issue", () => {
    each(({ files }) => {
      const { report } = jobsOf(files["review-metrics"]);
      assert.match(files["review-metrics"], /^ {4}- cron: "[^"]+"/m);
      assert.deepEqual(report.permissions, { contents: "read", "pull-requests": "read", issues: "write" });
      assert.match(report.text, /metrics\.mjs --repo "\$GITHUB_REPOSITORY" --days 7/);
    });
  });
});

/* ───────────────────────────── strings ───────────────────────────── */

describe("workflow strings", () => {
  it("are safe as plain YAML values and inside a double-quoted echo", () => {
    for (const [lang, strings] of Object.entries(WORKFLOW_STRINGS)) {
      for (const [k, v] of Object.entries(strings)) {
        const where = `${lang}.${k} = ${JSON.stringify(v)}`;
        assert.doesNotMatch(v, /: |\s#|["$`\\\n]|:$/, where);
        assert.doesNotMatch(v, /^[-?:,[\]{}#&*!|>'%@]/, where);
        assert.equal(v, v.trim(), where);
      }
    }
  });

  it("every s.<key> a template uses exists", () => {
    const keys = new Set(Object.keys(WORKFLOW_STRINGS.en));
    for (const w of WORKFLOWS) for (const [, k] of templateOf(w).matchAll(/\{\{ s\.(\w+) \}\}/g)) assert.ok(keys.has(k), `${w}: s.${k}`);
  });
});
