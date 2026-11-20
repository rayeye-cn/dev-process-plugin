// The human-facing templates (templates/common/{zh,en}): every one renders in every context without leftovers, in the
// right language, and the files that mirror the policy (CLAUDE.md commands, applyTo, CODEOWNERS) pass the consistency checks.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { checkConsistency, parseApplyTo, parseCodeowners } from "../engine/core/consistency.mjs";
import { validateAnswers } from "../tools/answers.mjs";
import { aiCliFor, buildContext, instructionPaths, policyFrom } from "../tools/context.mjs";
import { renderTemplate } from "../tools/template.mjs";

const DIR = new URL("../templates/common/", import.meta.url);
const FILES = [
  "CLAUDE.section.md.tmpl",
  "CODEOWNERS.tmpl",
  "ai-review-instructions.md.tmpl",
  "ai-review-security.md.tmpl",
  "incident-review-template.md.tmpl",
  "on-call.md.tmpl",
  "pull_request_template.md.tmpl",
  "review-evals-README.md.tmpl",
  "review-setup.md.tmpl",
];
const COPILOT_INSTRUCTIONS_LIMIT = 4000; // Copilot code review reads only the first 4,000 characters

const raw = JSON.parse(readFileSync(new URL("./fixtures/answers.json", import.meta.url), "utf8"));
const MINIMAL = { project: { name: "Tiny" }, repo: "o/tiny", defaultBranch: "trunk", people: { trustedAuthors: ["a1"] }, ci: { tests: [{ run: "make test" }] } };

/**
 * Context for answers. The Claude reviewer adapter may not exist yet (buildContext then throws "unknown reviewer"):
 * derive its context from the Copilot one with the reviewer-specific fields swapped, as buildContext computes them.
 */
function ctxFor(over = {}, base = raw) {
  const a = validateAnswers({ ...base, ...over });
  try {
    return buildContext(a);
  } catch (e) {
    if (a.reviewer !== "claude" || !/unknown reviewer/.test(e.message)) throw e;
    const c = buildContext({ ...a, reviewer: "copilot" });
    const p = instructionPaths("claude");
    return { ...c, reviewer: "claude", ai: "Claude", isCopilot: false, isClaude: true, instructionsPath: p.instructions, securityPath: p.security, policy: policyFrom(a), aiCli: aiCliFor("claude") };
  }
}

const src = (lang, file) => readFileSync(new URL(`${lang}/${file}`, DIR), "utf8");
const render = (ctx, file) => renderTemplate(src(ctx.lang, file), ctx, `${ctx.lang}/${file}`);

const CJK = /[　-〿㐀-鿿＀-￯]/;
/** Text outside fenced code blocks and inline code spans. */
const prose = (text) => text.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");

const VARIANTS = {
  "fixture (copilot, self queue, release gate)": {},
  claude: { reviewer: "claude" },
  "no failure modes, no security checklist": { failureModes: [], securityChecklist: [] },
  "staged rollout": { stagedRollout: true },
  "native queue, self-hosted tests, loops off": {
    queue: { mode: "native" },
    ci: { ...raw.ci, testsRunner: "self-hosted", releaseGate: null },
    loops: { sweep: false, eval: false, metrics: false },
    classifier: false,
  },
};

describe("doc templates: files", () => {
  it("both languages have exactly the same template files", () => {
    const zh = readdirSync(new URL("zh/", DIR)).sort();
    const en = readdirSync(new URL("en/", DIR)).sort();
    assert.deepEqual(zh, en);
    assert.deepEqual(zh, [...FILES].sort());
  });

  it("no project-specific leftovers from the reference implementation", () => {
    for (const lang of ["zh", "en"]) {
      for (const f of FILES) {
        const s = src(lang, f);
        assert.doesNotMatch(s, /pandaluvcc|fengziadmin|xuzhouqqq|hppbmw|rayeye|x-bidding|Electron|PyMuPDF/i, `${lang}/${f}`);
        assert.doesNotMatch(s, /\bmaster\b/, `${lang}/${f}: use {{ defaultBranch }}`);
        assert.doesNotMatch(s, /#1[0-9]{2}\b/, `${lang}/${f}: issue numbers from the reference`);
      }
    }
  });
});

for (const lang of ["zh", "en"]) {
  for (const [name, over] of Object.entries(VARIANTS)) {
    describe(`doc templates: ${lang}, ${name}`, () => {
      const ctx = ctxFor({ ...over, language: lang });
      const out = Object.fromEntries(FILES.map((f) => [f, render(ctx, f)]));

      it("every template renders without leftovers, in the project language", () => {
        for (const [f, text] of Object.entries(out)) {
          assert.doesNotMatch(text, /\{\{|\}\}/, `${f}: template tags left over`);
          assert.ok(text.trim().length > 0, `${f}: empty`);
          if (lang === "zh") assert.match(text, CJK, `${f}: no Chinese text`);
          else assert.doesNotMatch(prose(text), CJK, `${f}: Chinese text in the English output`);
        }
      });

      it("CLAUDE.md section names both commands the way the consistency check expects", () => {
        const md = out["CLAUDE.section.md.tmpl"];
        assert.ok(md.includes(`\`${ctx.policy.commands.signoff} <head sha>\``));
        assert.ok(md.includes(`\`${ctx.policy.commands.waiver} <head sha>\``));
        assert.ok(md.includes(ctx.ai));
      });

      it("CODEOWNERS mirrors highPaths; the security file's applyTo mirrors securityPaths (Copilot only)", () => {
        assert.deepEqual(
          parseCodeowners(out["CODEOWNERS.tmpl"]).map((e) => e.glob),
          ctx.policy.highPaths,
        );
        const sec = out["ai-review-security.md.tmpl"];
        if (ctx.isCopilot) {
          assert.ok(sec.startsWith('---\napplyTo: "'), "front matter first");
          assert.deepEqual(parseApplyTo(sec), ctx.policy.securityPaths);
        } else {
          assert.ok(!sec.startsWith("---"), "no front matter for Claude");
          assert.equal(parseApplyTo(sec), null);
          for (const p of ctx.policy.securityPaths) assert.ok(sec.includes(`\`${p}\``), `Claude's checklist names ${p}`);
        }
      });

      it("the rendered files pass the consistency checks", () => {
        const errors = checkConsistency({
          policy: ctx.policy,
          codeowners: out["CODEOWNERS.tmpl"],
          applyTo: ctx.isCopilot ? out["ai-review-security.md.tmpl"] : null,
          claudeMd: out["CLAUDE.section.md.tmpl"],
        }).filter((f) => f.level === "error");
        assert.deepEqual(errors, []);
      });

      it("PR template starts with Closes #, names the sign-off command, and mentions a staged rollout only when there is one", () => {
        const pr = out["pull_request_template.md.tmpl"];
        assert.ok(pr.startsWith("Closes #\n"));
        assert.ok(pr.includes(`\`${ctx.policy.commands.signoff} <head commit sha>\``));
        const staged = lang === "zh" ? /分批推送/ : /staged rollout/;
        if (ctx.stagedRollout) assert.match(pr, staged);
        else assert.doesNotMatch(pr, staged);
      });

      it("review instructions: language, failure modes or the generic list, risk line, skipped paths", () => {
        const text = out["ai-review-instructions.md.tmpl"];
        if (ctx.isCopilot) assert.ok(text.length <= COPILOT_INSTRUCTIONS_LIMIT, `${text.length} characters`);
        assert.match(text, lang === "zh" ? /用中文写评审意见/ : /Write review comments in English/);
        assert.match(text, lang === "zh" ? /`风险档: low\|medium\|high — <理由>`/ : /`Risk: low\|medium\|high — <reason>`/);
        for (const m of ctx.failureModes) assert.ok(text.includes(m));
        if (!ctx.failureModes.length) assert.match(text, lang === "zh" ? /数据丢失[\s\S]*向后兼容[\s\S]*并发/ : /Data loss[\s\S]*Backwards compatibility[\s\S]*Concurrency/);
        for (const p of ctx.skipPaths) assert.ok(text.includes(`\`${p}\``));
        for (const line of ctx.securityChecklist) assert.ok(out["ai-review-security.md.tmpl"].includes(line));
      });

      it("docs follow the configuration: queue mode, reviewer, loops, people", () => {
        const setup = out["review-setup.md.tmpl"];
        assert.ok(setup.includes(`apply-protection.mjs --repo ${ctx.repo} --dry-run`));
        assert.ok(setup.indexOf("apply-protection.mjs") < setup.indexOf("doctor.mjs --remote"), "doctor comes after branch protection");
        assert.equal(setup.includes("ANTHROPIC_API_KEY"), ctx.isClaude);
        assert.equal(setup.includes("Copilot CLI"), ctx.isCopilot);
        assert.equal(setup.includes(`\`${ctx.policy.names.queueLabel}\``), ctx.queue.self);
        assert.equal(/self-hosted runner|自托管 runner/.test(setup.split(/^## /m)[2]), Boolean(ctx.ci.selfHosted || ctx.ci.releaseGate?.selfHosted), "runner step only when a job is self-hosted");
        assert.equal(setup.includes("nightly-review.yml"), ctx.loops.sweep);
        for (const login of ctx.people.onCall) assert.ok(out["on-call.md.tmpl"].includes(`| \`${login}\` |`));
        assert.ok(out["review-evals-README.md.tmpl"].includes(`\`${ctx.policy.names.evalLabel}\``));
        assert.ok(out["incident-review-template.md.tmpl"].includes(ctx.policy.paths.evalCases));
        assert.ok(out["incident-review-template.md.tmpl"].includes(ctx.instructionsPath));
      });
    });
  }
}

describe("doc templates: edge cases", () => {
  it("minimal answers (no description, no security paths, no release gate) render in both languages", () => {
    for (const lang of ["zh", "en"]) {
      for (const reviewer of ["copilot", "claude"]) {
        const ctx = ctxFor({ language: lang, reviewer }, MINIMAL);
        for (const f of FILES) {
          const text = render(ctx, f);
          assert.doesNotMatch(text, /\{\{|\}\}/, `${lang}/${reviewer}/${f}`);
          assert.ok(!text.includes("`main`"), `${lang}/${reviewer}/${f}: the default branch is "trunk" here`);
        }
        assert.doesNotMatch(render(ctx, "ai-review-instructions.md.tmpl"), /security-review|安全评审路径/);
      }
    }
  });

  it("commands, names and counts come from the policy, not the template", () => {
    for (const lang of ["zh", "en"]) {
      const base = ctxFor({ language: lang });
      const ctx = {
        ...base,
        pr: "MR",
        policy: {
          ...base.policy,
          commands: { signoff: "/i-own-this", waiver: "/skip-ai" },
          names: { ...base.policy.names, gateContext: "people-gate", queueLabel: "ship-it", queueContext: "ship-gate" },
          requiredHumans: { low: 0, medium: 2, high: 3 },
          reviewRoundCap: 5,
        },
      };
      const md = render(ctx, "CLAUDE.section.md.tmpl");
      for (const s of ["`/i-own-this <head sha>`", "`/skip-ai <head sha>`", "`people-gate`", "`ship-it`", "MR"]) assert.ok(md.includes(s), `${lang}: ${s}`);
      assert.doesNotMatch(md, /\/signoff|\/waive-ai-review|risk-gate|merge-queue|\bPRs?\b/);
      assert.match(md, lang === "zh" ? /评审最多 5 轮/ : /At most 5 review rounds/);
      assert.match(md, lang === "zh" ? /medium 2 人，high 3 人/ : /2 for medium, 3 for high/);
      assert.ok(render(ctx, "pull_request_template.md.tmpl").includes("`/i-own-this <head commit sha>`"));
    }
  });
});
