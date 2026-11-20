/**
 * From validated answers to (1) the policy written to `.dev-process/config.json` and (2) the context every template
 * renders with. Templates only read the context; anything computed (YAML step blocks, runner expressions, CODEOWNERS
 * lines, AI CLI commands) is computed here, once, so templates stay declarative and the output is deterministic.
 *
 * Template context (documented contract — templates must not read anything else):
 *   lang, zh, en                    language
 *   forge, forgeName ("GitHub" | "GitLab"), pr ("PR" | "MR"), ciFile (where the CI jobs are defined)
 *   reviewer, ai, isCopilot, isClaude
 *   project.name, project.description
 *   repo, defaultBranch
 *   policy                          the full policy (names, commands, requiredHumans, thresholds, tags, paths…)
 *   configPath, engine              ".dev-process/config.json", ".dev-process/engine"
 *   ciCopy                          where the Claude review job checks out the process files beside the PR head
 *   instructionsPath, securityPath  where the AI review instructions live for this reviewer
 *   people.trustedAuthors / codeOwners / onCall, codeownersLines (["/src/update/ @a @b", …])
 *   failureModes, securityChecklist (project lines, may be empty), skipPaths (lowOnly paths, for "don't review")
 *   ci.node, ci.setupYaml, ci.checksYaml, ci.testsYaml   step blocks, already indented for `steps:` (6 spaces)
 *   ci.hasChecks, ci.hasTests, ci.selfHosted, ci.testsRunsOn (YAML value), ci.requiredChecks (list)
 *   ci.releaseGate (null | { name, timeoutMin, runsOn, selfHosted, stepsYaml })
 *   queue.mode, queue.self, queue.native, queue.jobTimeoutMin
 *   classifier, loops.sweep / eval / metrics (sweep is off when there are no security paths)
 *   aiCli.id, aiCli.name, aiCli.install, aiCli.permission (null | "copilot-requests: write"),
 *     aiCli.envYaml (the env block for the step that runs the AI, indented 10), aiCli.noTools / readOnly
 *     (shell command lines with "$PROMPT_FILE" and "$OUT_FILE" placeholders, read from those env vars)
 *   release.label, release.versionFiles, stagedRollout
 *   s                               short UI strings for workflow job/step names, in the project language
 *   GitLab only: gitlab.url / tier / premium / ultimate, ci.image, ci.tagsYaml (runner tags block or ""),
 *     ci.setupScript / checksScript / testsScript, ci.releaseGate.script ( `script:` list items, indented 4)
 */
import { globToCodeowners, processPaths } from "../engine/core/consistency.mjs";
import { withDefaults } from "../engine/core/policy.mjs";
import { reviewerFor } from "../engine/reviewer/index.mjs";
import { WORKFLOW_STRINGS } from "../templates/github/strings.mjs";

export const CONFIG_PATH = ".dev-process/config.json";
export const ENGINE_DIR = ".dev-process/engine";
export const CI_COPY_DIR = ".dev-process-ci";
export const NODE_VERSION = "24";

/** Reviewer-specific instruction locations: Copilot only reads its own files; Claude reads ours. */
export function instructionPaths(reviewer) {
  return reviewer === "copilot"
    ? { instructions: ".github/copilot-instructions.md", security: ".github/instructions/security.instructions.md" }
    : { instructions: ".dev-process/ai-review/instructions.md", security: ".dev-process/ai-review/security.md" };
}

/** YAML scalar: plain when safe, otherwise double-quoted JSON (valid YAML). */
export function yamlScalar(v) {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  return /^[A-Za-z0-9_./@-][A-Za-z0-9 _./@:,-]*$/.test(s) && !/:\s|\s#|:$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) ? s : JSON.stringify(s);
}

/** Steps as a YAML block for `steps:` (each `- ` at `indent` spaces). `run` uses a literal block when multi-line. */
export function stepsYaml(list, indent = 6) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const st of list) {
    const first = [];
    if (st.name) first.push(["name", yamlScalar(st.name)]);
    if (st.uses) first.push(["uses", yamlScalar(st.uses)]);
    first.forEach(([k, v], i) => lines.push(`${pad}${i === 0 ? "- " : "  "}${k}: ${v}`));
    const lead = first.length ? `${pad}  ` : `${pad}- `;
    if (st.with) {
      lines.push(`${lead}with:`);
      for (const [k, v] of Object.entries(st.with)) lines.push(`${pad}    ${k}: ${yamlScalar(v)}`);
    }
    if (st.run !== undefined) {
      if (String(st.run).includes("\n")) {
        lines.push(`${lead}run: |`);
        for (const l of String(st.run).replace(/\n$/, "").split("\n")) lines.push(`${pad}    ${l}`);
      } else lines.push(`${lead}run: ${yamlScalar(st.run)}`);
    }
  }
  return lines.join("\n");
}

const runsOn = (runner, labels) => (runner === "self-hosted" ? JSON.stringify(labels) : "ubuntu-latest");

/** GitLab `script:` items for steps (`run` only): `- cmd`, multi-line commands as literal blocks, names as comments. */
export function scriptYaml(list, indent = 4) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const st of list) {
    if (st.name) lines.push(`${pad}# ${String(st.name).replace(/\n/g, " ")}`);
    const run = String(st.run ?? "");
    if (run.includes("\n")) {
      lines.push(`${pad}- |`);
      for (const l of run.replace(/\n$/, "").split("\n")) lines.push(`${pad}  ${l}`);
    } else lines.push(`${pad}- ${yamlScalar(run)}`);
  }
  return lines.join("\n");
}

/** GitLab runner tags for a job (`tags:` block at indent 2), or "" for shared runners. */
const tagsYaml = (runner, labels) => (runner === "self-hosted" && labels.length ? `  tags:\n${labels.map((l) => `    - ${yamlScalar(l)}`).join("\n")}` : "");

/** GitLab: the process's tasks (DEV_PROCESS_TASK values) in place of GitHub workflow file names. */
export const GITLAB_TASKS = Object.freeze({ ciWorkflow: "ci", gateWorkflow: "risk-gate", queueWorkflow: "merge-queue", aiReviewWorkflow: "ai-review" });

/** The AI CLI used for the classifier, the nightly sweep and the review eval (the reviewer's family). */
export function aiCliFor(reviewer) {
  if (reviewer === "copilot") {
    const allow = ["ls", "cat", "grep", "head", "wc"].map((c) => `--allow-tool='shell(${c}:*)'`).join(" ");
    return {
      id: "copilot",
      name: "Copilot CLI",
      install: "npm install -g @github/copilot",
      permission: "copilot-requests: write",
      envYaml: "          GITHUB_TOKEN: ${{ github.token }}",
      // Copilot CLI takes the prompt as an argument; prompts are capped below Linux's 128 KB argument limit.
      noTools: 'copilot -p "$(cat "$PROMPT_FILE")" -s > "$OUT_FILE"',
      readOnly: `copilot -p "$(cat "$PROMPT_FILE")" -s ${allow} > "$OUT_FILE"`,
    };
  }
  const base = "claude --bare -p --permission-mode dontAsk --output-format json --max-turns";
  return {
    id: "claude",
    name: "Claude Code",
    install: "npm install -g @anthropic-ai/claude-code",
    permission: null,
    envYaml: "          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
    // The prompt goes in on stdin (no argument-size limit, no shell interpolation of PR text).
    noTools: `${base} 3 --tools "" < "$PROMPT_FILE" > "$OUT_FILE"`,
    readOnly: `${base} 40 --tools "Read,Grep,Glob" < "$PROMPT_FILE" > "$OUT_FILE"`,
  };
}

/** Policy for `.dev-process/config.json` from validated answers. */
export function policyFrom(a) {
  const high = [...new Set([...processPaths({ forge: a.forge }), ...a.paths.high])];
  const required = [...(a.ci.checks.length ? ["checks"] : []), ...(a.ci.tests.length ? ["tests"] : [])];
  return withDefaults({
    forge: a.forge,
    language: a.language,
    reviewer: a.reviewer,
    trustedAuthors: a.people.trustedAuthors,
    highPaths: high,
    securityPaths: a.paths.security,
    lowOnlyPaths: a.paths.lowOnly,
    ...(a.paths.sizeExcluded ? { sizeExcludedPaths: a.paths.sizeExcluded } : {}),
    checks: { required, skippable: a.ci.releaseGate ? [a.ci.releaseGate.name] : [] },
    queue: { mode: a.queue.mode, ciTimeoutMin: a.ci.releaseGate ? 180 : 120 },
    paths: { ...instructionPaths(a.reviewer) },
    classifier: { enabled: a.classifier },
    release: a.release,
    ...(a.forge === "gitlab"
      ? {
          names: { ...GITLAB_TASKS },
          // The schedules the setup creates (the CI jobs for sweep / metrics exist only when these are on).
          gitlab: { url: a.gitlab.url, tier: a.gitlab.tier, schedules: ["poll", ...(a.loops.sweep && a.paths.security.length ? ["sweep"] : []), ...(a.loops.metrics ? ["metrics"] : [])] },
        }
      : {}),
  });
}

/** Template context (see the contract in the file header). */
export function buildContext(a) {
  const policy = policyFrom(a);
  const reviewer = reviewerFor(a.reviewer);
  const owners = a.people.codeOwners.map((o) => `@${o}`).join(" ");
  const ci = a.ci;
  const rg = ci.releaseGate;
  const paths = instructionPaths(a.reviewer);
  return {
    lang: a.language,
    zh: a.language === "zh",
    en: a.language === "en",
    forge: a.forge,
    forgeName: a.forge === "gitlab" ? "GitLab" : "GitHub",
    pr: a.forge === "gitlab" ? "MR" : "PR",
    /** Where the CI jobs are defined. */
    ciFile: a.forge === "gitlab" ? ".gitlab-ci.yml" : `.github/workflows/${policyFrom(a).names.ciWorkflow}`,
    reviewer: a.reviewer,
    ai: reviewer.displayName,
    isCopilot: a.reviewer === "copilot",
    isClaude: a.reviewer === "claude",
    project: a.project,
    repo: a.repo,
    defaultBranch: a.defaultBranch,
    policy,
    configPath: CONFIG_PATH,
    engine: ENGINE_DIR,
    ciCopy: CI_COPY_DIR,
    instructionsPath: paths.instructions,
    securityPath: paths.security,
    people: a.people,
    codeownersLines: policy.highPaths.map((g) => `${globToCodeowners(g)} ${owners}`),
    failureModes: a.failureModes,
    securityChecklist: a.securityChecklist,
    skipPaths: a.paths.lowOnly,
    ci: {
      node: NODE_VERSION,
      setupYaml: a.forge === "gitlab" ? "" : stepsYaml(ci.setup),
      checksYaml: a.forge === "gitlab" ? "" : stepsYaml(ci.checks),
      testsYaml: a.forge === "gitlab" ? "" : stepsYaml(ci.tests),
      hasSetup: ci.setup.length > 0,
      hasChecks: ci.checks.length > 0,
      hasTests: ci.tests.length > 0,
      selfHosted: ci.testsRunner === "self-hosted",
      testsRunsOn: runsOn(ci.testsRunner, ci.selfHostedLabels),
      selfHostedLabelsJson: JSON.stringify(ci.selfHostedLabels),
      requiredChecks: policy.checks.required,
      releaseGate: rg
        ? {
            name: rg.name,
            timeoutMin: rg.timeoutMin,
            runsOn: runsOn(rg.runner, ci.selfHostedLabels),
            selfHosted: rg.runner === "self-hosted",
            stepsYaml: a.forge === "gitlab" ? "" : stepsYaml(rg.steps),
            ...(a.forge === "gitlab" ? { script: scriptYaml(rg.steps), tagsYaml: tagsYaml(rg.runner, ci.selfHostedLabels) } : {}),
          }
        : null,
      ...(a.forge === "gitlab"
        ? {
            image: ci.image,
            tagsYaml: tagsYaml(ci.testsRunner, ci.selfHostedLabels),
            setupScript: scriptYaml(ci.setup),
            checksScript: scriptYaml(ci.checks),
            testsScript: scriptYaml(ci.tests),
          }
        : {}),
    },
    queue: { mode: a.queue.mode, self: a.queue.mode === "self", native: a.queue.mode === "native", train: a.queue.mode === "train", jobTimeoutMin: policy.queue.ciTimeoutMin + 20 },
    gitlab: a.gitlab ? { url: a.gitlab.url, tier: a.gitlab.tier, premium: a.gitlab.tier !== "free", ultimate: a.gitlab.tier === "ultimate" } : null,
    classifier: a.classifier,
    // GitLab: the review eval is not ported yet (it replays past changes in per-case checkouts).
    loops: { sweep: a.loops.sweep && a.paths.security.length > 0, eval: a.loops.eval && a.forge !== "gitlab", metrics: a.loops.metrics },
    aiCli: aiCliFor(a.reviewer),
    release: a.release,
    stagedRollout: a.stagedRollout,
    s: WORKFLOW_STRINGS[a.language],
  };
}
