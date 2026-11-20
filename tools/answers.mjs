/**
 * Init answers (`.dev-process/answers.json` in the target repository): what `/dev-process:init` gathered, kept so
 * `/dev-process:upgrade` can re-render with a newer plugin. Validation fills defaults and rejects bad shapes early,
 * with messages that name the field.
 *
 * Shape (version 1):
 * {
 *   version: 1,
 *   forge: "github",                       // gitlab: M5
 *   language: "zh" | "en",
 *   reviewer: "copilot" | "claude",        // copilot: GitHub only
 *   project: { name, description? },
 *   repo: "owner/name", defaultBranch: "main",
 *   people: { trustedAuthors: [], codeOwners: [], onCall: [] },
 *   paths: { high: [], security: [], lowOnly: [], sizeExcluded?: [] },
 *   failureModes: [],                      // project-specific review checklist lines (optional)
 *   securityChecklist: [],                 // project-specific security checklist lines (optional)
 *   ci: {
 *     setup: [step],                       // before checks and tests (toolchain, install)
 *     checks: [step],                      // fast checks on hosted runners → job "checks"
 *     tests: [step],                       // full tests → job "tests"
 *     testsRunner: "hosted" | "self-hosted", selfHostedLabels: ["self-hosted", …],
 *     releaseGate: null | { name, steps: [step], runner: "hosted" | "self-hosted", timeoutMin }
 *   },
 *   queue: { mode: "self" | "native" },
 *   classifier: true, loops: { sweep, eval, metrics },
 *   release: { label, versionFiles: [{ file, field }] },
 *   stagedRollout: false
 * }
 * A step is `{ name?, run }` or `{ name?, uses, with? }`.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\/[A-Za-z0-9._-]+)?$/; // login, or org/team

export class AnswersError extends Error {}

const fail = (field, why) => {
  throw new AnswersError(`answers.${field}: ${why}`);
};
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const strList = (v, field, { min = 0, re = null } = {}) => {
  if (!Array.isArray(v)) fail(field, "must be a list");
  v.forEach((x, i) => {
    if (!isStr(x)) fail(`${field}[${i}]`, "must be a non-empty string");
    if (re && !re.test(x)) fail(`${field}[${i}]`, `"${x}" is not valid`);
  });
  if (v.length < min) fail(field, `needs at least ${min}`);
  return [...new Set(v)];
};
const oneOf = (v, field, values) => {
  if (!values.includes(v)) fail(field, `must be one of ${values.join(", ")}`);
  return v;
};

function step(s, field) {
  if (!s || typeof s !== "object") fail(field, "must be a step object");
  const hasRun = isStr(s.run);
  const hasUses = isStr(s.uses);
  if (hasRun === hasUses) fail(field, "needs exactly one of run / uses");
  if (s.name !== undefined && !isStr(s.name)) fail(`${field}.name`, "must be a non-empty string");
  if (s.with !== undefined && (typeof s.with !== "object" || Array.isArray(s.with))) fail(`${field}.with`, "must be a map");
  return { ...(s.name ? { name: s.name } : {}), ...(hasRun ? { run: s.run } : { uses: s.uses, ...(s.with ? { with: s.with } : {}) }) };
}
const steps = (v, field) => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(field, "must be a list of steps");
  return v.map((s, i) => step(s, `${field}[${i}]`));
};

/** Validated answers with defaults filled in. Throws AnswersError naming the field. */
export function validateAnswers(raw) {
  if (!raw || typeof raw !== "object") throw new AnswersError("answers: must be an object");
  const a = raw;
  if (a.version !== undefined && a.version !== 1) fail("version", "only version 1 is known");
  const forge = oneOf(a.forge ?? "github", "forge", ["github"]);
  const language = oneOf(a.language ?? "zh", "language", ["zh", "en"]);
  const reviewer = oneOf(a.reviewer ?? "copilot", "reviewer", ["copilot", "claude"]);
  if (!isStr(a.project?.name)) fail("project.name", "is required");
  if (!/^[^/\s]+\/[^/\s]+$/.test(a.repo ?? "")) fail("repo", 'must be "owner/name"');
  if (!isStr(a.defaultBranch)) fail("defaultBranch", "is required");

  const people = a.people ?? {};
  const trustedAuthors = strList(people.trustedAuthors ?? [], "people.trustedAuthors", { min: 1, re: ID });
  const codeOwners = strList(people.codeOwners ?? trustedAuthors, "people.codeOwners", { min: 1, re: ID });
  const onCall = strList(people.onCall ?? trustedAuthors, "people.onCall", { re: ID });

  const paths = a.paths ?? {};
  const high = strList(paths.high ?? [], "paths.high");
  const security = strList(paths.security ?? [], "paths.security");
  const lowOnly = strList(paths.lowOnly ?? ["docs/**"], "paths.lowOnly");
  const sizeExcluded = paths.sizeExcluded === undefined ? undefined : strList(paths.sizeExcluded, "paths.sizeExcluded");

  const ci = a.ci ?? {};
  const testsRunner = oneOf(ci.testsRunner ?? "hosted", "ci.testsRunner", ["hosted", "self-hosted"]);
  // Labels matter only when something runs self-hosted (checked below, once the release gate's runner is known).
  const selfHostedLabels = strList(ci.selfHostedLabels ?? ["self-hosted"], "ci.selfHostedLabels");
  let releaseGate = null;
  if (ci.releaseGate) {
    const r = ci.releaseGate;
    if (!/^[a-z][a-z0-9-]*$/.test(r.name ?? "release-gate")) fail("ci.releaseGate.name", "must be a lower-case job name");
    releaseGate = {
      name: r.name ?? "release-gate",
      steps: steps(r.steps, "ci.releaseGate.steps"),
      runner: oneOf(r.runner ?? "hosted", "ci.releaseGate.runner", ["hosted", "self-hosted"]),
      timeoutMin: Number.isInteger(r.timeoutMin) && r.timeoutMin > 0 ? r.timeoutMin : 60,
    };
    if (!releaseGate.steps.length) fail("ci.releaseGate.steps", "needs at least one step");
  }
  if ((testsRunner === "self-hosted" || releaseGate?.runner === "self-hosted") && !selfHostedLabels.length) fail("ci.selfHostedLabels", "needs at least 1 when a job runs self-hosted");
  const checks = steps(ci.checks, "ci.checks");
  const tests = steps(ci.tests, "ci.tests");
  if (!checks.length && !tests.length) fail("ci", "needs at least one check or test step");

  const queueMode = oneOf(a.queue?.mode ?? "self", "queue.mode", ["self", "native"]);
  if (reviewer === "copilot" && forge !== "github") fail("reviewer", "copilot is only available on GitHub");

  const loops = { sweep: true, eval: true, metrics: true, ...(a.loops ?? {}) };
  for (const k of Object.keys(loops)) if (typeof loops[k] !== "boolean") fail(`loops.${k}`, "must be true or false");

  const release = a.release ?? {};
  const versionFiles = (release.versionFiles ?? [{ file: "package.json", field: "version" }]).map((v, i) => {
    if (!isStr(v?.file) || !isStr(v?.field)) fail(`release.versionFiles[${i}]`, "needs file and field");
    return { file: v.file, field: v.field };
  });

  return {
    version: 1,
    forge,
    language,
    reviewer,
    project: { name: a.project.name.trim(), description: isStr(a.project.description) ? a.project.description.trim() : "" },
    repo: a.repo,
    defaultBranch: a.defaultBranch,
    people: { trustedAuthors, codeOwners, onCall },
    paths: { high, security, lowOnly, ...(sizeExcluded ? { sizeExcluded } : {}) },
    failureModes: strList(a.failureModes ?? [], "failureModes"),
    securityChecklist: strList(a.securityChecklist ?? [], "securityChecklist"),
    ci: { setup: steps(ci.setup, "ci.setup"), checks, tests, testsRunner, selfHostedLabels, releaseGate },
    queue: { mode: queueMode },
    classifier: a.classifier ?? true,
    loops,
    release: { label: isStr(release.label) ? release.label : "release", versionFiles },
    stagedRollout: Boolean(a.stagedRollout),
  };
}
