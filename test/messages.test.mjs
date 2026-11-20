// The message catalog: every module has the same keys in every language, and every message renders.
import assert from "node:assert/strict";
import { test } from "node:test";

import { catalogKeys, LANGUAGES, MODULES } from "../engine/core/messages/index.mjs";

test("every module has the same keys in zh and en", () => {
  for (const [name, byLang] of Object.entries(catalogKeys())) {
    assert.deepEqual(byLang.en, byLang.zh, `module ${name}`);
  }
});

test("no key is defined by two modules", () => {
  const seen = new Map();
  for (const [name, m] of Object.entries(MODULES)) {
    for (const k of Object.keys(m.zh)) {
      assert.ok(!seen.has(k), `${k} in ${name} and ${seen.get(k)}`);
      seen.set(k, name);
    }
  }
});

test("function messages render with empty params without throwing", () => {
  const h = { zh: true, list: (x = []) => x.join(), mentions: (x = []) => x.join(), join: (x = []) => x.join(), short: (s) => String(s ?? ""), tr: () => "" };
  for (const m of Object.values(MODULES)) {
    for (const lang of LANGUAGES) {
      for (const [k, v] of Object.entries(m[lang])) {
        if (typeof v !== "function") continue;
        const p = new Proxy({}, { get: (_, key) => (key === "notes" || key === "logins" || key === "paths" || key === "tags" ? [] : undefined) });
        assert.equal(typeof v(p, h), "string", `${lang}:${k}`);
      }
    }
  }
});
