/**
 * Consistency of the process files (pure; `doctor --local` runs it, and render runs it after writing).
 * The policy is the single source of truth; the files that must mirror it are checked here instead of trusted:
 * - CODEOWNERS ↔ highPaths: forges only read CODEOWNERS, so it is a copy that must not drift;
 * - the Copilot security instruction's `applyTo` ↔ securityPaths: Copilot only reads front matter;
 * - every CODEOWNERS owner is a trusted author, and each line names two (an author cannot approve their own PR);
 * - the process files themselves are high (the AI reads the instructions from the PR branch, so changing them needs
 *   another person);
 * - the waiver command differs from sign-off and costs at least one extra approval; CLAUDE.md names the same command;
 * - people per tier never decrease, low needs nobody, high needs two;
 * - no tracked file is both high and low; every high/security glob matches a tracked file (a typo is the same as nothing).
 * Findings: `{ level: "error" | "warn", code, params }`. Warnings are expected on a brand-new repository (paths not
 * created yet, a one-person team).
 */
import { posix } from "node:path";

const hit = (f, globs) => globs.some((g) => posix.matchesGlob(f, g));
const sorted = (xs) => [...xs].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** CODEOWNERS pattern → policy glob: `/dir/` ⇒ `dir/**`, `/file` ⇒ `file`. */
export const codeownersToGlob = (pattern) => pattern.replace(/^\//, "").replace(/\/$/, "/**");

/** policy glob → CODEOWNERS pattern (inverse of codeownersToGlob for the shapes we generate). */
export const globToCodeowners = (glob) => `/${glob.replace(/\/\*\*$/, "/")}`;

export function parseCodeowners(text) {
  return String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("["))
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { glob: codeownersToGlob(pattern), owners: owners.map((o) => o.replace(/^@/, "")) };
    });
}

/** `applyTo: "a,b"` from a front matter block, or null when there is none. */
export function parseApplyTo(text) {
  const m = /^---\n[\s\S]*?applyTo:\s*"([^"]+)"[\s\S]*?\n---/.exec(String(text ?? ""));
  return m ? m[1].split(",").map((s) => s.trim()) : null;
}

/**
 * Paths that hold the process itself, per forge: changing them must always need a human. Besides the CI files and our
 * own directory, everything that steers the Claude Code running the review: CLAUDE.md files at any depth (read as
 * instructions), `.claude/` (settings and hooks, which run shell commands) and `.mcp.json` (MCP servers it may start).
 * A change there could make the review job run commands or post a fake review for its own PR.
 */
export function processPaths(policy) {
  return [...(policy.forge === "gitlab" ? [".gitlab-ci.yml", ".gitlab/**"] : [".github/**"]), "**/CLAUDE.md", ".claude/**", ".mcp.json", ".dev-process/**"];
}

/**
 * @param input.codeowners  CODEOWNERS text | null (absent ⇒ skipped)
 * @param input.applyTo     security instruction text for Copilot | null
 * @param input.claudeMd    CLAUDE.md text | null
 * @param input.tracked     tracked file paths (git ls-files) | null
 */
export function checkConsistency({ policy, codeowners = null, applyTo = null, claudeMd = null, tracked = null }) {
  const out = [];
  const add = (level, code, params = {}) => out.push({ level, code, params });

  if (codeowners !== null) {
    const entries = parseCodeowners(codeowners);
    const globs = entries.map((e) => e.glob);
    if (!same(globs, policy.highPaths)) {
      add("error", "consistency.codeownersMismatch", {
        missing: policy.highPaths.filter((g) => !globs.includes(g)),
        extra: globs.filter((g) => !policy.highPaths.includes(g)),
      });
    }
    for (const e of entries) {
      const untrusted = e.owners.filter((o) => !o.includes("/") && !policy.trustedAuthors.includes(o));
      if (untrusted.length) add("error", "consistency.ownerNotTrusted", { glob: e.glob, owners: untrusted });
      if (e.owners.length < 2) add("warn", "consistency.singleOwner", { glob: e.glob, pr: policy.forge === "gitlab" ? "MR" : "PR" });
    }
  }

  if (applyTo !== null) {
    const list = parseApplyTo(applyTo);
    if (!list) add("error", "consistency.applyToMissing");
    else if (!same(list, policy.securityPaths)) add("error", "consistency.applyToMismatch", { missing: policy.securityPaths.filter((g) => !list.includes(g)), extra: list.filter((g) => !policy.securityPaths.includes(g)) });
  }

  const notHigh = processPaths(policy).filter((p) => !policy.highPaths.includes(p));
  if (notHigh.length) add("error", "consistency.processNotHigh", { paths: notHigh });

  const { signoff, waiver } = policy.commands;
  if (waiver === signoff) add("error", "consistency.waiverIsSignoff", { cmd: waiver });
  if (!(policy.aiReviewWaiverExtraApprovals >= 1)) add("error", "consistency.waiverFree");
  if (claudeMd !== null && !claudeMd.includes(`\`${waiver} <head sha>\``)) add("error", "consistency.claudeMdWaiver", { cmd: waiver });
  if (claudeMd !== null && !claudeMd.includes(`\`${signoff} <head sha>\``)) add("error", "consistency.claudeMdSignoff", { cmd: signoff });

  const { low, medium, high } = policy.requiredHumans;
  if (low !== 0) add("warn", "consistency.lowNeedsPeople", { n: low });
  if (!(medium >= low && high >= medium)) add("error", "consistency.humansDecrease", { low, medium, high });
  if (high < 2) add("warn", "consistency.highUnderTwo", { n: high });
  if (policy.trustedAuthors.length < 2) add("warn", "consistency.oneTrustedAuthor", { n: policy.trustedAuthors.length });

  if (tracked !== null) {
    const both = tracked.filter((f) => hit(f, policy.highPaths) && hit(f, policy.lowOnlyPaths));
    if (both.length) add("error", "consistency.highAndLow", { files: both });
    // Process paths guard files that may only appear later (a PR adding .claude/settings.json is the case to catch).
    const guards = new Set(processPaths(policy));
    const dead = [...new Set([...policy.highPaths, ...policy.securityPaths])].filter((g) => !guards.has(g) && !tracked.some((f) => posix.matchesGlob(f, g)));
    if (dead.length) add("warn", "consistency.deadGlobs", { globs: dead });
  }
  return out;
}
