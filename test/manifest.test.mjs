// Manifest sanity: the plugin and its marketplace entry agree, and the names avoid reserved prefixes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const plugin = read(".claude-plugin/plugin.json");
const market = read(".claude-plugin/marketplace.json");

test("plugin name is kebab-case and not reserved", () => {
  assert.match(plugin.name, /^[a-z][a-z0-9-]*$/);
  assert.doesNotMatch(plugin.name, /^(claude|anthropic|anthropics|cc-plugin)-/);
});

test("plugin version is semver", () => {
  assert.match(plugin.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test("the marketplace lists this plugin from the repository root", () => {
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, "marketplace entry missing");
  assert.equal(entry.source, "./");
  assert.doesNotMatch(market.name, /^(claude-plugins-official|claude-code-plugins|claudeai-)/);
});

test("SKILL.md bodies contain no `$` except ${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_SKILL_DIR} (skills substitute $0, $ARGUMENTS, $name)", async () => {
  const { readdirSync } = await import("node:fs");
  for (const skill of readdirSync(new URL("../skills/", import.meta.url))) {
    const text = readFileSync(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), "utf8");
    const stray = text.replace(/\$\{CLAUDE_(PLUGIN_ROOT|SKILL_DIR)\}/g, "").match(/.{0,30}\$.{0,30}/g);
    assert.equal(stray, null, `${skill}: ${stray}`);
  }
});
