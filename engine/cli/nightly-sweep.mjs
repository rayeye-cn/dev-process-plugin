#!/usr/bin/env node
/**
 * Nightly sweep CLI (I/O). The rules are in core/sweep.mjs; the AI output contract in core/findings.mjs.
 *
 *   node .dev-process/engine/cli/nightly-sweep.mjs prompt [--area <glob>] [--date YYYY-MM-DD] [--cli copilot|claude] > prompt.txt
 *   <AI CLI with read-only tools only, on a read-only workspace> > out.txt
 *   node .dev-process/engine/cli/nightly-sweep.mjs parse --area <glob> < out.txt > findings.json      # another job, fresh checkout
 *   node .dev-process/engine/cli/nightly-sweep.mjs file-issues [--repo owner/name] --area <glob> findings.json
 *
 * `prompt` picks tonight's area (policy.securityPaths in turn by date, or --area) and, in CI, writes `area=<glob>` to
 * `$GITHUB_OUTPUT` for the later job. `--cli` defaults to the policy's reviewer (the AI CLI that runs the sweep).
 * The job that runs the AI may only read the code and call the AI, and uploads the raw output only; parsing and filing
 * happen in another job on a fresh checkout, so a prompt-injected sweep cannot change the parsing script.
 */
import { appendFileSync, readFileSync } from "node:fs";

import { parseFindings, reviewInstructions, validateFindings } from "../core/findings.mjs";
import { loadPolicy } from "../core/policy.mjs";
import { areaForDate, buildSweepPrompt, findingsInArea, isDuplicate, issueFor, markersIn } from "../core/sweep.mjs";
import { createForge } from "../forge/index.mjs";
import { parseArgs, repoRoot, runIfMain } from "./args.mjs";

const USAGE = "usage: nightly-sweep.mjs prompt [--area <glob>] [--date YYYY-MM-DD] [--cli copilot|claude] | parse --area <glob> < out.txt | file-issues [--repo owner/name] --area <glob> findings.json";
const LABEL_COLOR = "d93f0b";

/** "PR" or "MR" without creating a forge (the prompt step has no token). */
const prTerm = (policy) => (policy.forge === "gitlab" ? "MR" : "PR");

/**
 * Issue calls the sweep needs. No forge method covers issues yet, so this goes through the GitHub adapter's REST client.
 * Label creation errors are ignored (it usually exists already; creating an issue with the label still works).
 */
function issueApi(forge) {
  if (forge.id !== "github") throw new Error(`nightly-sweep: filing issues on forge "${forge.id}" is not supported yet`);
  const base = `/repos/${forge.owner}/${forge.name}`;
  return {
    ensureLabel: (name, color) => forge.rest.post(`${base}/labels`, { name, color }).catch(() => {}),
    /** Every issue with the label, open and closed (a closed one means "already looked at"). */
    withLabel: (label) => forge.rest.paginate(`${base}/issues?labels=${encodeURIComponent(label)}&state=all`),
    create: (issue) => forge.rest.post(`${base}/issues`, issue),
  };
}

/**
 * File one issue per new finding; skip findings near one already filed (closed issues included) or filed earlier in
 * this run. Dedup is "read, then create", not atomic: the workflow must not run two sweeps at once.
 * @returns the number of issues created
 */
export async function fileIssues({ forge, policy, area, findings, log = console.log }) {
  const label = policy.names.sweepLabel;
  const api = issueApi(forge);
  await api.ensureLabel(label, LABEL_COLOR);
  const existing = await api.withLabel(label);
  const known = existing.flatMap((i) => markersIn(i.body, label));
  let created = 0;
  for (const f of findings) {
    if (isDuplicate(f, known, policy.sweep.dedupLines)) continue;
    known.push(f);
    await api.create(issueFor(f, area, { lang: policy.language, label, pr: forge.prTerm }));
    created++;
  }
  log(`[nightly-sweep] filed ${created} issue(s) (${findings.length - created} filed before)`);
  return created;
}

/** Tonight's area: --area, else the policy's security paths in turn by date. */
export function pickArea(args, policy, today = new Date().toISOString().slice(0, 10)) {
  let area = args.area;
  if (typeof area !== "string") {
    const date = typeof args.date === "string" ? args.date : today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`bad --date "${date}" (expected YYYY-MM-DD)`);
    area = areaForDate(policy.securityPaths, date);
  }
  if (!area) throw new Error("no sweep area: policy.securityPaths is empty; set it or pass --area <glob>");
  // The area goes into $GITHUB_OUTPUT as `area=<glob>`: a line break would let it write other outputs.
  if (/[\r\n]/.test(area)) throw new Error("bad --area: line breaks are not allowed");
  return area;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!["prompt", "parse", "file-issues"].includes(cmd)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const root = repoRoot();
  const policy = loadPolicy(root);
  const area = pickArea(args, policy);

  if (cmd === "prompt") {
    const cli = typeof args.cli === "string" ? args.cli : policy.reviewer;
    const prompt = buildSweepPrompt(reviewInstructions(root, policy), area, { lang: policy.language, cli, maxFindings: policy.sweep.maxFindings, pr: prTerm(policy) });
    process.stdout.write(prompt);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `area=${area}\n`);
    console.error(`[nightly-sweep] area: ${area}`);
    return;
  }
  if (cmd === "parse") {
    const all = validateFindings(parseFindings(readFileSync(0, "utf8")), root);
    const inArea = findingsInArea(all, area, policy.sweep.maxFindings);
    process.stdout.write(`${JSON.stringify(inArea, null, 2)}\n`);
    console.error(`[nightly-sweep] ${inArea.length} valid finding(s) (outside the area, or file/line not found: dropped)`);
    return;
  }
  const file = args._[1];
  if (!file) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const forge = createForge(policy, { repo: typeof args.repo === "string" ? args.repo : undefined });
  await fileIssues({ forge, policy, area, findings: JSON.parse(readFileSync(file, "utf8")) });
}

runIfMain(import.meta.url, "nightly-sweep", main);
