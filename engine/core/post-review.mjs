/**
 * The Claude review on GitLab (pure). GitLab has no Claude App and no inline-comment tool: a Claude CLI run reads the
 * merge request with read-only tools and answers with ONE JSON object (REVIEW_SCHEMA); the process bot then posts it
 * (cli/post-review.mjs):
 * - every finding becomes a thread the gate requires an answer on: a diff thread on its line when the line is in the
 *   merge request's diff, otherwise a plain thread on the MR that names the place;
 * - then ONE summary note, written here (not by the model), whose last line is the review marker for the reviewed head.
 * The model's text is shown as it wrote it, with mentions and references broken (GitLab notifies on `@user` and leaves
 * "mentioned in" notes for `#1` / `!1` / `&1`), HTML comments disarmed (no forged markers) and, in the adapter, no quick
 * actions.
 */
import { extractText } from "./ai-output.mjs";
import { claudeMarker } from "../reviewer/claude.mjs";
import { t } from "./messages/index.mjs";

/** What the review run must answer (`claude --json-schema`). */
export const REVIEW_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["findings", "risk", "reason"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "title", "body"],
        properties: {
          file: { type: "string", description: "path relative to the repository root, as in the diff" },
          line: { type: "integer", minimum: 1, description: "line number in the new version of the file" },
          title: { type: "string", description: "one sentence: what goes wrong" },
          body: { type: "string", description: "in which situation it goes wrong and how to fix it" },
        },
      },
    },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    reason: { type: "string", description: "one sentence: why that risk" },
    unchecked: { type: "string", description: "what could not be checked, or empty" },
  },
});

const TITLE_MAX = 200;
const BODY_MAX = 4000;

/** The review object from the CLI's output, or null when it is not one (the job then leaves a notice). */
export function parseReview(raw) {
  let o;
  try {
    o = JSON.parse(extractText(raw).trim());
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || !Array.isArray(o.findings) || !["low", "medium", "high"].includes(o.risk)) return null;
  const findings = o.findings
    .filter((f) => f && typeof f.file === "string" && f.file.trim() && Number.isInteger(f.line) && f.line > 0 && typeof f.title === "string" && f.title.trim())
    .map((f) => ({ file: f.file.trim().replace(/^\.?\//, ""), line: f.line, title: f.title.trim().slice(0, TITLE_MAX), body: String(f.body ?? "").trim().slice(0, BODY_MAX) }));
  return { findings, risk: o.risk, reason: String(o.reason ?? "").trim().slice(0, 300), unchecked: String(o.unchecked ?? "").trim().slice(0, 500) };
}

/**
 * Lines of the new file a diff thread can sit on: added lines (old line null) and context lines (with their old line,
 * which GitLab needs for an unchanged line). `Map<newLine, oldLine | null>`.
 */
export function diffLines(diff) {
  const out = new Map();
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of String(diff ?? "").replace(/\n$/, "").split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) out.set(newNo++, null);
    else if (line.startsWith("-")) oldNo++;
    else if (line.startsWith(" ") || line === "") out.set(newNo++, oldNo++);
  }
  return out;
}

/**
 * Model text for a GitLab note: a zero-width space after `@ # ! & $ %` when a name or number follows (no mentions, no
 * cross-references), and `<!--` disarmed (no hidden text, no forged markers).
 */
export function neutralizeForGitlab(text) {
  // References first, then the comment opener (its "&lt;" must not be split by the reference rule).
  return String(text ?? "")
    .replace(/([@#!&$%])(?=[A-Za-z0-9_"])/g, "$1​")
    .replace(/<!--/g, "&lt;!--");
}

/** Token shapes that must never be posted: GitLab access / job tokens, Anthropic keys. */
const TOKEN_SHAPES = [/\bglpat-[A-Za-z0-9_-]{10,}/g, /\bglcbt-[A-Za-z0-9_-]{10,}/g, /\bsk-ant-[A-Za-z0-9_-]{10,}/g];

/**
 * Secrets out of model text: the exact values the posting job knows (its API key, the bot token) and anything shaped
 * like a token. The review run cannot read the job's environment (restricted mode keeps its file tools inside the
 * checkout), so this is the second line, not the first.
 */
export function scrubSecrets(text, secrets = []) {
  let out = String(text ?? "");
  for (const v of secrets) if (typeof v === "string" && v.length >= 8) out = out.split(v).join("[redacted]");
  for (const re of TOKEN_SHAPES) out = out.replace(re, "[redacted]");
  return out;
}

/**
 * Which threads to open and what the summary says.
 * @param review  parseReview() result
 * @param diffs   the MR's `/diffs` entries `{ old_path, new_path, diff, deleted_file }`
 * @returns `{ threads: [{ body, fallbackBody, position | null }], summary }` — position `{ new_path, old_path, new_line, old_line }`
 */
export function planReview(review, diffs, { sha, maxComments = 10, lang = "en", pr = "MR", secrets = [] } = {}) {
  const clean = (text) => neutralizeForGitlab(scrubSecrets(text, secrets));
  const byPath = new Map(diffs.filter((d) => !d.deleted_file).map((d) => [d.new_path, d]));
  const kept = review.findings.slice(0, maxComments);
  const threads = kept.map((f) => {
    const d = byPath.get(f.file);
    const lines = d ? diffLines(d.diff) : new Map();
    const onDiff = lines.has(f.line);
    const title = clean(f.title);
    const text = clean(f.body);
    // The place in backticks: a path is shown as written, never read as a reference.
    const named = [`**${title}** (\`${f.file}:${f.line}\`)`, "", text].join("\n").trim();
    return {
      body: onDiff ? [`**${title}**`, "", text].join("\n").trim() : named,
      fallbackBody: named,
      position: onDiff ? { new_path: d.new_path, old_path: d.old_path, new_line: f.line, old_line: lines.get(f.line) } : null,
    };
  });
  const summary = [
    t(lang, "aiReview.gitlab.summary", {
      n: threads.length,
      dropped: review.findings.length - kept.length,
      offDiff: threads.filter((th) => !th.position).length,
      risk: review.risk,
      reason: clean(review.reason),
      unchecked: clean(review.unchecked),
      pr,
    }),
    "",
    claudeMarker(sha),
  ].join("\n");
  return { threads, summary };
}
