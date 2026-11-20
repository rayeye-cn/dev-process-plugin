/**
 * GitLab forge adapter (self-managed and gitlab.com), REST v4, built-in fetch only, no dependencies.
 *
 * Token: `DEV_PROCESS_TOKEN` (the project access token of the process bot: `api` scope, Maintainer), else `GITLAB_TOKEN`.
 * It is a protected CI/CD variable: only pipelines of the default branch see it, never a merge request pipeline (which runs
 * the source branch's own `.gitlab-ci.yml`). API base: `CI_API_V4_URL` (set in GitLab CI), else `GITLAB_API_URL`, else
 * `<url>/api/v4` from the policy. Project: `CI_PROJECT_PATH` in CI, else the `group/…/name` path given.
 *
 * The adapter normalizes a merge request into the shape the core expects (forge/github.mjs `loadChange`), so the gate,
 * the queue and the metrics don't know which forge they talk to:
 * - an approval becomes an APPROVED review on the head of the diff version that was current when it was given (GitLab
 *   approvals are not tied to a commit; on tiers without "reset approvals on push" an old approval must not count);
 * - discussion threads become review threads (a DiffNote thread is "outdated" when GitLab no longer shows its position on
 *   the latest diff version);
 * - notes become comments, commit statuses (CI jobs included) become statuses / check runs.
 * The bot is both the CI identity (gate status, sticky note, queue) and the AI reviewer's account (post-review posts
 * Claude's comments with the same token); the markers tell a review from a notice (reviewer/claude.mjs).
 */

import { latestTime } from "./util.mjs";

/** Access level of Developer: the GitLab counterpart of "write access" (push to unprotected branches, approve). */
export const DEVELOPER = 30;
/** Bot users of project / group access tokens: `project_<id>_bot_<hash>` / `group_<id>_bot_<hash>`. */
const TOKEN_BOT = /^(project|group)_\d+_bot(_[0-9a-f]+)?$/i;

/** `group/sub/name` → `{ owner: "group/sub", name }` (GitLab paths nest). */
export function splitProject(full) {
  const parts = String(full ?? "").split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`bad project path: ${full}`);
  return { owner: parts.slice(0, -1).join("/"), name: parts.at(-1) };
}

/**
 * GitLab runs quick actions (`/merge`, `/approve`, `/close`, `/label …`) found at the start of a line in notes, issue
 * descriptions and MR descriptions — also when the bot posts them through the API, with the bot's Maintainer rights.
 * Everything the bot writes may carry text it does not control (Claude's review, a file name with a line break in the
 * gate's note), so a line that starts with `/` outside a fenced code block gets a zero-width space in front: it reads
 * the same and is never a command. Applied in this adapter to every note and issue text, so no caller can forget it.
 */
export function noQuickActions(text) {
  let fence = 0;
  return String(text ?? "")
    .split("\n")
    .map((line) => {
      const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1].length ?? 0;
      if (fence === 0 && run >= 3) {
        fence = run;
        return line;
      }
      if (fence > 0) {
        if (run >= fence && /^ {0,3}(`+|~+)\s*$/.test(line)) fence = 0;
        return line;
      }
      return /^\s*\//.test(line) ? line.replace(/^(\s*)\//, "$1\u200b/") : line;
    })
    .join("\n");
}

/** Our status states → GitLab commit status states. */
const STATE_OUT = { success: "success", failure: "failed", error: "failed", pending: "pending", running: "running" };
/** GitLab commit status / job states → GitHub-like `{ state }` (statuses) and `{ status, conclusion }` (check runs). */
const STATE_IN = { success: "success", failed: "failure", canceled: "error", pending: "pending", running: "pending", created: "pending", manual: "pending", skipped: "success" };
const asCheckRun = (s) => {
  const done = ["success", "failed", "canceled", "skipped"].includes(s.status);
  const conclusion = { success: "success", failed: "failure", canceled: "cancelled", skipped: "skipped" }[s.status] ?? null;
  return { name: s.name, id: s.id, status: done ? "completed" : "in_progress", conclusion: done ? conclusion : null };
};

/** Lines added / removed in one file's unified diff (GitLab gives no counts). */
export function diffCounts(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

/** One file of `/merge_requests/:iid/diffs` → the git-style text the classifier and the prompts read. */
export function unifiedDiff(d) {
  const a = d.new_file ? "/dev/null" : `a/${d.old_path}`;
  const b = d.deleted_file ? "/dev/null" : `b/${d.new_path}`;
  return `diff --git a/${d.old_path} b/${d.new_path}\n--- ${a}\n+++ ${b}\n${String(d.diff ?? "").replace(/\n?$/, "\n")}`;
}

/**
 * The commit an approval was given on: the head of the newest diff version created before it (versions are pushes).
 * Unknown time or no version before it ⇒ null (it does not count on any head).
 */
export function approvedOn(approvedAt, versions) {
  const at = Date.parse(approvedAt ?? "");
  if (!Number.isFinite(at)) return null;
  const before = versions.filter((v) => Date.parse(v.created_at) <= at).sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
  return before[0]?.head_commit_sha ?? null;
}

/**
 * When the target branch last changed: GitLab records it as a system note ("changed target branch from `a` to `b`").
 * The newest such note's time, or null.
 */
export function targetChangedAt(notes) {
  const changes = notes.filter((n) => n.system && /^changed target branch from /i.test(String(n.body ?? "")));
  return latestTime(...changes.map((n) => n.created_at));
}

/**
 * Review threads from discussions: threads that can be resolved (a DiffNote or a started thread), not single notes.
 * `isOutdated`: a DiffNote whose position is not on the latest diff version and whose line GitLab no longer maps
 * (`position.line_range` gone and `resolvable` kept) — approximated by "posted on another head and the note says so" is
 * not available, so: a DiffNote on an older head whose file is no longer in the diff counts as outdated.
 */
export function threadsFrom(discussions, { headSha, changedPaths, isBotLogin }) {
  const out = [];
  for (const d of discussions) {
    const notes = (d.notes ?? []).filter((n) => !n.system);
    const first = notes[0];
    if (!first || d.individual_note || !first.resolvable) continue;
    const pos = first.position ?? null;
    const path = pos?.new_path ?? pos?.old_path ?? null;
    const outdated = Boolean(pos && pos.head_sha && pos.head_sha !== headSha && path && !changedPaths.has(path));
    out.push({
      isResolved: notes.every((n) => !n.resolvable || n.resolved),
      isOutdated: outdated,
      path,
      line: pos?.new_line ?? pos?.old_line ?? null,
      comments: notes.map((n) => ({ login: n.author?.username, type: isBotLogin(n.author?.username) ? "Bot" : "User", body: n.body, url: null })),
    });
  }
  return out;
}

/* ───────────── merge queue, mode "self" (cli/merge-queue.mjs): plain functions of the forge, like githubQueueOps ───────────── */

const projectPath = (forge) => `/projects/${encodeURIComponent(forge.repo)}`;
const mrPath = (forge, iid) => `${projectPath(forge)}/merge_requests/${iid}`;
const branchPath = (forge, branch) => `${projectPath(forge)}/repository/branches/${encodeURIComponent(branch)}`;

/** A merge request in the queue's normalized shape. */
export function normalizeMr(m) {
  return {
    number: m.iid,
    title: m.title ?? "",
    state: m.state === "opened" ? "open" : m.state,
    headSha: m.sha,
    baseRef: m.target_branch,
    labels: (m.labels ?? []).map((l) => ({ name: typeof l === "string" ? l : l.name })),
    draft: Boolean(m.draft ?? m.work_in_progress),
    fromFork: m.source_project_id !== m.project_id,
    conflicted: Boolean(m.has_conflicts),
    commits: null,
  };
}

/** A pipeline as the queue's CI run: `{ id, status: completed | in_progress, conclusion, url }`. */
export function normalizePipeline(p) {
  if (!p) return null;
  const done = { success: "success", failed: "failure", canceled: "cancelled", skipped: "skipped" }[p.status];
  return { id: p.id, status: done ? "completed" : "in_progress", conclusion: done ?? null, url: p.web_url };
}

/** Pipelines this process created, per forge object: `${ref}@${sha}` → pipeline (the create call returns it). */
const created = new WeakMap();

export const gitlabQueueOps = Object.freeze({
  defaultBranch: (forge) => forge.defaultBranch(),
  openChanges: async (forge, branch) => (await forge.rest.paginate(`${projectPath(forge)}/merge_requests?state=opened&target_branch=${encodeURIComponent(branch)}`)).map(normalizeMr),
  getChange: async (forge, iid) => normalizeMr(await forge.rest.get(mrPath(forge, iid))),
  /** CI jobs and other statuses on a commit, as check runs (the highest id per name is the latest). */
  checkRuns: (forge, sha) => forge.checkRuns(sha),
  latestStatus: async (forge, sha, context) => (await forge.statusesOf(sha)).find((s) => s.context === context) ?? null,
  removeLabel: (forge, iid, label) => forge.rest.put(mrPath(forge, iid), { remove_labels: label }),
  branchSha: async (forge, branch) => (await forge.rest.get(branchPath(forge, branch))).commit.id,
  createBranch: (forge, branch, sha) => forge.rest.post(`${projectPath(forge)}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${sha}`),
  deleteBranch: (forge, branch) => forge.rest.delete(branchPath(forge, branch)),
  /**
   * The temporary branch becomes "target branch + this merge request": GitLab computes that merge itself
   * (`refs/merge-requests/:iid/merge`, refreshed by `GET …/merge_ref`); the branch is re-created at that commit. The
   * merge must sit on the commit the branch was created at (`base`); if the target branch moved in between, the merge is
   * computed once more, then this run gives up (the next run re-tests). A merge GitLab cannot compute ⇒ null (conflict).
   */
  async mergeIntoBranch(forge, branch, head, _message, { number, base } = {}) {
    if (!number || !base) throw new Error("gitlab mergeIntoBranch needs the merge request number and the base commit");
    for (let attempt = 0; attempt < 2; attempt++) {
      let ref;
      try {
        ref = await forge.rest.get(`${mrPath(forge, number)}/merge_ref`);
      } catch (e) {
        if (e.status === 400) return null; // "Merge request is not mergeable"
        throw e;
      }
      const sha = ref?.commit_id ?? ref?.id;
      const commit = await forge.rest.get(`${projectPath(forge)}/repository/commits/${sha}`);
      const [first, second] = commit.parent_ids ?? [];
      if (first !== base) continue;
      if (second !== head) throw new Error(`the merge ref of !${number} is not on its head ${head.slice(0, 7)} (a push came in); the next run retries`);
      await forge.rest.delete(branchPath(forge, branch)).catch(() => {});
      await gitlabQueueOps.createBranch(forge, branch, sha);
      return sha;
    }
    throw new Error(`the target branch moved while the candidate for !${number} was built; the next run retries`);
  },
  /**
   * Start a pipeline on `ref` for one of the process's tasks (`workflow` is the task name: the gate, CI, the queue), with
   * the inputs as `DEV_PROCESS_<NAME>` variables. Runs as the bot.
   */
  async dispatchWorkflow(forge, workflow, ref, inputs = {}) {
    const variables = [{ key: "DEV_PROCESS_TASK", value: workflow }, ...Object.entries(inputs).map(([k, v]) => ({ key: `DEV_PROCESS_${k.toUpperCase()}`, value: String(v) }))];
    const p = await forge.rest.post(`${projectPath(forge)}/pipeline`, { ref, variables });
    if (!created.has(forge)) created.set(forge, new Map());
    created.get(forge).set(`${ref}@${p.sha}`, p);
    return p;
  },
  /** The pipeline dispatchWorkflow created on `branch` for `sha` (GitLab returns it from the create call). */
  findDispatchedRun: async (forge, _workflow, branch, sha) => normalizePipeline(created.get(forge)?.get(`${branch}@${sha}`) ?? null),
  getRun: async (forge, id) => normalizePipeline(await forge.rest.get(`${projectPath(forge)}/pipelines/${id}`)),
  /**
   * Merge at exactly `sha` (GitLab refuses when the head moved). `method`: "merge" (the project's merge method) or
   * "squash". Title and message become the merge commit message.
   */
  async mergeChange(forge, iid, { sha, method, title, message }) {
    const m = await forge.rest.put(`${mrPath(forge, iid)}/merge`, {
      sha,
      squash: method === "squash",
      merge_commit_message: message ? `${title}\n\n${message}` : title,
      ...(method === "squash" ? { squash_commit_message: message ? `${title}\n\n${message}` : title } : {}),
    });
    return m?.merge_commit_sha ?? m?.squash_commit_sha ?? null;
  },
  /** GitLab closes the issues an MR names (`Closes #n`) itself when it merges, whoever merges: nothing to do. */
  closingIssues: async () => [],
  closeIssue: (forge, iid) => forge.rest.put(`${projectPath(forge)}/issues/${iid}`, { state_event: "close" }),
  parentOf: async (forge, sha) => (await forge.rest.get(`${projectPath(forge)}/repository/commits/${sha}`)).parent_ids?.[0] ?? null,
});

export function createGitlab({ repo, url, env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const API = (env.CI_API_V4_URL || env.GITLAB_API_URL || (url ? `${String(url).replace(/\/+$/, "")}/api/v4` : "")).replace(/\/+$/, "");
  if (!API) throw new Error("GitLab API URL unknown: set CI_API_V4_URL / GITLAB_API_URL or gitlab.url in the configuration");
  const full = repo ?? env.CI_PROJECT_PATH;
  const { owner, name } = splitProject(full);
  const base = `/projects/${encodeURIComponent(`${owner}/${name}`)}`;
  const mr = (iid) => `${base}/merge_requests/${iid}`;

  const token = () => {
    const tk = env.DEV_PROCESS_TOKEN || env.GITLAB_TOKEN;
    if (!tk) throw new Error("DEV_PROCESS_TOKEN / GITLAB_TOKEN is not set");
    return tk;
  };

  async function request(method, path, body) {
    const res = await fetchImpl(path.startsWith("http") ? path : `${API}${path}`, {
      method,
      headers: { "private-token": token(), accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const message = typeof data?.message === "string" ? data.message : data?.message ? JSON.stringify(data.message) : (data?.error ?? text.slice(0, 200));
      const err = new Error(`${method} ${path} → ${res.status}: ${message}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return { data, headers: res.headers };
  }

  const rest = {
    get: async (p) => (await request("GET", p)).data,
    post: async (p, body) => (await request("POST", p, body ?? {})).data,
    put: async (p, body) => (await request("PUT", p, body ?? {})).data,
    delete: async (p) => (await request("DELETE", p)).data,
    /** All pages (100 per page): `Link: rel="next"` when given (keyset pagination), else `x-next-page`. */
    async paginate(p) {
      const out = [];
      const first = `${p}${p.includes("?") ? "&" : "?"}per_page=100`;
      let next = first;
      while (next) {
        const { data, headers } = await request("GET", next);
        out.push(...(Array.isArray(data) ? data : []));
        const link = /<([^>]+)>;\s*rel="next"/.exec(headers.get("link") ?? "")?.[1];
        const page = headers.get("x-next-page");
        next = link ?? (page ? `${first}&page=${page}` : null);
      }
      return out;
    },
  };

  /** Cached `{ id }` of usernames (write-access checks look users up by name). */
  const userIds = new Map();
  const isBotLogin = (login) => Boolean(login) && (login === forge.ciIdentity || TOKEN_BOT.test(login) || /\[bot\]$/i.test(login));
  const toComment = (n) => ({ id: n.id, login: n.author?.username, type: isBotLogin(n.author?.username) ? "Bot" : "User", body: n.body, createdAt: n.created_at, updatedAt: n.updated_at });
  const toStatus = (s) => ({ context: s.name, state: STATE_IN[s.status] ?? "pending", description: s.description ?? "", creator: { login: s.author?.username }, created_at: s.created_at, id: s.id, target_url: s.target_url });
  const toIssue = (i) => ({ number: i.iid, title: i.title ?? "", body: i.description ?? "", state: i.state === "opened" ? "open" : i.state });
  /** Statuses of a commit, newest first (GitLab lists them oldest first; the gate reads the first match). */
  const commitStatuses = async (sha) => (await rest.paginate(`${base}/repository/commits/${sha}/statuses`)).sort((a, b) => b.id - a.id);
  const notesOf = (iid) => rest.paginate(`${mr(iid)}/notes?sort=asc&order_by=created_at`);

  const forge = {
    id: "gitlab",
    prTerm: "MR",
    /** The bot's username; `ready()` fills it from the token (`GET /user`). */
    ciIdentity: env.DEV_PROCESS_BOT || null,
    repo: `${owner}/${name}`,
    owner,
    name,
    rest,

    /** Look the bot up once (the token decides who writes; statuses and notes are trusted only from it). */
    async ready() {
      if (!forge.ciIdentity) forge.ciIdentity = (await rest.get("/user")).username;
      return forge;
    },

    async findOpenPrByHead(sha) {
      const open = await rest.paginate(`${base}/merge_requests?state=opened`);
      return open.find((m) => m.sha === sha)?.iid ?? null;
    },

    /** Developer or higher on this project (direct or inherited); unknown ⇒ false. */
    async hasWriteAccess(login) {
      try {
        if (!userIds.has(login)) userIds.set(login, (await rest.get(`/users?username=${encodeURIComponent(login)}`))?.[0]?.id ?? null);
        const id = userIds.get(login);
        if (!id) return false;
        return ((await rest.get(`${base}/members/all/${id}`)).access_level ?? 0) >= DEVELOPER;
      } catch {
        return false;
      }
    },

    /** Keep one marked note on the MR (edit the bot's own if present, else create); returns its id. */
    async upsertMarkedComment(iid, marker, body) {
      const notes = await notesOf(iid);
      const mine = notes.find((n) => !n.system && n.author?.username === forge.ciIdentity && n.body?.includes(marker));
      const text = noQuickActions(`${marker}\n${body}`);
      if (mine) {
        if (mine.body !== text) await rest.put(`${mr(iid)}/notes/${mine.id}`, { body: text });
        return mine.id;
      }
      return (await rest.post(`${mr(iid)}/notes`, { body: text })).id;
    },

    postComment: (iid, body) => rest.post(`${mr(iid)}/notes`, { body: noQuickActions(body) }),

    /** What a review posts against: the head, the diff refs (diff thread positions need them) and the diffs. */
    async reviewTarget(iid) {
      const [m, diffs] = await Promise.all([rest.get(mr(iid)), rest.paginate(`${mr(iid)}/diffs`)]);
      return { headSha: m.sha, diffRefs: m.diff_refs, diffs };
    },

    /**
     * Open a resolvable thread on the MR: on a diff line when `position` is given (`{ new_path, old_path, new_line,
     * old_line }` + `diffRefs`), else a plain thread. GitLab rejects a position it cannot place (400); the thread is then
     * opened without one, with `fallbackBody` (which names the place). Returns `{ id, onDiff }`.
     */
    async createThread(iid, { body, position = null, diffRefs = null, fallbackBody = body }) {
      if (position && diffRefs) {
        try {
          const d = await rest.post(`${mr(iid)}/discussions`, {
            body: noQuickActions(body),
            position: {
              position_type: "text",
              base_sha: diffRefs.base_sha,
              start_sha: diffRefs.start_sha,
              head_sha: diffRefs.head_sha,
              new_path: position.new_path,
              old_path: position.old_path,
              new_line: position.new_line,
              ...(position.old_line ? { old_line: position.old_line } : {}),
            },
          });
          return { id: d.id, onDiff: true };
        } catch (e) {
          if (e.status !== 400) throw e;
        }
      }
      const d = await rest.post(`${mr(iid)}/discussions`, { body: noQuickActions(fallbackBody) });
      return { id: d.id, onDiff: false };
    },

    /**
     * Commit status `context` on `sha`. GitLab refuses a transition to the state the status already has ("Cannot
     * transition status via …"); that is the wanted state already, so it is not an error.
     */
    async setStatus(sha, context, state, description, targetUrl) {
      try {
        await rest.post(`${base}/statuses/${sha}`, {
          state: STATE_OUT[state] ?? "failed",
          name: context,
          description: [...String(description)].slice(0, 250).join(""),
          ...(targetUrl ? { target_url: targetUrl } : {}),
        });
      } catch (e) {
        if (e.status === 400 && /cannot transition/i.test(String(e.message))) return;
        throw e;
      }
    },

    runUrl: () => env.CI_JOB_URL || undefined,

    /** Keep exactly one `<prefix><tier>` label on the MR. */
    async syncRiskLabel(iid, tier, existing, prefix = "risk:") {
      const want = `${prefix}${tier}`;
      const colors = { low: "#0e8a16", medium: "#fbca04", high: "#b60205" };
      const remove = existing.map((l) => l.name).filter((n) => n.startsWith(prefix) && n !== want);
      if (!remove.length && existing.some((l) => l.name === want)) return;
      await rest.post(`${base}/labels`, { name: want, color: colors[tier] }).catch((e) => {
        if (e.status !== 409) throw e; // already exists
      });
      await rest.put(mr(iid), { add_labels: want, ...(remove.length ? { remove_labels: remove.join(",") } : {}) });
    },

    headOf: async (iid) => (await rest.get(mr(iid))).sha,

    async requestedReviewers(iid) {
      return ((await rest.get(mr(iid))).reviewers ?? []).map((u) => u.username);
    },

    /** No reviewer is re-requestable on GitLab: Claude's review job runs from the bot's events. */
    async requestAiReview(iid, reviewerId) {
      throw new Error(`requestAiReview: reviewer "${reviewerId}" cannot be re-requested on GitLab`);
    },

    defaultBranch: async () => (await rest.get(base)).default_branch,
    changeLabels: async (iid) => (await rest.get(mr(iid))).labels ?? [],

    async loadDiff(iid) {
      const [m, diffs] = await Promise.all([rest.get(mr(iid)), rest.paginate(`${mr(iid)}/diffs`)]);
      return { diff: diffs.map(unifiedDiff).join(""), title: m.title ?? "", headSha: m.sha ?? null };
    },

    async loadReviewThreads(iid) {
      const [m, discussions, diffs] = await Promise.all([rest.get(mr(iid)), rest.paginate(`${mr(iid)}/discussions`), rest.paginate(`${mr(iid)}/diffs`)]);
      return threadsFrom(discussions, { headSha: m.sha, changedPaths: changedPaths(diffs), isBotLogin });
    },

    /**
     * Everything the gate needs about one MR, normalized like forge/github.mjs `loadChange`. `baseHint`: the event's own
     * target-change time.
     */
    async loadChange(iid, { baseHint = null } = {}) {
      const m = await rest.get(mr(iid));
      const [diffs, approvals, reviewers, notes, discussions, versions, statuses] = await Promise.all([
        rest.paginate(`${mr(iid)}/diffs`),
        rest.get(`${mr(iid)}/approvals`).catch((e) => (e.status === 404 || e.status === 403 ? { approved_by: [] } : Promise.reject(e))),
        rest.get(`${mr(iid)}/reviewers`).catch(() => []),
        notesOf(iid),
        rest.paginate(`${mr(iid)}/discussions`),
        rest.paginate(`${mr(iid)}/versions`),
        commitStatuses(m.sha),
      ]);
      const reviews = [
        ...(approvals.approved_by ?? []).map((a) => ({
          login: a.user?.username,
          type: isBotLogin(a.user?.username) ? "Bot" : "User",
          state: "APPROVED",
          commitId: approvedOn(a.approved_at, versions),
          submittedAt: a.approved_at ?? null,
          association: "MEMBER",
          body: "",
        })),
        // "Request changes" (reviewer state): blocks like GitHub's, until that reviewer approves or reviews again.
        ...(Array.isArray(reviewers) ? reviewers : [])
          .filter((r) => r.state === "requested_changes")
          .map((r) => ({ login: r.user?.username, type: "User", state: "CHANGES_REQUESTED", commitId: m.sha, submittedAt: r.created_at ?? null, association: "MEMBER", body: "" })),
      ];
      return {
        number: m.iid,
        author: m.author?.username,
        headSha: m.sha,
        baseRef: m.target_branch,
        draft: Boolean(m.draft ?? m.work_in_progress),
        fromFork: m.source_project_id !== m.project_id,
        labels: (m.labels ?? []).map((l) => ({ name: typeof l === "string" ? l : l.name })),
        files: diffs.map((d) => ({ filename: d.new_path, ...(d.renamed_file ? { previous_filename: d.old_path } : {}), ...diffCounts(d.diff) })),
        reviews,
        comments: notes.filter((n) => !n.system).map(toComment),
        threads: threadsFrom(discussions, { headSha: m.sha, changedPaths: changedPaths(diffs), isBotLogin }),
        statuses: statuses.map(toStatus),
        baseChangedAt: latestTime(targetChangedAt(notes), baseHint),
        raw: m,
      };
    },

    issues: {
      ensureLabel: (label, color) => rest.post(`${base}/labels`, { name: label, color: `#${String(color).replace(/^#/, "")}` }).catch(() => {}),
      withLabel: async (label, state = "all") => (await rest.paginate(`${base}/issues?labels=${encodeURIComponent(label)}&state=${state === "open" ? "opened" : state}`)).map(toIssue),
      newestOpen: async (label) => {
        const found = await rest.get(`${base}/issues?labels=${encodeURIComponent(label)}&state=opened&order_by=created_at&sort=desc&per_page=1`);
        return found?.[0] ? toIssue(found[0]) : null;
      },
      create: async ({ title, labels = [], body }) => (await rest.post(`${base}/issues`, { title, labels: labels.join(","), description: noQuickActions(body) })).iid,
      update: (iid, { body }) => rest.put(`${base}/issues/${iid}`, { description: noQuickActions(body) }),
      comment: (iid, body) => rest.post(`${base}/issues/${iid}/notes`, { body: noQuickActions(body) }),
    },

    metrics: {
      async mergedSince(branch, since) {
        const found = await rest.paginate(`${base}/merge_requests?state=merged&target_branch=${encodeURIComponent(branch)}&updated_after=${since.toISOString()}`);
        return found
          .filter((m) => m.merged_at && Date.parse(m.merged_at) >= since.getTime())
          .map((m) => ({
            number: m.iid,
            title: m.title ?? "",
            author: m.author?.username,
            createdAt: m.created_at,
            mergedAt: m.merged_at,
            labels: (m.labels ?? []).map((l) => ({ name: l })),
            mergeSha: m.merge_commit_sha ?? m.squash_commit_sha ?? null,
          }));
      },
      commitsSince: async (branch, since) =>
        (await rest.paginate(`${base}/repository/commits?ref_name=${encodeURIComponent(branch)}&since=${since.toISOString()}`)).map((c) => ({ sha: c.id, message: c.message ?? "" })),
      async load(change, mergeMessages) {
        const iid = change.number;
        const [approvals, notes, discussions, versions, diffs] = await Promise.all([
          rest.get(`${mr(iid)}/approvals`).catch(() => ({ approved_by: [] })),
          notesOf(iid),
          rest.paginate(`${mr(iid)}/discussions`),
          rest.paginate(`${mr(iid)}/versions`),
          rest.paginate(`${mr(iid)}/diffs`),
        ]);
        const head = versions.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]?.head_commit_sha ?? null;
        let mergeMessage = "";
        if (change.mergeSha) mergeMessage = mergeMessages.get(change.mergeSha) ?? (await rest.get(`${base}/repository/commits/${change.mergeSha}`)).message ?? "";
        return {
          mergeMessage,
          author: change.author,
          createdAt: change.createdAt,
          mergedAt: change.mergedAt,
          labels: change.labels,
          reviews: (approvals.approved_by ?? []).map((a) => ({ login: a.user?.username, type: isBotLogin(a.user?.username) ? "Bot" : "User", state: "APPROVED", submittedAt: a.approved_at ?? null, body: "", commitId: approvedOn(a.approved_at, versions) })),
          comments: notes.filter((n) => !n.system).map(toComment),
          threads: threadsFrom(discussions, { headSha: head, changedPaths: changedPaths(diffs), isBotLogin }),
        };
      },
    },

    /** Commit statuses (CI jobs included) of a commit as check runs / statuses, newest first. */
    checkRuns: async (sha) => (await commitStatuses(sha)).map(asCheckRun),
    statusesOf: async (sha) => (await commitStatuses(sha)).map(toStatus),
  };
  return forge;
}

const changedPaths = (diffs) => new Set(diffs.flatMap((d) => [d.new_path, d.old_path].filter(Boolean)));
