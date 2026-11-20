/**
 * Policy (schema v2): the single source of truth for tiers, people, commands, names and tuning.
 * Lives in the target repository at `.dev-process/config.json`; scripts read the copy on the **base** branch
 * (a PR must not be able to change its own gate). Missing fields fall back to DEFAULTS.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TIERS = Object.freeze(["low", "medium", "high"]);
export const CONFIG_PATH = ".dev-process/config.json";

export const DEFAULTS = Object.freeze({
  version: 2,
  forge: "github", // github | gitlab
  language: "zh", // zh | en
  reviewer: "copilot", // copilot | claude
  trustedAuthors: [],
  /** People per tier; the author's sign-off counts as one. */
  requiredHumans: { low: 0, medium: 1, high: 2 },
  /** Extra approvals when the author is not in trustedAuthors. */
  untrustedExtraApprovals: 1,
  /** Extra approvals when the AI review is waived for the head commit. */
  aiReviewWaiverExtraApprovals: 1,
  sizeThresholdLines: 1000,
  reviewRoundCap: 3,
  threadReplyTags: ["fixed:", "wrong:", "intended:", "wontfix:"],
  highPaths: [],
  securityPaths: [],
  lowOnlyPaths: ["docs/**"],
  sizeExcludedPaths: [
    "docs/**",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/Cargo.lock",
    "**/go.sum",
    "**/poetry.lock",
    "**/uv.lock",
  ],
  commands: { signoff: "/signoff", waiver: "/waive-ai-review" },
  names: {
    gateContext: "risk-gate",
    classifierContext: "risk-classifier",
    queueContext: "merge-queue",
    queueLabel: "merge-queue",
    riskLabelPrefix: "risk:",
    sweepLabel: "nightly-review",
    evalLabel: "review-eval",
    metricsLabel: "review-metrics",
    ciWorkflow: "ci.yml",
    gateWorkflow: "risk-gate.yml",
    queueWorkflow: "merge-queue.yml",
  },
  checks: { required: ["checks", "tests"], skippable: [] },
  queue: { mode: "self", ciTimeoutMin: 120, maxAttempts: 3, pollSeconds: 20, gatePendingStaleMin: 20, mergeMethod: "merge" },
  patterns: { revert: "^(revert|回滚)", fix: "^fix\\b" },
  /** Where the vendored process keeps its files in the target repository. */
  paths: {
    instructions: ".dev-process/ai-review/instructions.md",
    security: ".dev-process/ai-review/security.md",
    evalCases: ".dev-process/review-evals/cases.json",
  },
  sweep: { maxFindings: 5, dedupLines: 15 },
  /** promptHints: project-specific lines appended to the eval prompt (e.g. "check the retired-symbols list in …"). */
  eval: { lineSlack: 10, maxDiffBytes: 68000, promptHints: [] },
  /** riskHints: project-specific risk categories for the classifier prompt (one line each). */
  classifier: { enabled: true, riskHints: [], maxDiffBytes: 80000 },
  protection: { bypassActorId: 5, integrationId: 15368 },
});

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Deep merge: objects merge key by key, arrays and scalars from `over` replace. */
function merge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isPlainObject(base?.[k]) && isPlainObject(v) ? merge(base[k], v) : v;
  return out;
}

/** Policy with defaults filled in. Accepts the v1 field `aiReviewWaiverCommand` (reference implementation). */
export function withDefaults(raw = {}) {
  const { aiReviewWaiverCommand, $comment, ...rest } = raw;
  const legacy = typeof aiReviewWaiverCommand === "string" ? { commands: { waiver: aiReviewWaiverCommand } } : {};
  return merge(merge(DEFAULTS, legacy), rest);
}

export function loadPolicy(root = process.cwd(), rel = CONFIG_PATH) {
  return withDefaults(JSON.parse(readFileSync(join(root, rel), "utf8")));
}

export const rank = (tier) => TIERS.indexOf(tier);
