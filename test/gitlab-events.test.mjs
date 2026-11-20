// GitLab webhook events → the process's tasks. Payload shapes follow GitLab's webhook docs; M6 records real ones.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { eventTasks } from "../engine/core/gitlab-events.mjs";

const BOT = "project_42_bot_0123abcd";
const SHA = "b".repeat(40);
const mrEvent = (attrs = {}, changes = {}, user = "alice") => ({
  object_kind: "merge_request",
  user: { username: user },
  object_attributes: { iid: 7, action: "update", state: "opened", draft: false, last_commit: { id: SHA }, updated_at: "2026-11-20 12:00:00 UTC", ...attrs },
  changes,
});
const tasks = (p) => eventTasks(p, { bot: BOT, queueLabel: "merge-queue" }).tasks;

describe("GitLab events", () => {
  it("opened / reopened / a push / ready / retarget ⇒ gate + review; a title edit ⇒ gate only", () => {
    assert.deepEqual(tasks(mrEvent({ action: "open" })), ["gate", "review"]);
    assert.deepEqual(tasks(mrEvent({ action: "reopen" })), ["gate", "review"]);
    assert.deepEqual(tasks(mrEvent({ oldrev: "a".repeat(40) })), ["gate", "review"]);
    assert.deepEqual(tasks(mrEvent({}, { draft: { previous: true, current: false } })), ["gate", "review"]);
    assert.deepEqual(tasks(mrEvent({}, { title: { previous: "a", current: "b" } })), ["gate"]);
  });

  it("a retarget carries its time for the gate (reviews and sign-offs before it are void)", () => {
    const e = eventTasks(mrEvent({}, { target_branch: { previous: "dev", current: "main" } }), { bot: BOT });
    assert.deepEqual(e.tasks, ["gate", "review"]);
    assert.equal(e.baseChangedAt, "2026-11-20T12:00:00.000Z");
    assert.equal(e.mr, 7);
    assert.equal(e.head, SHA);
  });

  it("drafts are judged but not reviewed; closed MRs are left alone; a merge wakes the queue", () => {
    assert.deepEqual(tasks(mrEvent({ action: "open", draft: true })), ["gate"]);
    assert.deepEqual(tasks(mrEvent({ state: "closed", action: "close" })), []);
    assert.deepEqual(tasks(mrEvent({ action: "merge", state: "merged" })), ["queue"]);
  });

  it("approvals and the queue label", () => {
    assert.deepEqual(tasks(mrEvent({ action: "approved" })), ["gate"]);
    assert.deepEqual(tasks(mrEvent({ action: "unapproved" })), ["gate"]);
    assert.deepEqual(tasks(mrEvent({}, { labels: { previous: [], current: [{ title: "merge-queue" }] } })), ["gate", "queue"]);
    assert.deepEqual(tasks(mrEvent({}, { labels: { previous: [{ title: "merge-queue" }], current: [{ title: "merge-queue" }, { title: "x" }] } })), ["gate"]);
  });

  it("comments on MRs re-judge; the bot's own notes and events never trigger anything", () => {
    const note = (user, type = "MergeRequest") => ({ object_kind: "note", user: { username: user }, object_attributes: { noteable_type: type, note: "/signoff abc" }, merge_request: { iid: 7, state: "opened", last_commit: { id: SHA } } });
    assert.deepEqual(tasks(note("alice")), ["gate"]);
    assert.deepEqual(tasks(note(BOT)), []);
    assert.deepEqual(tasks(note("alice", "Issue")), []);
    assert.deepEqual(tasks(mrEvent({ action: "approved" }, {}, BOT)), []);
  });

  it("a finished MR pipeline wakes only the queue (never the gate: no loop through its own statuses); other pipelines and running ones do nothing", () => {
    const pipe = (status, source = "merge_request_event") => ({ object_kind: "pipeline", user: { username: "alice" }, object_attributes: { id: 5, status, sha: SHA, source }, merge_request: { iid: 7 } });
    assert.deepEqual(tasks(pipe("success")), ["queue"]);
    assert.deepEqual(tasks(pipe("failed")), ["queue"]);
    assert.deepEqual(tasks(pipe("running")), []);
    assert.deepEqual(tasks(pipe("failed", "external")), [], "the gate's own statuses live on an external pipeline");
    assert.deepEqual(tasks(pipe("success", "push")), []);
    assert.deepEqual(tasks({ object_kind: "push" }), []);
    assert.deepEqual(tasks(null), []);
  });
});
