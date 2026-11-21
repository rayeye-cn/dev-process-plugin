// The machine setup's pure parts: the LaunchAgent and the machine config.
import assert from "node:assert/strict";
import { test } from "node:test";

import { LABEL, machineConfig, plistFor } from "../tools/agent-install.mjs";

test("plistFor: a LaunchAgent that runs the copied engine every N minutes, values escaped", () => {
  const p = plistFor({ node: "/usr/local/bin/node", script: "/Users/a&b/engine/cli/agent-run.mjs", config: "/Users/a&b/config.json", path: "/usr/bin:/bin", intervalMin: 15, out: "/l/o.log", err: "/l/e.log" });
  assert.match(p, new RegExp(`<key>Label</key><string>${LABEL}</string>`));
  assert.match(p, /<string>\/Users\/a&amp;b\/engine\/cli\/agent-run\.mjs<\/string>/);
  assert.match(p, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.match(p, /<key>RunAtLoad<\/key><false\/>/);
  assert.doesNotMatch(p, /\{\{/);
  assert.throws(() => plistFor({ node: "n", script: "s", config: "c", path: "p", intervalMin: 1, out: "o", err: "e" }), /interval/);
});

test("machineConfig: repos as owner/name, comment mode by default, the keychain service", () => {
  assert.deepEqual(machineConfig({ login: "dev-b", repos: ["o/r", "o/r"], claude: "/bin/claude" }), { login: "dev-b", repos: ["o/r"], mode: "comment", keychainService: "dev-process-agent-claude", claude: "/bin/claude" });
  assert.throws(() => machineConfig({ login: "dev-b", repos: ["https://github.com/o/r"] }), /repos/);
  assert.throws(() => machineConfig({ login: "dev-b", repos: ["o/r"], mode: "yolo" }), /mode/);
  assert.throws(() => machineConfig({ repos: ["o/r"] }), /login/);
});
