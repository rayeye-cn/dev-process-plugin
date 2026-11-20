import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderTemplate as r } from "../tools/template.mjs";

describe("template engine", () => {
  it("values, dotted paths, and GitHub expressions left alone", () => {
    assert.equal(r("a {{ x }} b {{ p.q }}", { x: 1, p: { q: "z" } }), "a 1 b z");
    assert.equal(r("if: ${{ github.event_name == 'push' }} and {{ x }}", { x: "y" }), "if: ${{ github.event_name == 'push' }} and y");
    assert.throws(() => r("{{ nope }}", {}), /missing value "nope"/);
  });

  it("if / unless / else / eq", () => {
    assert.equal(r("{{#if a}}A{{else}}B{{/if}}", { a: true }), "A");
    assert.equal(r("{{#if a}}A{{else}}B{{/if}}", { a: [] }), "B");
    assert.equal(r("{{#unless a}}U{{/unless}}", { a: "" }), "U");
    assert.equal(r('{{#eq lang "zh"}}中{{else}}en{{/eq}}', { lang: "zh" }), "中");
  });

  it("each with this, index, first/last, and an else for empty lists", () => {
    assert.equal(r("{{#each xs}}{{ @index }}={{ this }}{{#unless @last}},{{/unless}}{{/each}}", { xs: ["a", "b"] }), "0=a,1=b");
    assert.equal(r("{{#each xs}}{{ this.n }}{{/each}}", { xs: [{ n: 1 }, { n: 2 }] }), "12");
    assert.equal(r("{{#each xs}}x{{else}}none{{/each}}", { xs: [] }), "none");
  });

  it("a block tag alone on its line takes the line with it (indentation stays natural)", () => {
    const src = ["steps:", "  {{#if a}}", "  - run: a", "  {{/if}}", "  {{#each xs}}", "  - run: {{ this }}", "  {{/each}}", "end", ""].join("\n");
    assert.equal(r(src, { a: true, xs: ["b", "c"] }), "steps:\n  - run: a\n  - run: b\n  - run: c\nend\n");
    assert.equal(r(src, { a: false, xs: [] }), "steps:\nend\n");
  });

  it("comments vanish; structural errors are reported", () => {
    assert.equal(r("a{{! note }}b", {}), "ab");
    assert.throws(() => r("{{#if a}}x", { a: 1 }), /unclosed/);
    assert.throws(() => r("x{{/if}}", {}), /unexpected/);
    assert.throws(() => r("{{#each a}}x{{/each}}", { a: 1 }), /not a list/);
  });
});
