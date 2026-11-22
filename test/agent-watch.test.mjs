// The watch trigger: conditional polls of the ready list start a run when it changes, plus a fallback full run.
import assert from "node:assert/strict";
import { test } from "node:test";

import { MIN_POLL_SEC, pollRepos, shouldRun } from "../engine/cli/agent-watch.mjs";

test("pollRepos: a 304 changes nothing; a new ETag marks the repository changed; GitHub's poll interval is honoured", async () => {
  const calls = [];
  const answers = { "o/a": { status: 304, etag: null, pollInterval: "60" }, "o/b": { status: 200, etag: 'W/"2"', pollInterval: "90" } };
  const request = async (url, etag) => {
    calls.push([url, etag]);
    return answers[url.split("/").slice(2, 4).join("/")];
  };
  const r = await pollRepos({ repos: ["o/a", "o/b"], etags: { "o/a": 'W/"1"', "o/b": 'W/"1"' }, request });
  assert.deepEqual(r.changed, ["o/b"]);
  assert.deepEqual(r.etags, { "o/a": 'W/"1"', "o/b": 'W/"2"' });
  assert.equal(r.pollSec, 90);
  assert.match(calls[0][0], /^\/repos\/o\/a\/issues\?state=open&labels=agent%3Aready/);
  assert.equal(calls[0][1], 'W/"1"', "conditional request with the last ETag");
});

test("pollRepos: the first poll (no ETag yet) counts as a change; a failing repository is skipped", async () => {
  const request = async (url) => {
    if (url.includes("/o/bad/")) throw new Error("network");
    return { status: 200, etag: 'W/"1"' };
  };
  const r = await pollRepos({ repos: ["o/a", "o/bad"], etags: {}, request });
  assert.deepEqual(r.changed, ["o/a"]);
  assert.equal(r.pollSec, MIN_POLL_SEC);
});

test("shouldRun: on a change at once, otherwise when the fallback run is due", () => {
  const now = 10 * 3600_000;
  assert.deepEqual(shouldRun({ changed: ["o/a"], lastRunAt: now, now }), { run: true, why: "changed: o/a" });
  assert.equal(shouldRun({ changed: [], lastRunAt: now - 5 * 60_000, now, fallbackMin: 30 }).run, false);
  assert.equal(shouldRun({ changed: [], lastRunAt: now - 30 * 60_000, now, fallbackMin: 30 }).why, "fallback");
});
