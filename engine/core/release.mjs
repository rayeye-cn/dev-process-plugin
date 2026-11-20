/**
 * Release detection (pure, no I/O): does this CI run need the heavy release gate (the check `checks.skippable` lists)?
 * A change is a release when it carries `policy.release.label`, or when any `policy.release.versionFiles[].file`'s JSON
 * `field` differs from the base. The I/O (git, the forge, CI outputs) is in cli/detect-release.mjs.
 *
 * Which base the versions are compared with (baseRefFor):
 * - pull_request: the PR's base sha (when missing, the default branch; the label still counts).
 * - the merge queue (workflow_dispatch with a PR number): the base the queue passes — while testing, the target-branch
 *   commit the candidate branch was built on; when re-running after a merge, the merged commit's parent (the target
 *   branch before the merge). In that re-run HEAD and the default branch both contain the change already, so comparing
 *   with the default branch would always find the same version and skip a release gate triggered only by the version:
 *   the passed base is required. No base passed (a manual re-run by PR number) ⇒ the default branch.
 * - anything else (a manual run without a PR number) ⇒ no detection, not a release.
 */

/**
 * The ref to compare versions with; null when no detection is needed. The passed `base` and `pr` end up in git
 * arguments and API paths: a malformed one throws.
 */
export function baseRefFor({ event, prBaseSha, queuePr, baseInput, defaultBranch }) {
  if (event === "pull_request") return prBaseSha || `origin/${defaultBranch}`;
  if (event !== "workflow_dispatch" || !queuePr) return null;
  if (!/^\d+$/.test(queuePr)) throw new Error(`pr must be a PR number, got "${queuePr}"`);
  if (!baseInput) return `origin/${defaultBranch}`;
  if (!/^[0-9a-f]{40}$/.test(baseInput)) throw new Error(`base must be a 40-character commit sha, got "${baseInput}"`);
  return baseInput;
}

/** A JSON field by a dotted path (`version`, `tool.version`); missing ⇒ undefined. */
export function readField(json, field) {
  return String(field ?? "")
    .split(".")
    .filter(Boolean)
    .reduce((v, k) => (v !== null && typeof v === "object" ? v[k] : undefined), json);
}

/** Version entries `{ file, field, base, head }` whose value changed. */
export function changedVersions(versions = []) {
  return versions.filter((v) => JSON.stringify(v.base) !== JSON.stringify(v.head));
}

/** Label names (strings or `{ name }`) include the release label; no label configured ⇒ false. */
export function hasLabel(labels, label) {
  if (!label) return false;
  return (labels ?? []).some((l) => (typeof l === "string" ? l : l?.name) === label);
}

/** A version changed, or the release label is on ⇒ run the release gate. */
export function isRelease({ versions = [], labeled = false }) {
  return Boolean(labeled) || changedVersions(versions).length > 0;
}
