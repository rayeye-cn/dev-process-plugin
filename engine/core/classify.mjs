/**
 * The AI "second classifier" (pure, no I/O). Following the Claude Code team's practice: besides the path-based tier,
 * ask once more "does this change need more people than the rules say?". The result can only RAISE the tier (the gate
 * takes the higher of the two, see core/gate.mjs), so a prompt injection in the PR can at worst make the gate stricter,
 * never looser.
 *
 * The prompt is built from the policy: `highPaths` and `lowOnlyPaths` (what the rules already decided) and
 * `classifier.riskHints` (the project's own risk categories, one line each); the diff is capped at
 * `classifier.maxDiffBytes`. The AI answers with two machine-read lines (TIER_TOKEN / REASON_TOKEN, language-neutral);
 * the reason itself is asked for in the project's language.
 */
import { posix } from "node:path";

import { extractText } from "./ai-output.mjs";
import { t } from "./messages/index.mjs";
import { TIERS } from "./policy.mjs";

/** Machine-read answer tokens: never translated (the parser looks for them). */
export const TIER_TOKEN = "TIER:";
export const REASON_TOKEN = "REASON:";
/** The reason is cut to this many characters (it ends up in a commit status description). */
export const REASON_MAX = 120;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Cut to `max` UTF-8 bytes without splitting a multi-byte character. */
export function truncateBytes(text, max) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false };
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/** git quotes non-ASCII paths and writes their bytes as octal escapes (`"a/design/62-\344\270\213…"`): back to UTF-8. */
function unquoteGitPath(s) {
  const bytes = [];
  const named = { n: "\n", t: "\t", '"': '"', "\\": "\\" };
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && /^[0-7]{3}$/.test(s.slice(i + 1, i + 4))) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (s[i] === "\\" && i + 1 < s.length) {
      bytes.push(...Buffer.from(named[s[i + 1]] ?? s[i + 1], "utf8"));
      i += 1;
    } else {
      bytes.push(...Buffer.from(s[i], "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The old and new paths of a `diff --git` header (quoted ones too). */
export function diffHeaderPaths(chunk) {
  const m = /^diff --git (?:"a\/((?:[^"\\]|\\.)*)"|a\/(\S+)) (?:"b\/((?:[^"\\]|\\.)*)"|b\/(\S+))/.exec(chunk);
  if (!m) return [];
  return [m[1] !== undefined ? unquoteGitPath(m[1]) : m[2], m[3] !== undefined ? unquoteGitPath(m[3]) : m[4]];
}

/** Split the diff per file and move files that only touch lowOnlyPaths to the end: truncation drops docs, not code. */
export function orderDiff(diff, lowOnlyPaths) {
  const chunks = String(diff).split(/(?=^diff --git )/m).filter(Boolean);
  const isDoc = (chunk) => {
    const paths = diffHeaderPaths(chunk);
    return paths.length > 0 && paths.every((p) => lowOnlyPaths.some((g) => posix.matchesGlob(p, g)));
  };
  return [...chunks.filter((c) => !isDoc(c)), ...chunks.filter(isDoc)].join("");
}

/**
 * The classifier prompt, in `policy.language`.
 * @param diff     already ordered and truncated (orderDiff + truncateBytes)
 * @param options  `{ title, truncated, pr }` — pr is "PR" or "MR" (wording only)
 */
export function buildPrompt(policy, diff, { title = "", truncated = false, pr = "PR" } = {}) {
  const lang = policy.language;
  const hints = (policy.classifier?.riskHints ?? []).map((x) => String(x).trim()).filter(Boolean);
  return [
    t(lang, "classify.prompt.intro"),
    "",
    t(lang, "classify.prompt.rules"),
    ...(hints.length ? [t(lang, "classify.prompt.hints", { hints })] : []),
    t(lang, "classify.prompt.paths", { highPaths: policy.highPaths ?? [], lowOnlyPaths: policy.lowOnlyPaths ?? [] }),
    t(lang, "classify.prompt.injection"),
    "",
    t(lang, "classify.prompt.output", { tierToken: TIER_TOKEN, reasonToken: REASON_TOKEN, tiers: TIERS.join("|"), max: REASON_MAX }),
    "",
    t(lang, "classify.prompt.title", { pr, title }),
    truncated ? t(lang, "classify.prompt.truncated", { maxBytes: policy.classifier.maxDiffBytes }) : "",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

/**
 * The last TIER / REASON pair in the AI CLI's output (Copilot plain text or Claude `--output-format json`, see
 * ai-output.mjs); none ⇒ null. The reason loses line breaks and shell-special characters and is cut to REASON_MAX: it
 * travels through `$GITHUB_OUTPUT` and environment variables into a status description.
 */
export function parseOutput(raw) {
  const text = extractText(raw);
  const tiers = [...text.matchAll(new RegExp(`^\\s*${escapeRe(TIER_TOKEN)}\\s*(${TIERS.join("|")})\\b`, "gim"))];
  if (!tiers.length) return null;
  const tier = tiers.at(-1)[1].toLowerCase();
  const reasons = [...text.matchAll(new RegExp(`^\\s*${escapeRe(REASON_TOKEN)}\\s*(.+)$`, "gim"))];
  const reason = (reasons.at(-1)?.[1] ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[`$\\]/g, "")
    .trim()
    .slice(0, REASON_MAX);
  return TIERS.includes(tier) ? { tier, reason } : null;
}
