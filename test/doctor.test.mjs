// doctor: local findings on a rendered-looking repository, remote findings against a fake forge.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { expectedWorkflows, localFindings, remoteFindings } from "../engine/cli/doctor.mjs";
import { globToCodeowners } from "../engine/core/consistency.mjs";
import { tr } from "../engine/core/messages/index.mjs";
import { withDefaults } from "../engine/core/policy.mjs";
import { requiredContexts, RULESET_NAME } from "../engine/core/protection.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const policy = withDefaults({ trustedAuthors: ["alice", "bob"], highPaths: [".github/**", "CLAUDE.md", ".dev-process/**"], securityPaths: [".github/**"], reviewer: "claude" });

function repo(over = {}) {
  const d = mkdtempSync(join(tmpdir(), "dp-doctor-"));
  dirs.push(d);
  const files = {
    ".github/CODEOWNERS": policy.highPaths.map((g) => `${globToCodeowners(g)} @alice @bob`).join("\n"),
    "CLAUDE.md": "`/signoff <head sha>` `/waive-ai-review <head sha>`",
    ".dev-process/VERSION": "0.1.0\n",
    ".dev-process/engine/core/x.mjs": "export const x = 1;\n",
    ...Object.fromEntries(expectedWorkflows(policy).map((w) => [`.github/workflows/${w}`, "name: x\n"])),
    ...over,
  };
  files[".dev-process/render-lock.json"] ??= JSON.stringify({ files: { ".dev-process/engine/core/x.mjs": sha("export const x = 1;\n") } });
  for (const [p, c] of Object.entries(files)) {
    if (c === null) continue;
    mkdirSync(join(d, p, ".."), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["add", "-A"], { cwd: d });
  return d;
}
const codes = (fs) => fs.map((x) => x.code).sort();

describe("local", () => {
  it("a consistent install has no findings", () => {
    assert.deepEqual(localFindings(repo(), policy), []);
  });

  it("missing workflows, a hand-edited engine and a leftover queue workflow are reported", () => {
    const d = repo({ ".github/workflows/merge-queue.yml": null, ".dev-process/engine/core/x.mjs": "export const x = 2;\n" });
    assert.deepEqual(codes(localFindings(d, policy)), ["doctor.engineEdited", "doctor.workflowMissing"]);
    const native = withDefaults({ ...policy, queue: { mode: "native" } });
    assert.deepEqual(codes(localFindings(repo(), native)), ["doctor.workflowExtra"]);
  });
});

describe("remote", () => {
  const forge = (rulesets, ruleset, secret = 200) => ({
    owner: "o",
    name: "r",
    repo: "o/r",
    prTerm: "PR",
    rest: {
      get: async (u) => {
        if (u.endsWith("rulesets?includes_parents=false")) return rulesets;
        if (u.includes("/rulesets/")) return ruleset;
        if (u.includes("/actions/secrets/")) {
          if (secret === 200) return {};
          throw Object.assign(new Error("x"), { status: secret });
        }
        throw new Error(`unexpected ${u}`);
      },
    },
  });
  const active = { enforcement: "active", rules: [{ type: "required_status_checks", parameters: { required_status_checks: requiredContexts(policy).map((context) => ({ context })) } }] };

  it("an active ruleset with the right checks and the secret ⇒ nothing", async () => {
    assert.deepEqual(await remoteFindings(forge([{ id: 1, name: RULESET_NAME }], active), policy), []);
  });

  it("no ruleset is a warning (protection comes last); drift and a missing key are errors; 403 cannot be checked", async () => {
    assert.deepEqual(codes(await remoteFindings(forge([], null), policy)), ["doctor.rulesetMissing"]);
    const drift = { ...active, rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "checks" }] } }] };
    assert.deepEqual(codes(await remoteFindings(forge([{ id: 1, name: RULESET_NAME }], drift, 404), policy)), ["doctor.rulesetChecks", "doctor.secretMissing"]);
    const r = await remoteFindings(forge([{ id: 1, name: RULESET_NAME }], { ...active, enforcement: "disabled" }, 403), policy);
    assert.deepEqual(codes(r), ["doctor.rulesetDisabled", "doctor.secretUnknown"]);
    for (const x of r) for (const lang of ["zh", "en"]) assert.equal(typeof tr(lang, x), "string");
  });
});
