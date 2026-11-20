#!/usr/bin/env node
/**
 * Deterministic renderer: answers → the process files in a target repository.
 *
 *   node tools/render.mjs --answers answers.json --target <repo>                 # plan only (default): what would change
 *   node tools/render.mjs --answers answers.json --target <repo> --write         # apply; refuses on conflicts
 *   node tools/render.mjs … --write --force <path>[,<path>…]  |  --force-all     # overwrite the named conflicts
 *   node tools/render.mjs … --json                                               # machine-readable plan
 *
 * Every output is decided against three things: what is on disk, what the last render wrote (`.dev-process/render-lock.json`,
 * sha256 per file) and what renders now:
 *   create     not on disk
 *   unchanged  on disk and identical
 *   update     on disk, differs, and still exactly what the last render wrote (nobody edited it) ⇒ safe to overwrite
 *   conflict   on disk, differs, and either edited since the last render or never rendered by us ⇒ needs --force
 *   insert     a section (CLAUDE.md) whose file exists without our markers ⇒ appended, the rest of the file untouched
 *   keep       a seed file (the eval cases) that exists ⇒ never overwritten, it is the team's data
 * `.dev-process/answers.json` is the renderer's own input: it is rewritten normalized and is never a conflict (the init and
 * upgrade skills write it by hand first, so it always differs from the normalized form on the first run).
 *   remove     in the lock, no longer produced, untouched since ⇒ deleted
 *   orphan     in the lock, no longer produced, but edited ⇒ left alone and reported
 * After writing, the consistency checks (engine/core/consistency.mjs) run on the result.
 * Exit codes: 0 ok · 2 usage/answers error · 3 conflicts (nothing written) · 4 written, but consistency errors.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { checkConsistency } from "../engine/core/consistency.mjs";
import { tr } from "../engine/core/messages/index.mjs";
import { AnswersError, validateAnswers } from "./answers.mjs";
import { buildContext } from "./context.mjs";
import { renderTemplate } from "./template.mjs";

const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const TEMPLATES = join(PLUGIN_ROOT, "templates");
const ENGINE = join(PLUGIN_ROOT, "engine");
export const LOCK_PATH = ".dev-process/render-lock.json";
export const SECTION_BEGIN = "<!-- dev-process:begin -->";
export const SECTION_END = "<!-- dev-process:end -->";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const pluginVersion = () => JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

/** All engine files, as repository-relative posix paths under `.dev-process/engine/`. */
function engineFiles(dir = ENGINE) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...engineFiles(p));
    else out.push(p);
  }
  return out.sort();
}

/**
 * What to produce. `kind`: file (template) · section (template inside markers) · text (computed) · seed (create once).
 * `when(ctx)` skips an output (and lets a previously rendered copy be removed).
 */
export function manifest(ctx, answers) {
  const L = ctx.lang;
  const tmpl = (p) => join(TEMPLATES, p.replace("{lang}", L));
  const evalDir = posix.dirname(ctx.policy.paths.evalCases);
  const gl = ctx.forge === "gitlab";
  const github = (c) => c.forge !== "gitlab";
  const gitlab = (c) => c.forge === "gitlab";
  const outs = [
    { out: ".dev-process/config.json", kind: "text", text: () => json(ctx.policy) },
    { out: ".dev-process/answers.json", kind: "input", text: () => json(answers) },
    { out: ".dev-process/VERSION", kind: "text", text: () => `${pluginVersion()}\n` },
    { out: "CLAUDE.md", kind: "section", tmpl: tmpl("common/{lang}/CLAUDE.section.md.tmpl") },
    { out: gl ? ".gitlab/merge_request_templates/Default.md" : ".github/pull_request_template.md", kind: "file", tmpl: tmpl("common/{lang}/pull_request_template.md.tmpl") },
    { out: ctx.instructionsPath, kind: "file", tmpl: tmpl("common/{lang}/ai-review-instructions.md.tmpl") },
    // Copilot reads `applyTo` from this file's front matter: with no security paths there is nothing to apply it to.
    { out: ctx.securityPath, kind: "file", tmpl: tmpl("common/{lang}/ai-review-security.md.tmpl"), when: (c) => !c.isCopilot || c.policy.securityPaths.length > 0 },
    { out: gl ? ".gitlab/CODEOWNERS" : ".github/CODEOWNERS", kind: "file", tmpl: tmpl("common/{lang}/CODEOWNERS.tmpl") },
    { out: "docs/dev-process/review-setup.md", kind: "file", tmpl: tmpl(gl ? "gitlab/{lang}/review-setup.md.tmpl" : "common/{lang}/review-setup.md.tmpl") },
    { out: "docs/dev-process/on-call.md", kind: "file", tmpl: tmpl("common/{lang}/on-call.md.tmpl") },
    { out: "docs/incident-review-template.md", kind: "file", tmpl: tmpl("common/{lang}/incident-review-template.md.tmpl") },
    { out: `${evalDir}/README.md`, kind: "file", tmpl: tmpl("common/{lang}/review-evals-README.md.tmpl"), when: (c) => c.loops.eval },
    { out: ctx.policy.paths.evalCases, kind: "seed", text: () => "[]\n", when: (c) => c.loops.eval },
    { out: ".github/workflows/ci.yml", kind: "file", tmpl: tmpl("github/workflows/ci.yml.tmpl"), when: github },
    { out: ".github/workflows/risk-gate.yml", kind: "file", tmpl: tmpl("github/workflows/risk-gate.yml.tmpl"), when: github },
    { out: ".github/workflows/risk-gate-events.yml", kind: "file", tmpl: tmpl("github/workflows/risk-gate-events.yml.tmpl"), when: github },
    { out: ".github/workflows/merge-queue.yml", kind: "file", tmpl: tmpl("github/workflows/merge-queue.yml.tmpl"), when: (c) => github(c) && c.queue.self },
    { out: `.github/workflows/${ctx.policy.names.aiReviewWorkflow}`, kind: "file", tmpl: tmpl("github/workflows/claude-review.yml.tmpl"), when: (c) => github(c) && c.isClaude },
    { out: ".github/workflows/nightly-review.yml", kind: "file", tmpl: tmpl("github/workflows/nightly-review.yml.tmpl"), when: (c) => github(c) && c.loops.sweep },
    { out: ".github/workflows/review-eval.yml", kind: "file", tmpl: tmpl("github/workflows/review-eval.yml.tmpl"), when: (c) => github(c) && c.loops.eval },
    { out: ".github/workflows/review-metrics.yml", kind: "file", tmpl: tmpl("github/workflows/review-metrics.yml.tmpl"), when: (c) => github(c) && c.loops.metrics },
    { out: ".gitlab-ci.yml", kind: "file", tmpl: tmpl("gitlab/gitlab-ci.yml.tmpl"), when: gitlab },
    { out: ".gitlab/dev-process.gitlab-ci.yml", kind: "file", tmpl: tmpl("gitlab/dev-process.gitlab-ci.yml.tmpl"), when: gitlab },
  ];
  for (const f of engineFiles()) {
    const rel = relative(ENGINE, f).split(sep).join("/");
    outs.push({ out: `.dev-process/engine/${rel}`, kind: "text", text: () => readFileSync(f, "utf8") });
  }
  return outs;
}

/** Content of one output (for a section: the section body including markers). */
function produce(o, ctx) {
  if (o.kind === "file" || o.kind === "section") {
    const body = renderTemplate(readFileSync(o.tmpl, "utf8"), ctx, relative(PLUGIN_ROOT, o.tmpl));
    return o.kind === "section" ? `${SECTION_BEGIN}\n${body.replace(/\n+$/, "")}\n${SECTION_END}\n` : body;
  }
  return o.text();
}

/** The marked section in a file's text: `{ start, end, text }` or null. */
export function findSection(text) {
  const start = text.indexOf(SECTION_BEGIN);
  if (start === -1) return null;
  const endAt = text.indexOf(SECTION_END, start);
  if (endAt === -1) return null;
  let end = endAt + SECTION_END.length;
  if (text[end] === "\n") end += 1;
  return { start, end, text: text.slice(start, end) };
}

const readLock = (target) => {
  const p = join(target, LOCK_PATH);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { files: {} };
};

/**
 * Options the data model knows but this version cannot install yet (they would validate, render, and then fail in CI or
 * block every pull request): refused here, at the entry point the skills and the CLI use.
 */
export const NOT_YET = Object.freeze([
  { field: "forge", value: "gitlab", why: "the GitLab CI template, protection and setup land later in M5; the engine side is in place" },
  { field: "queue.mode", value: "native", why: "the forge's native merge queue needs merge_group CI and gate support that is not built yet; use \"self\"" },
]);

export function assertRenderable(answers) {
  for (const n of NOT_YET) {
    const v = n.field.split(".").reduce((o, k) => o?.[k], answers);
    if (v === n.value) throw new AnswersError(`answers.${n.field}: "${n.value}" is not available yet — ${n.why}`);
  }
}

/**
 * The plan: `{ entries: [{ path, status, kind, content?, merged? }], lock }` — nothing is written.
 * For sections, `merged` is the whole new file text.
 */
export function plan(target, answers) {
  assertRenderable(answers);
  const ctx = buildContext(answers);
  const lock = readLock(target);
  const entries = [];
  const produced = new Set();
  for (const o of manifest(ctx, answers)) {
    if (o.when && !o.when(ctx)) continue;
    produced.add(o.out);
    const content = produce(o, ctx);
    const abs = join(target, o.out);
    const onDisk = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    const locked = lock.files[o.out];
    if (o.kind === "seed") {
      entries.push({ path: o.out, kind: o.kind, status: onDisk === null ? "create" : "keep", content });
      continue;
    }
    if (o.kind === "section") {
      if (onDisk === null) {
        const title = `# ${ctx.project.name}\n\n`;
        entries.push({ path: o.out, kind: o.kind, status: "create", content, merged: `${title}${content}` });
        continue;
      }
      const sec = findSection(onDisk);
      if (!sec) {
        entries.push({ path: o.out, kind: o.kind, status: "insert", content, merged: `${onDisk.replace(/\n*$/, "\n\n")}${content}` });
        continue;
      }
      const merged = `${onDisk.slice(0, sec.start)}${content}${onDisk.slice(sec.end)}`;
      const status = sec.text === content ? "unchanged" : locked === sha(sec.text) ? "update" : "conflict";
      entries.push({ path: o.out, kind: o.kind, status, content, merged });
      continue;
    }
    const status = onDisk === null ? "create" : onDisk === content ? "unchanged" : o.kind === "input" || locked === sha(onDisk) ? "update" : "conflict";
    entries.push({ path: o.out, kind: o.kind, status, content });
  }
  for (const [path, hash] of Object.entries(lock.files)) {
    if (produced.has(path)) continue;
    const abs = join(target, path);
    if (!existsSync(abs)) continue;
    entries.push({ path, kind: "stale", status: sha(readFileSync(abs, "utf8")) === hash ? "remove" : "orphan" });
  }
  return { entries, ctx };
}

/** Apply a plan. `force`: Set of paths (or "*") whose conflicts may be overwritten. Returns the new lock. */
export function apply(target, { entries }, { force = new Set() } = {}) {
  const blocked = entries.filter((e) => e.status === "conflict" && !force.has("*") && !force.has(e.path));
  if (blocked.length) {
    const err = new Error(`conflicts: ${blocked.map((e) => e.path).join(", ")}`);
    err.conflicts = blocked;
    throw err;
  }
  const lock = { pluginVersion: pluginVersion(), files: {} };
  for (const e of entries) {
    const abs = join(target, e.path);
    if (e.status === "remove") {
      rmSync(abs);
      continue;
    }
    if (e.status === "orphan" || e.status === "keep") continue;
    if (e.status !== "unchanged") {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, e.kind === "section" ? e.merged : e.content);
    }
    if (e.kind !== "seed") lock.files[e.path] = sha(e.content);
  }
  mkdirSync(dirname(join(target, LOCK_PATH)), { recursive: true });
  writeFileSync(join(target, LOCK_PATH), json(lock));
  return lock;
}

/** Tracked files in the target (git ls-files) plus everything just written; null when not a git repository. */
function trackedFiles(target, written) {
  let files = [];
  try {
    files = execFileSync("git", ["ls-files"], { cwd: target, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
  } catch {
    return null;
  }
  return [...new Set([...files, ...written])];
}

/** Consistency findings for the rendered result (rendered in the project language by the caller). */
export function verify(target, ctx, written = []) {
  const read = (p) => (existsSync(join(target, p)) ? readFileSync(join(target, p), "utf8") : null);
  return checkConsistency({
    policy: ctx.policy,
    codeowners: read(".github/CODEOWNERS"),
    applyTo: ctx.isCopilot && ctx.policy.securityPaths.length ? read(ctx.securityPath) : null,
    claudeMd: read("CLAUDE.md"),
    tracked: trackedFiles(target, written),
  });
}

const STATUS_ORDER = ["conflict", "create", "insert", "update", "remove", "orphan", "keep", "unchanged"];

export function formatPlan(entries) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  for (const e of entries) counts[e.status] += 1;
  const lines = [];
  const engine = entries.filter((e) => e.path.startsWith(".dev-process/engine/"));
  for (const e of entries.filter((x) => !x.path.startsWith(".dev-process/engine/")).sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.path.localeCompare(b.path))) {
    lines.push(`  ${e.status.padEnd(9)} ${e.path}`);
  }
  const engineStatus = [...new Set(engine.map((e) => e.status))].join("/");
  if (engine.length) lines.push(`  ${engineStatus.padEnd(9)} .dev-process/engine/ (${engine.length} files)`);
  lines.push("", Object.entries(counts).filter(([, n]) => n).map(([s, n]) => `${s} ${n}`).join(" · "));
  return lines.join("\n");
}

function parseCli(argv) {
  const args = { force: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write" || a === "--json") args[a.slice(2)] = true;
    else if (a === "--force-all") args.force.add("*");
    else if (a === "--force") for (const p of String(argv[++i] ?? "").split(",").filter(Boolean)) args.force.add(p);
    else if (a === "--answers" || a === "--target") args[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

async function main() {
  let args;
  let answers;
  try {
    args = parseCli(process.argv.slice(2));
    if (!args.answers || !args.target) throw new Error("usage: render.mjs --answers <file> --target <dir> [--write] [--force <paths> | --force-all] [--json]");
    answers = validateAnswers(JSON.parse(readFileSync(args.answers, "utf8")));
    assertRenderable(answers);
  } catch (e) {
    console.error(e instanceof AnswersError ? e.message : e.message);
    process.exitCode = 2;
    return;
  }
  const target = resolve(args.target);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    console.error(`target is not a directory: ${target}`);
    process.exitCode = 2;
    return;
  }
  const p = plan(target, answers);
  const conflicts = p.entries.filter((e) => e.status === "conflict" && !args.force.has("*") && !args.force.has(e.path));
  if (!args.write) {
    if (args.json) console.log(JSON.stringify(p.entries.map(({ path, status, kind }) => ({ path, status, kind })), null, 2));
    else console.log(formatPlan(p.entries));
    process.exitCode = conflicts.length ? 3 : 0;
    return;
  }
  if (conflicts.length) {
    console.error(formatPlan(p.entries));
    console.error(`\nrefusing to write: ${conflicts.length} conflict(s). Review them, then pass --force <path> (or --force-all).`);
    process.exitCode = 3;
    return;
  }
  apply(target, p, { force: args.force });
  const written = p.entries.filter((e) => !["remove", "orphan", "keep"].includes(e.status)).map((e) => e.path);
  const findings = verify(target, p.ctx, written);
  if (args.json) console.log(JSON.stringify({ entries: p.entries.map(({ path, status, kind }) => ({ path, status, kind })), findings }, null, 2));
  else {
    console.log(formatPlan(p.entries));
    for (const f of findings) console.log(`${f.level === "error" ? "ERROR" : "warn "} ${tr(answers.language, f)}`);
  }
  process.exitCode = findings.some((f) => f.level === "error") ? 4 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[render] ${e.stack || e.message}`);
    process.exitCode = 1;
  });
}
