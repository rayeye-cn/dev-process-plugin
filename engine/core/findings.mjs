/**
 * The shared output contract of an AI CLI review run (used by the nightly sweep, core/sweep.mjs, and the review eval,
 * core/eval.mjs):
 *
 * - The prompt carries the repository's review instructions (`policy.paths.instructions` + the body of the security
 *   checklist at `policy.paths.security`): the same instructions the AI code review on PRs uses.
 * - The model prints one line per finding, `FINDING {"file":"…","line":12,"title":"…","evidence":"…"}`, or one line
 *   `NONE` when there is nothing to report.
 * - Parsing keeps only well-formed lines; validation keeps only files that exist with the line inside the file —
 *   problems guessed from a name alone are not wanted.
 *
 * `FINDING` / `NONE` are machine-read tokens and never translated; the rest of the format instruction comes from the
 * catalog, in the project language (the title is requested in that language).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

import { extractText } from "./ai-output.mjs";
import { t } from "./messages/index.mjs";

export const FINDING_TOKEN = "FINDING";
export const NONE_TOKEN = "NONE";

/** AI CLIs that can run a read-only review; each gets its own read-only tool sentence in the prompts. */
export const AI_CLIS = Object.freeze(["copilot", "claude"]);

export function assertCli(cli) {
  if (!AI_CLIS.includes(cli)) throw new Error(`unknown AI CLI "${cli}" (known: ${AI_CLIS.join(", ")})`);
  return cli;
}

/** The output format instruction (ends every review prompt). */
export function findingFormat(lang) {
  return t(lang, "finding.format", { finding: FINDING_TOKEN, none: NONE_TOKEN });
}

const FRONT_MATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Text without a leading YAML front matter block (`applyTo:` and the like are for the forge, not the prompt). */
export const stripFrontMatter = (text) => String(text).replace(FRONT_MATTER, "");

/** The repository's review instructions: general instructions, then the security checklist, front matter removed. */
export function reviewInstructions(root, policy) {
  const read = (rel) => stripFrontMatter(readFileSync(join(root, rel), "utf8")).trim();
  // The security checklist is optional: with no security paths, a Copilot setup has no such file.
  const security = existsSync(join(root, policy.paths.security)) ? read(policy.paths.security) : "";
  return security ? `${read(policy.paths.instructions)}\n\n${security}` : read(policy.paths.instructions);
}

/*
 * Before model-written text goes to the forge (found while verifying the first sweep issues): the sweep reads the code
 * and its comments, so through a prompt injection — or just the model writing freely — the text can contain `@someone`
 * (the forge notifies that person), `#126` / `owner/repo#1` (a cross-reference left on another issue, PR or even another
 * repository), entities like `&#64;someone` (rendered as @, still a mention) and `<!-- … -->` (hides what follows, or
 * forges a dedup marker).
 * In bodies, always show it verbatim with `asCodeBlock`; titles are not rendered as markdown, use `neutralizeMentions`.
 * Any future output that posts model text goes through these two as well.
 */

/** Plain text such as a title: a zero-width space after every `@` / `#` followed by a letter or digit (breaks mentions and refs). */
export function neutralizeMentions(text) {
  return String(text).replace(/([@#])(?=[A-Za-z0-9])/g, "$1​");
}

/**
 * Model text shown verbatim in a body: a fenced code block, where mentions, entities, HTML comments, references and
 * links have no effect and quoted code stays exactly as written. The fence is longer than the longest backtick run in the
 * text, so the text cannot break out.
 */
export function asCodeBlock(text, lang = "text") {
  const s = String(text);
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${s}\n${fence}`;
}

const FINDING_LINE = new RegExp(`^\\s*${FINDING_TOKEN}\\s+(\\{.*\\})\\s*$`);

/** FINDING lines of plain text (already extracted); malformed ones are dropped. */
function findingLines(text, max) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = FINDING_LINE.exec(line);
    if (!m) continue;
    let f;
    try {
      f = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const lineNo = Number(f?.line);
    if (typeof f?.file !== "string" || !f.file || !Number.isInteger(lineNo) || lineNo < 1 || typeof f.title !== "string") continue;
    out.push({
      file: f.file.replace(/^\.?\//, ""),
      line: lineNo,
      title: f.title.replace(/\s+/g, " ").trim().slice(0, 120),
      evidence: String(f.evidence ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    });
    if (out.length >= max) break;
  }
  return out;
}

/** FINDING lines of an AI CLI's output (Copilot plain text or Claude JSON, see ai-output.mjs); malformed ones are dropped. */
export function parseFindings(raw, max = 20) {
  return findingLines(extractText(raw), max);
}

/** Does the output say "nothing found": a line that is exactly NONE (not the word inside a sentence)? */
export function saysNone(raw) {
  return new RegExp(`^\\s*${NONE_TOKEN}\\s*$`, "m").test(extractText(raw));
}

/** Keep only findings whose file is in the repository, with the line in range, and that do not escape the root. */
export function validateFindings(findings, root) {
  return findings.filter((f) => {
    const rel = normalize(f.file);
    if (rel.startsWith("..") || rel.startsWith("/")) return false;
    const abs = join(root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) return false;
    const lines = readFileSync(abs, "utf8").split("\n").length;
    return f.line <= lines;
  });
}
