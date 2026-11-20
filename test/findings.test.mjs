// The shared AI output contract (ported from the reference implementation's reviewLoop tests, "FINDING lines" and the
// mention-neutralization cases): parsing, validation, instructions, and text that is safe to post.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  asCodeBlock,
  assertCli,
  findingFormat,
  neutralizeMentions,
  parseFindings,
  reviewInstructions,
  saysNone,
  stripFrontMatter,
  validateFindings,
} from "../engine/core/findings.mjs";
import { policy } from "./helpers.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fixturePolicy = { ...policy, paths: { ...policy.paths, instructions: "ai-review/instructions.md", security: "ai-review/security.md" } };

describe("FINDING lines", () => {
  it("keeps only well-formed lines, cuts long fields, drops a ./ prefix", () => {
    const out = [
      "Let me take a look…",
      'FINDING {"file":"./src/a.ts","line":12,"title":"null deref","evidence":"x.y"}',
      'FINDING {"file":"src/b.ts","line":"abc","title":"bad line number"}',
      "FINDING not json",
      'FINDING {"file":"src/c.ts","line":3,"title":"' + "long ".repeat(60) + '"}',
      'FINDING {"file":"src/d.ts","line":0,"title":"line zero"}',
      'FINDING {"file":"","line":2,"title":"no file"}',
      'FINDING {"file":"src/e.ts","line":2}',
      "NONE",
    ].join("\n");
    const f = parseFindings(out);
    assert.deepEqual(
      f.map((x) => x.file),
      ["src/a.ts", "src/c.ts"],
    );
    assert.equal(f[1].title.length, 120);
    assert.deepEqual(f[0], { file: "src/a.ts", line: 12, title: "null deref", evidence: "x.y" });
  });

  it("collapses whitespace and caps evidence; stops at max", () => {
    const line = (i) => `FINDING {"file":"a.ts","line":${i},"title":"  two\\n lines ","evidence":"${"e ".repeat(400)}"}`;
    const f = parseFindings(Array.from({ length: 30 }, (_, i) => line(i + 1)).join("\r\n"));
    assert.equal(f.length, 20);
    assert.equal(f[0].title, "two lines");
    assert.equal(f[0].evidence.length, 500);
    assert.equal(parseFindings([line(1), line(2), line(3)].join("\n"), 2).length, 2);
  });

  it("reads Claude Code's JSON output as well as Copilot's plain text", () => {
    const text = 'checked\nFINDING {"file":"src/a.ts","line":3,"title":"t","evidence":"e"}\n';
    assert.deepEqual(parseFindings(JSON.stringify({ type: "result", result: text })), parseFindings(text));
    assert.equal(parseFindings(JSON.stringify({ type: "result", result: text })).length, 1);
    assert.equal(saysNone(JSON.stringify({ type: "result", result: "looked at everything\nNONE\n" })), true);
    assert.equal(saysNone("conclusion: NONE of these are bugs"), false);
  });

  it("validation: the file is in the repository, the line in range, and nothing escapes the root", () => {
    const ok = { file: "ai-review/instructions.md", line: 1, title: "t", evidence: "" };
    const kept = validateFindings(
      [
        ok,
        { ...ok, file: "no/such/file.ts" },
        { ...ok, line: 999_999 },
        { ...ok, file: "../helpers.mjs" },
        { ...ok, file: "ai-review/../../helpers.mjs" },
        { ...ok, file: "/etc/hosts" },
        { ...ok, file: "ai-review" },
      ],
      FIXTURES,
    );
    assert.deepEqual(kept, [ok]);
  });

  it("the prompt carries the repository's instructions (general + security), without front matter", () => {
    const text = reviewInstructions(FIXTURES, fixturePolicy);
    assert.ok(text.startsWith("# Code review instructions"));
    assert.ok(text.includes("# Security review"));
    assert.ok(!text.includes("applyTo:"));
    assert.ok(!text.includes("description:"));
    assert.ok(!text.includes("---"));
    assert.equal(stripFrontMatter("no front matter\n---\nkept"), "no front matter\n---\nkept");
    assert.equal(stripFrontMatter("---\r\napplyTo: x\r\n---\r\nbody"), "body");
  });

  it("the format instruction is in the project language; the tokens are not translated", () => {
    const zh = findingFormat("zh");
    const en = findingFormat("en");
    assert.ok(zh.includes("一句话中文标题"));
    assert.ok(en.includes("one-line title in English"));
    for (const text of [zh, en]) {
      assert.ok(text.includes('FINDING {"file":'));
      assert.ok(text.includes('"line":'));
      assert.ok(text.includes('"evidence":'));
      assert.ok(text.trimEnd().endsWith("NONE"));
    }
  });

  it("only known AI CLIs", () => {
    assert.equal(assertCli("copilot"), "copilot");
    assert.equal(assertCli("claude"), "claude");
    assert.throws(() => assertCli("gpt"), /unknown AI CLI "gpt"/);
  });
});

describe("model text posted to the forge: no mentions, no references, no breaking out of the code block", () => {
  /** What GitHub treats as a mention or a numbered reference: `@` / `#` right before a letter or digit (not after one). */
  const MENTION = /(^|[^A-Za-z0-9])@[A-Za-z0-9]/;
  const REF = /(^|[^A-Za-z0-9&])#[0-9]/;

  it("plain text such as titles: breaks @user, @org/team, a leading @ and #number; without the zero-width spaces it is the original", () => {
    const raw = "@someone please look; cc @another-user and @some-org/team, regression of #126 and x/y#1, a lone @ and # stay";
    const out = neutralizeMentions(raw);
    assert.equal(MENTION.test(out), false);
    assert.equal(REF.test(out), false);
    assert.equal(out.replaceAll("​", ""), raw);
    assert.ok(out.includes("a lone @ and # stay"));
  });

  it("the fence is longer than the longest backtick run in the text, so the text cannot break out", () => {
    assert.equal(asCodeBlock("a ``` b"), "````text\na ``` b\n````");
    assert.equal(asCodeBlock("plain"), "```text\nplain\n```");
    assert.equal(asCodeBlock("````` x"), "``````text\n````` x\n``````");
  });
});
