/**
 * Nightly sweep, pure parts (I/O in cli/nightly-sweep.mjs). After the Claude Code team's practice: a review agent sweeps
 * the EXISTING code every night, so old bugs are caught before they surface somewhere else. Each night takes the next
 * security review area (`policy.securityPaths`); an AI CLI reads the code with read-only tools.
 *
 * Issues are filed only for findings with a file and line, where the file exists and lies in tonight's area. A finding
 * within ±`policy.sweep.dedupLines` lines of one already filed in the same file (closed issues included) is not filed
 * again — never deduplicated by title: the model words it differently every time.
 */
import { posix } from "node:path";

import { asCodeBlock, assertCli, findingFormat, neutralizeMentions } from "./findings.mjs";
import { t } from "./messages/index.mjs";
import { DEFAULTS } from "./policy.mjs";

const DEFAULT_LABEL = DEFAULTS.names.sweepLabel;

/** The area for a date (day of the year modulo the number of areas). */
export function areaForDate(areas, date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dayOfYear = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000);
  return areas[dayOfYear % areas.length];
}

/**
 * The sweep prompt.
 * @param opts.cli  "copilot" | "claude": which read-only tools the model is told to use
 * @param opts.pr   "PR" | "MR" (wording only)
 */
export function buildSweepPrompt(instructions, area, { lang, cli, maxFindings = DEFAULTS.sweep.maxFindings, pr = "PR" }) {
  assertCli(cli);
  return [
    t(lang, "sweep.prompt.task", { area, pr }),
    t(lang, "sweep.prompt.tools", { cli }),
    t(lang, "sweep.prompt.scope"),
    t(lang, "sweep.prompt.max", { max: maxFindings }),
    "",
    t(lang, "sweep.prompt.criteria", { pr }),
    instructions,
    "",
    findingFormat(lang),
  ].join("\n");
}

/** Findings inside tonight's area, at most `max`. */
export function findingsInArea(findings, area, max = DEFAULTS.sweep.maxFindings) {
  return findings.filter((f) => posix.matchesGlob(f.file, area)).slice(0, max);
}

/** Location marker written into the issue body: `<!-- <label>:file=…;line=… -->`. */
export function findingMarker(f, label = DEFAULT_LABEL) {
  return `<!-- ${label}:file=${encodeURIComponent(f.file)};line=${f.line} -->`;
}

/**
 * The text outside fenced code blocks (a fence opens at a line starting with a run of ≥ 3 backticks and closes at a line
 * of only backticks, at least as long). The model-written evidence sits inside one; nothing in there counts.
 */
export function outsideFences(text) {
  const kept = [];
  let fence = 0;
  for (const line of String(text).split("\n")) {
    const run = /^ {0,3}(`{3,})/.exec(line)?.[1].length ?? 0;
    if (fence === 0 && run >= 3) fence = run;
    else if (fence > 0 && run >= fence && /^ {0,3}`+\s*$/.test(line)) fence = 0;
    else if (fence === 0) kept.push(line);
  }
  return kept.join("\n");
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Location markers read back from an existing issue body. Markers inside code blocks don't count: that is model text,
 * which could forge a marker and suppress real findings near it forever.
 */
export function markersIn(body, label = DEFAULT_LABEL) {
  const re = new RegExp(`<!-- ${escapeRe(label)}:file=([^;]+);line=(\\d+) -->`, "g");
  return [...outsideFences(body ?? "").matchAll(re)].map((m) => ({ file: decodeURIComponent(m[1]), line: Number(m[2]) }));
}

/** Same file and lines at most `dedupLines` apart ⇒ the same problem. */
export function isDuplicate(f, known, dedupLines = DEFAULTS.sweep.dedupLines) {
  return known.some((k) => k.file === f.file && Math.abs(k.line - f.line) <= dedupLines);
}

/**
 * The issue for one finding. Title and evidence are model-written: the evidence goes verbatim into a code block
 * (`asCodeBlock`), the model's sentence in the title has its mentions and references broken (`neutralizeMentions`). The
 * file path was validated (it exists in the repository) and is written as is, so it stays searchable.
 * @param opts `{ lang, label, pr }`
 */
export function issueFor(f, area, { lang, label = DEFAULT_LABEL, pr = "PR" }) {
  return {
    title: t(lang, "sweep.issue.title", { title: neutralizeMentions(f.title), file: f.file, line: f.line }),
    labels: [label],
    body: [
      findingMarker(f, label),
      t(lang, "sweep.issue.area", { area }),
      "",
      t(lang, "sweep.issue.location", { file: f.file, line: f.line }),
      "",
      f.evidence ? t(lang, "sweep.issue.evidence", { block: asCodeBlock(f.evidence) }) : t(lang, "sweep.issue.noEvidence"),
      "",
      t(lang, "sweep.issue.footer", { pr }),
    ].join("\n"),
  };
}
