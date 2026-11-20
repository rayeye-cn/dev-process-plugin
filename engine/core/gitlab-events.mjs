/**
 * GitLab: which of the process's tasks an event calls for (pure). GitLab CI has no trigger for comments or approvals, so
 * a project webhook sends merge request, comment and pipeline events to the pipeline trigger of the DEFAULT branch: the
 * pipeline runs the default branch's configuration and engine (an MR cannot change how it is judged) with the protected
 * bot token, and gets the webhook body as TRIGGER_PAYLOAD. Scheduled pipelines poll as the fallback.
 *
 * Tasks:
 * - `gate`:   re-judge one MR (cli/risk-gate.mjs);
 * - `review`: the head of one MR needs Claude's review (a push, opened, reopened, ready, retarget);
 * - `queue`:  run the merge queue (an MR was labelled for it, something merged, a gate pass may unblock it).
 * The bot's own events are ignored (its notes and statuses would otherwise re-trigger it forever); notes on anything
 * but merge requests, and events of other projects' MRs, are ignored.
 */

export const TASKS = Object.freeze(["gate", "review", "queue"]);

/** GitLab webhook times ("2026-11-20 12:00:00 UTC") as ISO strings, or null. */
const iso = (s) => {
  const t = Date.parse(s ?? "");
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** MR actions that change the head or what it is compared with: the review must run (again). */
const REVIEW_ACTIONS = new Set(["open", "reopen"]);

/**
 * @param payload  the webhook body (object)
 * @param opts.bot         the bot's username (its own events are ignored)
 * @param opts.queueLabel  the merge-queue label
 * @returns `{ mr: number | null, head: sha | null, tasks: string[], baseChangedAt: string | null, why }`
 */
export function eventTasks(payload, { bot, queueLabel = "merge-queue" } = {}) {
  const none = (why) => ({ mr: null, head: null, tasks: [], baseChangedAt: null, why });
  if (!payload || typeof payload !== "object") return none("no payload");
  const actor = payload.user?.username ?? null;
  if (bot && actor === bot) return none("the bot's own event");

  switch (payload.object_kind) {
    case "merge_request": {
      const a = payload.object_attributes ?? {};
      const mr = Number(a.iid) || null;
      const head = a.last_commit?.id ?? null;
      if (!mr) return none("merge request event without an iid");
      if (a.action === "merge") return { mr, head, tasks: ["queue"], baseChangedAt: null, why: "merged: the next one in the queue" };
      if (a.state && a.state !== "opened") return { mr, head, tasks: [], baseChangedAt: null, why: `state ${a.state}` };
      const ch = payload.changes ?? {};
      const retarget = Boolean(ch.target_branch);
      const pushed = a.action === "update" && Boolean(a.oldrev);
      const ready = Boolean(ch.draft && ch.draft.previous === true && ch.draft.current === false);
      const tasks = ["gate"];
      if (!a.draft && (REVIEW_ACTIONS.has(a.action) || pushed || retarget || ready)) tasks.push("review");
      const labels = (ch.labels?.current ?? []).map((l) => l.title ?? l.name);
      const before = (ch.labels?.previous ?? []).map((l) => l.title ?? l.name);
      if (labels.includes(queueLabel) && !before.includes(queueLabel)) tasks.push("queue");
      return { mr, head, tasks, baseChangedAt: retarget ? iso(a.updated_at) : null, why: `merge request ${a.action ?? "event"}${retarget ? " (retarget)" : ""}` };
    }
    case "note": {
      const a = payload.object_attributes ?? {};
      if (a.noteable_type !== "MergeRequest") return none(`note on ${a.noteable_type ?? "something else"}`);
      const mr = Number(payload.merge_request?.iid) || null;
      if (!mr) return none("note without a merge request");
      if (payload.merge_request?.state && payload.merge_request.state !== "opened") return { mr, head: null, tasks: [], baseChangedAt: null, why: "note on a closed merge request" };
      return { mr, head: payload.merge_request?.last_commit?.id ?? null, tasks: ["gate"], baseChangedAt: null, why: "comment" };
    }
    case "pipeline": {
      const a = payload.object_attributes ?? {};
      const mr = Number(payload.merge_request?.iid) || null;
      const finished = ["success", "failed", "canceled", "skipped"].includes(a.status);
      if (!mr || !finished) return none(mr ? `pipeline ${a.status}` : "pipeline without a merge request");
      // A finished MR pipeline changes the required checks: the queue may take the MR now.
      return { mr, head: a.sha ?? null, tasks: ["gate", "queue"], baseChangedAt: null, why: `merge request pipeline ${a.status}` };
    }
    default:
      return none(`event ${payload.object_kind ?? "?"} is not handled`);
  }
}
