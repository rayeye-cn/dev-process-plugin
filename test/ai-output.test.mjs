import assert from "node:assert/strict";
import { test } from "node:test";

import { extractText } from "../engine/core/ai-output.mjs";

test("plain text passes through; Claude JSON yields result or structured_output", () => {
  assert.equal(extractText("TIER: high\nREASON: x"), "TIER: high\nREASON: x");
  assert.equal(extractText(JSON.stringify({ type: "result", result: "TIER: low" })), "TIER: low");
  assert.equal(extractText(JSON.stringify({ structured_output: { tier: "high" } })), '{"tier":"high"}');
  assert.equal(extractText("{not json"), "{not json");
  assert.equal(extractText(undefined), "");
});
