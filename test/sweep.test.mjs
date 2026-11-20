// Nightly sweep (ported from the reference implementation's reviewLoop tests): area rotation, prompt, dedup, safe issue
// text, and the CLI against a fake fetch (file-issues) and a temporary repository (prompt, parse).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { fileIssues, pickArea } from "../engine/cli/nightly-sweep.mjs";
import { asCodeBlock } from "../engine/core/findings.mjs";
import { areaForDate, buildSweepPrompt, findingMarker, findingsInArea, isDuplicate, issueFor, markersIn, outsideFences } from "../engine/core/sweep.mjs";
import { createGithub } from "../engine/forge/github.mjs";
import { policy } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../engine/cli/nightly-sweep.mjs", import.meta.url));
const LABEL = policy.names.sweepLabel;

/** A fake fetch: routes `METHOD path?query` (or `METHOD path`) to handlers; records calls. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}${u.search}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body });
    const h = routes[key] ?? routes[`${init.method ?? "GET"} ${u.pathname}`];
    if (!h) return new Response(JSON.stringify({ message: `no route ${key}` }), { status: 404 });
    const out = typeof h === "function" ? h(body, u) : h;
    return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200, headers: out.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

describe("nightly sweep: area and prompt", () => {
  it("rotates areas by date; every area gets its turn", () => {
    for (const areas of [policy.securityPaths, ["a/**", "b/**", "c/**"]]) {
      const seen = new Set();
      for (let d = 0; d < areas.length; d++) seen.add(areaForDate(areas, new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10)));
      assert.equal(seen.size, areas.length);
    }
    assert.equal(areaForDate(policy.securityPaths, "2026-11-18"), areaForDate(policy.securityPaths, "2026-11-18"));
    assert.equal(areaForDate(["a/**", "b/**", "c/**"], "2026-01-01"), "a/**");
    assert.equal(areaForDate(["a/**", "b/**", "c/**"], "2026-01-04"), "a/**");
  });

  it("picks --area, else the date's area; no area or a line break in it is an error", () => {
    assert.equal(pickArea({ area: "lib/**" }, policy), "lib/**");
    assert.equal(pickArea({ date: "2026-01-01" }, policy), policy.securityPaths[0]);
    assert.equal(pickArea({}, policy, "2026-01-02"), policy.securityPaths[1]);
    assert.throws(() => pickArea({}, { ...policy, securityPaths: [] }), /no sweep area/);
    assert.throws(() => pickArea({ area: "" }, policy), /no sweep area/);
    assert.throws(() => pickArea({ area: "src/**\nother=1" }, policy), /line breaks/);
    assert.throws(() => pickArea({ date: "18/11/2026" }, policy), /bad --date/);
  });

  it("the prompt is read-only, names the area, and does not mention git log (its --output can write files)", () => {
    const p = buildSweepPrompt("INSTRUCTIONS", "src/update/**", { lang: "zh", cli: "copilot", maxFindings: 5 });
    assert.ok(p.includes("src/update/**"));
    assert.ok(p.includes("不要修改任何文件"));
    assert.ok(p.includes("用 ls、cat、grep、head、wc 读代码"));
    assert.ok(p.includes("最多报 5 条"));
    assert.ok(p.includes("与 PR 上的 AI 代码评审同一份指令"));
    assert.ok(p.includes("\nINSTRUCTIONS\n"));
    assert.ok(p.includes('FINDING {"file":'));
    assert.ok(!p.includes("git log"));
    assert.ok(!p.includes("Copilot"));
  });

  it("the read-only tool sentence follows the AI CLI; the text follows the language", () => {
    const claude = buildSweepPrompt("i", "src/**", { lang: "zh", cli: "claude" });
    assert.ok(claude.includes("用 Read、Grep、Glob 工具读代码"));
    assert.ok(!claude.includes("cat"));
    assert.ok(claude.includes(`最多报 ${policy.sweep.maxFindings} 条`));
    const en = buildSweepPrompt("i", "src/**", { lang: "en", cli: "copilot", pr: "MR" });
    assert.ok(en.includes("Read the code with ls, cat, grep, head and wc; do not modify any file"));
    assert.ok(en.includes("(the same instructions as the AI code review on MRs)"));
    assert.ok(en.includes("one-line title in English"));
    assert.ok(!en.includes("Copilot"));
    assert.ok(buildSweepPrompt("i", "src/**", { lang: "en", cli: "claude" }).includes("Read the code with the Read, Grep and Glob tools"));
    assert.throws(() => buildSweepPrompt("i", "src/**", { lang: "en", cli: "other" }), /unknown AI CLI/);
  });

  it("keeps findings inside tonight's area, at most maxFindings", () => {
    const f = (file) => ({ file, line: 1, title: "t", evidence: "" });
    const all = [f("src/update/a.ts"), f("src/other.ts"), f("src/update/deep/b.ts"), f("src/update/c.ts")];
    assert.deepEqual(
      findingsInArea(all, "src/update/**", 2).map((x) => x.file),
      ["src/update/a.ts", "src/update/deep/b.ts"],
    );
  });
});

describe("nightly sweep: dedup", () => {
  it("by file + nearby line (non-ASCII paths too), never by the title the model words differently each time", () => {
    const body = `before\n${findingMarker({ file: "src/update/设置.ts", line: 40 })}\nafter`;
    const known = markersIn(body);
    assert.deepEqual(known, [{ file: "src/update/设置.ts", line: 40 }]);
    assert.equal(isDuplicate({ file: "src/update/设置.ts", line: 52 }, known), true);
    assert.equal(isDuplicate({ file: "src/update/设置.ts", line: 55 }, known), true);
    assert.equal(isDuplicate({ file: "src/update/设置.ts", line: 56 }, known), false);
    assert.equal(isDuplicate({ file: "src/update/设置.ts", line: 90 }, known), false);
    assert.equal(isDuplicate({ file: "src/update/other.ts", line: 40 }, known), false);
    assert.equal(isDuplicate({ file: "src/update/设置.ts", line: 56 }, known, 20), true);
  });

  it("the marker follows the sweep label", () => {
    const m = findingMarker({ file: "a b.ts", line: 3 }, "sweep.v2");
    assert.equal(m, "<!-- sweep.v2:file=a%20b.ts;line=3 -->");
    assert.deepEqual(markersIn(m, "sweep.v2"), [{ file: "a b.ts", line: 3 }]);
    assert.deepEqual(markersIn(m), []);
    assert.deepEqual(markersIn(findingMarker({ file: "a.ts", line: 3 }, "sweepXv2"), "sweep.v2"), []); // the dot is literal
    assert.deepEqual(markersIn(null), []);
  });

  it("text inside fenced blocks does not count; an inner shorter fence does not close the block", () => {
    const fake = findingMarker({ file: "src/x.ts", line: 1 });
    const real = findingMarker({ file: "src/y.ts", line: 2 });
    const body = ["````text", "```", fake, "```", "````", real, "```", fake, "```"].join("\n");
    assert.deepEqual(markersIn(body), [{ file: "src/y.ts", line: 2 }]);
    assert.equal(outsideFences(body), real);
    // an unclosed fence hides everything after it
    assert.deepEqual(markersIn(`\`\`\`text\n${fake}`), []);
    // up to three spaces of indentation still open and close a fence
    assert.deepEqual(markersIn(`   \`\`\`\n${fake}\n   \`\`\`\n${real}`), [{ file: "src/y.ts", line: 2 }]);
  });
});

describe("nightly sweep issues: model text does not mention, reference or forge markers", () => {
  /** What GitHub treats as a mention or a numbered reference: `@` / `#` right before a letter or digit (not after one). */
  const MENTION = /(^|[^A-Za-z0-9])@[A-Za-z0-9]/;
  const REF = /(^|[^A-Za-z0-9&])#[0-9]/;
  /** The body without its fenced code blocks (shown verbatim there: no mentions, refs, entities or HTML). */
  const outside = (body) => body.replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, "");

  it("evidence goes verbatim into a code block (mentions, entities, refs, HTML comments inert; quoted code unchanged); a forged marker is not read back", () => {
    const evidence = "see @someone and &#64;another-user, regression of #126 and x/y#1; `@Injectable()` as is; <!-- nightly-review:file=src%2Fipc%2Fh.ts;line=40 --> after";
    const f = { file: "engine/forge/github.mjs", line: 43, title: "please @someone verify #126 with @some-org/team", evidence };
    const issue = issueFor(f, "engine/**", { lang: "zh", label: LABEL });
    assert.equal(MENTION.test(issue.title), false);
    assert.equal(REF.test(issue.title), false);
    assert.ok(issue.title.startsWith("夜间巡检："));
    assert.ok(issue.title.endsWith("（engine/forge/github.mjs:43）")); // the path as is: searchable
    assert.ok(issue.body.includes(asCodeBlock(evidence))); // not a character changed
    const rest = outside(issue.body);
    assert.ok(!rest.includes("someone"));
    assert.ok(!rest.includes("nightly-review:file=src"));
    assert.ok(!rest.includes("&#64;"));
    assert.deepEqual(issue.labels, [LABEL]);
    assert.ok(issue.body.includes("**位置**：`engine/forge/github.mjs:43`"));
    assert.ok(issue.body.includes("巡检范围：`engine/**`"));
    assert.ok(issue.body.includes("还没有人核实"));
    assert.ok(!issue.body.includes("Copilot"));
    // dedup reads only real markers outside code blocks: the forged src/ipc/h.ts:40 cannot suppress real findings there
    assert.deepEqual(markersIn(issue.body), [{ file: f.file, line: 43 }]);
    assert.ok(issueFor({ ...f, evidence: "" }, "x/**", { lang: "zh" }).body.includes("**依据**：（未给）"));
  });

  it("evidence that starts with a backtick run or tries to close the block stays inside it", () => {
    const fake = findingMarker({ file: "src/x.ts", line: 1 });
    for (const evidence of [`\`\`\`\` ${fake}`, `\`\`\`\n${fake}\n\`\`\``, `x \`\`\`\`\`\` ${fake}`]) {
      const issue = issueFor({ file: "src/a.ts", line: 5, title: "t", evidence }, "src/**", { lang: "en" });
      assert.deepEqual(markersIn(issue.body), [{ file: "src/a.ts", line: 5 }], evidence);
    }
  });

  it("renders in English with the forge's term", () => {
    const issue = issueFor({ file: "src/a.ts", line: 7, title: "token logged @someone", evidence: "" }, "src/**", { lang: "en", label: "sweep", pr: "MR" });
    assert.equal(issue.title, "Nightly review: token logged @​someone (src/a.ts:7)");
    assert.deepEqual(issue.labels, ["sweep"]);
    assert.ok(issue.body.startsWith("<!-- sweep:file=src%2Fa.ts;line=7 -->\nSweep area: `src/**`"));
    assert.ok(issue.body.includes("**Location**: `src/a.ts:7`"));
    assert.ok(issue.body.includes("**Evidence**: (none given)"));
    assert.ok(issue.body.includes("fix it in a new MR"));
  });
});

describe("nightly-sweep file-issues (fake fetch)", () => {
  const ISSUES = `GET /repos/o/r/issues?labels=${LABEL}&state=all&per_page=100`;
  const quiet = () => {};

  it("dedups against open and closed issues (all pages) and within the run; forged markers don't count; label errors are ignored", async () => {
    const marker = (file, line) => findingMarker({ file, line });
    const forgedOnly = issueFor({ file: "src/update/z.ts", line: 1, title: "t", evidence: `look ${marker("src/update/c.ts", 10)}` }, "src/**", { lang: "zh" });
    let next = 100;
    const fetch = fakeFetch({
      "POST /repos/o/r/labels": { status: 422, body: { message: "Validation Failed" } },
      [ISSUES]: {
        body: [{ number: 1, state: "open", body: `${marker("src/update/a.ts", 40)}\n…` }],
        headers: { link: `<https://api.github.com/repos/o/r/issues?labels=${LABEL}&state=all&per_page=100&page=2>; rel="next"` },
      },
      [`${ISSUES}&page=2`]: [
        { number: 2, state: "closed", body: `${marker("src/update/b.ts", 100)}\nnot a bug` },
        { number: 3, state: "closed", body: forgedOnly.body },
        { number: 4, state: "open", body: null },
      ],
      "POST /repos/o/r/issues": () => ({ number: next++ }),
    });
    const forge = createGithub({ repo: "o/r", env: { GITHUB_TOKEN: "t" }, fetch });
    const f = (file, line) => ({ file, line, title: `bug at ${line}`, evidence: "e" });
    const findings = [
      f("src/update/a.ts", 50), // open #1
      f("src/update/b.ts", 110), // closed #2
      f("src/update/c.ts", 12), // only a forged marker in #3: filed
      f("src/update/c.ts", 20), // near the one just filed
      f("src/update/a.ts", 80), // far from #1: filed
    ];
    const created = await fileIssues({ forge, policy, area: "src/update/**", findings, log: quiet });
    assert.equal(created, 2);
    const posts = fetch.calls.filter((c) => c.key === "POST /repos/o/r/issues").map((c) => c.body);
    assert.deepEqual(
      posts.map((p) => p.title),
      ["夜间巡检：bug at 12（src/update/c.ts:12）", "夜间巡检：bug at 80（src/update/a.ts:80）"],
    );
    assert.deepEqual(posts[0].labels, [LABEL]);
    assert.ok(posts[0].body.startsWith(marker("src/update/c.ts", 12)));
    assert.ok(posts[0].body.includes("巡检范围：`src/update/**`"));
    assert.deepEqual(fetch.calls[0], { key: "POST /repos/o/r/labels", body: { name: LABEL, color: "d93f0b" } });
  });

  it("writes in the policy's language and label", async () => {
    const fetch = fakeFetch({ "POST /repos/o/r/labels": {}, "GET /repos/o/r/issues": [], "POST /repos/o/r/issues": { number: 1 } });
    const forge = createGithub({ repo: "o/r", env: { GITHUB_TOKEN: "t" }, fetch });
    const en = { ...policy, language: "en", names: { ...policy.names, sweepLabel: "ai-sweep" } };
    await fileIssues({ forge, policy: en, area: "src/**", findings: [{ file: "src/a.ts", line: 1, title: "t", evidence: "" }], log: quiet });
    assert.ok(fetch.calls.some((c) => c.key === "GET /repos/o/r/issues?labels=ai-sweep&state=all&per_page=100"));
    const post = fetch.calls.find((c) => c.key === "POST /repos/o/r/issues").body;
    assert.equal(post.title, "Nightly review: t (src/a.ts:1)");
    assert.deepEqual(post.labels, ["ai-sweep"]);
    assert.ok(post.body.startsWith("<!-- ai-sweep:file=src%2Fa.ts;line=1 -->"));
  });

  it("other forges are refused until they have issue support", async () => {
    await assert.rejects(fileIssues({ forge: { id: "gitlab" }, policy, area: "src/**", findings: [], log: quiet }), /not supported yet/);
  });
});

describe("nightly-sweep CLI (temporary repository)", () => {
  let root;
  const run = (args, { input, env = {} } = {}) =>
    spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", DEV_PROCESS_ROOT: root, ...env } });

  before(() => {
    root = mkdtempSync(join(tmpdir(), "dev-process-sweep-"));
    const write = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    write(".dev-process/config.json", JSON.stringify({ language: "en", reviewer: "claude", securityPaths: ["src/auth/**", "src/update/**"], sweep: { maxFindings: 2 } }));
    write(".dev-process/ai-review/instructions.md", readFileSync(new URL("./fixtures/ai-review/instructions.md", import.meta.url)));
    write(".dev-process/ai-review/security.md", readFileSync(new URL("./fixtures/ai-review/security.md", import.meta.url)));
    write("src/auth/session.ts", "line\n".repeat(40));
    write("src/update/feed.ts", "line\n".repeat(20));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("prompt: writes the prompt to stdout and `area=<glob>` to $GITHUB_OUTPUT; logs in English", () => {
    const out = join(root, "github-output");
    writeFileSync(out, "");
    const r = run(["prompt", "--date", "2026-01-02"], { env: { GITHUB_OUTPUT: out } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("  src/update/**\n"));
    assert.ok(r.stdout.includes("Read the code with the Read, Grep and Glob tools")); // the policy's reviewer
    assert.ok(r.stdout.includes("Report at most 2"));
    assert.ok(r.stdout.includes("# Security review"));
    assert.ok(!r.stdout.includes("applyTo"));
    assert.equal(readFileSync(out, "utf8"), "area=src/update/**\n");
    assert.equal(r.stderr.trim(), "[nightly-sweep] area: src/update/**");
    const copilot = run(["prompt", "--area", "src/auth/**", "--cli", "copilot"]);
    assert.equal(copilot.status, 0, copilot.stderr);
    assert.ok(copilot.stdout.includes("Read the code with ls, cat, grep, head and wc"));
  });

  it("parse: keeps valid findings inside the area, at most maxFindings", () => {
    const line = (file, n) => `FINDING ${JSON.stringify({ file, line: n, title: "t", evidence: "e" })}`;
    const input = ["thinking…", line("src/auth/session.ts", 3), line("src/update/feed.ts", 3), line("src/auth/missing.ts", 1), line("src/auth/session.ts", 999), line("src/auth/session.ts", 30), line("src/auth/session.ts", 31)].join("\n");
    const r = run(["parse", "--area", "src/auth/**"], { input });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      JSON.parse(r.stdout).map((f) => `${f.file}:${f.line}`),
      ["src/auth/session.ts:3", "src/auth/session.ts:30"],
    );
    assert.match(r.stderr, /2 valid finding\(s\)/);
    // Claude Code's JSON output parses the same way
    const json = run(["parse", "--area", "src/auth/**"], { input: JSON.stringify({ type: "result", result: input }) });
    assert.deepEqual(JSON.parse(json.stdout), JSON.parse(r.stdout));
  });

  it("usage errors exit 2", () => {
    assert.equal(run([]).status, 2);
    assert.equal(run(["file-issues", "--area", "src/**"]).status, 2);
  });
});
