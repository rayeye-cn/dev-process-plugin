// The role agent's self-upgrade: finding a newer copy of the plugin next to the one setup ran from.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findNewerPlugin, upgradeLocked, versionGreater } from "../engine/cli/agent-upgrade.mjs";

const plugin = (dir, version, { name = "dev-process", installer = true } = {}) => {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version }));
  if (installer) {
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "tools", "agent-install.mjs"), "");
  }
};

test("versionGreater", () => {
  assert.equal(versionGreater("1.1.3", "1.1.2"), true);
  assert.equal(versionGreater("1.2.0", "1.10.0"), false);
  assert.equal(versionGreater("1.1.2", "1.1.2"), false);
  assert.equal(versionGreater("2.0.0-beta", "1.9.9"), true);
});

test("organization-library generations side by side: the newest newer copy wins", () => {
  const d = mkdtempSync(join(tmpdir(), "synced-"));
  plugin(join(d, "dev-process"), "1.0.0");
  plugin(join(d, "dev-process~g2"), "1.1.2");
  plugin(join(d, "dev-process~g3"), "1.1.3");
  plugin(join(d, "other-plugin"), "9.9.9", { name: "other" });
  plugin(join(d, "dev-process~g4"), "1.2.0", { installer: false }); // no installer: not usable
  const n = findNewerPlugin(join(d, "dev-process~g2"), "1.1.2");
  assert.equal(n.version, "1.1.3");
  assert.match(n.root, /dev-process~g3$/);
  assert.equal(findNewerPlugin(join(d, "dev-process~g3"), "1.1.3"), null);
});

test("marketplace versions side by side, and a checkout that changed in place", () => {
  const d = mkdtempSync(join(tmpdir(), "cache-"));
  plugin(join(d, "1.1.2"), "1.1.2");
  plugin(join(d, "1.1.3"), "1.1.3");
  assert.equal(findNewerPlugin(join(d, "1.1.2"), "1.1.2").version, "1.1.3");
  const repo = mkdtempSync(join(tmpdir(), "checkout-"));
  plugin(repo, "1.1.3");
  assert.equal(findNewerPlugin(repo, "1.1.2").root, repo);
  assert.equal(findNewerPlugin(null, "1.1.2"), null);
});

test("upgradeLocked: a fresh lock blocks a second upgrade, an old one does not", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  assert.equal(upgradeLocked(home), false);
  writeFileSync(join(home, "upgrade.lock"), String(Date.now() - 60_000));
  assert.equal(upgradeLocked(home), true);
  writeFileSync(join(home, "upgrade.lock"), String(Date.now() - 11 * 60_000));
  assert.equal(upgradeLocked(home), false);
});
