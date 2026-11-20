/**
 * GitHub forge adapter (github.com and GHES). Built-in fetch only, no dependencies.
 * Token: `GH_TOKEN` or `GITHUB_TOKEN` (in Actions, `github.token`); API base: `GITHUB_API_URL` (set by Actions on GHES).
 * REST pages follow `Link: rel="next"`; GraphQL errors throw with the error text.
 *
 * The adapter normalizes a pull request into the shape the core expects (see `loadChange`); the GitLab adapter returns
 * the same shape for merge requests.
 */
import { execFileSync } from "node:child_process";

import { latestTime as latest, mapLimit } from "./util.mjs";

/** `owner/name` → `{ owner, name }`. */
export function splitRepo(full) {
  const [owner, name] = String(full ?? "").split("/");
  if (!owner || !name) throw new Error(`bad repository name: ${full}`);
  return { owner, name };
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$after:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$pr){
    reviewThreads(first:100, after:$after){ pageInfo{ hasNextPage endCursor }
      nodes{ id isResolved isOutdated path line
        comments(first:100){ pageInfo{ hasNextPage endCursor } nodes{ author{ login __typename } body url } } } } } } }`;

// When a thread has more than a page of comments, continue by thread id (tagged replies may come late).
const THREAD_COMMENTS_QUERY = `query($id:ID!,$after:String){
  node(id:$id){ ... on PullRequestReviewThread {
    comments(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ author{ login __typename } body url } } } } }`;

const BASE_CHANGE_QUERY = `query($o:String!,$n:String!,$pr:Int!){ repository(owner:$o,name:$n){ pullRequest(number:$pr){
  timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT], last:1){ nodes{ ... on BaseRefChangedEvent{ createdAt } } } } } }`;

const toThreadComment = (c) => ({ login: c.author?.login, type: c.author?.__typename === "Bot" ? "Bot" : "User", body: c.body, url: c.url });

/**
 * All review threads of a PR, paging both the thread list and each thread's comments.
 * @param query GraphQL call (tests pass a fake).
 */
export async function loadReviewThreads(owner, name, pr, query) {
  const out = [];
  for (let after = null; ; ) {
    const page = (await query(THREADS_QUERY, { owner, name, pr: Number(pr), after })).repository.pullRequest.reviewThreads;
    for (const th of page.nodes) {
      const comments = th.comments.nodes.map(toThreadComment);
      for (let cp = th.comments.pageInfo; cp?.hasNextPage; ) {
        const more = (await query(THREAD_COMMENTS_QUERY, { id: th.id, after: cp.endCursor })).node.comments;
        comments.push(...more.nodes.map(toThreadComment));
        cp = more.pageInfo;
      }
      out.push({ isResolved: th.isResolved, isOutdated: th.isOutdated, path: th.path, line: th.line, comments });
    }
    if (!page.pageInfo.hasNextPage) return out;
    after = page.pageInfo.endCursor;
  }
}


const toIssue = (i) => ({ number: i.number, title: i.title ?? "", body: i.body ?? "", state: i.state });

/** All pages of a search (the search API returns at most 1,000 results). */
export async function searchAll(rest, q) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const r = await rest.get(`/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
    items.push(...(r.items ?? []));
    if (items.length >= (r.total_count ?? 0) || !(r.items ?? []).length) break;
  }
  return items;
}

/* ───────────── merge queue, mode "self" (cli/merge-queue.mjs): plain functions of the forge, so tests can fake REST ───────────── */

const repoPath = (forge) => `/repos/${forge.owner}/${forge.name}`;

/** A pull request in the queue's normalized shape. `conflicted` and `commits` need the single-PR endpoint. */
export function normalizePull(forge, p) {
  return {
    number: p.number,
    title: p.title ?? "",
    state: p.state,
    headSha: p.head?.sha,
    baseRef: p.base?.ref,
    labels: (p.labels ?? []).map((l) => ({ name: l.name })),
    draft: Boolean(p.draft),
    fromFork: p.head?.repo?.full_name !== forge.repo,
    conflicted: p.mergeable_state === "dirty",
    commits: p.commits ?? null,
  };
}

const normalizeRun = (r) => (r ? { id: r.id, status: r.status, conclusion: r.conclusion, url: r.html_url } : null);

const CLOSING_ISSUES_QUERY = `query($o:String!,$n:String!,$pr:Int!){ repository(owner:$o,name:$n){ pullRequest(number:$pr){
  closingIssuesReferences(first:20){ nodes{ number state repository{ nameWithOwner } } } } } }`;

export const githubQueueOps = Object.freeze({
  defaultBranch: async (forge) => (await forge.rest.get(repoPath(forge))).default_branch,
  openChanges: async (forge, branch) => (await forge.rest.paginate(`${repoPath(forge)}/pulls?state=open&base=${encodeURIComponent(branch)}`)).map((p) => normalizePull(forge, p)),
  getChange: async (forge, number) => normalizePull(forge, await forge.rest.get(`${repoPath(forge)}/pulls/${number}`)),
  /** Check runs on a commit: `{ name, id, status, conclusion }`. */
  checkRuns: async (forge, sha) => (await forge.rest.get(`${repoPath(forge)}/commits/${sha}/check-runs?per_page=100`)).check_runs ?? [],
  /** The latest status of one context on a commit (combined view), or null. */
  latestStatus: async (forge, sha, context) => (await forge.rest.get(`${repoPath(forge)}/commits/${sha}/status`)).statuses?.find((s) => s.context === context) ?? null,
  removeLabel: (forge, number, label) => forge.rest.delete(`${repoPath(forge)}/issues/${number}/labels/${encodeURIComponent(label)}`),
  branchSha: async (forge, branch) => (await forge.rest.get(`${repoPath(forge)}/git/ref/heads/${branch}`)).object.sha,
  createBranch: (forge, branch, sha) => forge.rest.post(`${repoPath(forge)}/git/refs`, { ref: `refs/heads/${branch}`, sha }),
  deleteBranch: (forge, branch) => forge.rest.delete(`${repoPath(forge)}/git/refs/heads/${branch}`),
  /** Merge `head` into `branch` on the server; the new sha, or null on a conflict. */
  async mergeIntoBranch(forge, branch, head, message) {
    try {
      const merged = await forge.rest.post(`${repoPath(forge)}/merges`, { base: branch, head, commit_message: message });
      return merged?.sha ?? (await githubQueueOps.branchSha(forge, branch)); // 204: already contained
    } catch (e) {
      if (e.status === 409) return null;
      throw e;
    }
  },
  dispatchWorkflow: (forge, workflow, ref, inputs) => forge.rest.post(`${repoPath(forge)}/actions/workflows/${workflow}/dispatches`, inputs ? { ref, inputs } : { ref }),
  /** The run a dispatch started: on `branch`, for `sha`, created after `since` (ms). */
  async findDispatchedRun(forge, workflow, branch, sha, since) {
    const runs = await forge.rest.get(`${repoPath(forge)}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&per_page=10`);
    return normalizeRun(runs.workflow_runs?.find((r) => r.head_sha === sha && Date.parse(r.created_at) >= since));
  },
  getRun: async (forge, id) => normalizeRun(await forge.rest.get(`${repoPath(forge)}/actions/runs/${id}`)),
  /** Merge the change; the merged commit's sha (or null). Throws when the forge refuses. */
  mergeChange: async (forge, number, { sha, method, title, message }) =>
    (await forge.rest.put(`${repoPath(forge)}/pulls/${number}/merge`, { merge_method: method, sha, commit_title: title, commit_message: message }))?.sha ?? null,
  async closingIssues(forge, number) {
    const data = await forge.graphql(CLOSING_ISSUES_QUERY, { o: forge.owner, n: forge.name, pr: Number(number) });
    return data.repository.pullRequest.closingIssuesReferences.nodes;
  },
  closeIssue: (forge, number) => forge.rest.patch(`${repoPath(forge)}/issues/${number}`, { state: "closed", state_reason: "completed" }),
  parentOf: async (forge, sha) => (await forge.rest.get(`${repoPath(forge)}/commits/${sha}`)).parents?.[0]?.sha ?? null,
});

export function createGithub({ repo, env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const API = env.GITHUB_API_URL || "https://api.github.com";
  const { owner, name } = splitRepo(repo ?? env.GITHUB_REPOSITORY);
  const full = `${owner}/${name}`;
  const base = `/repos/${owner}/${name}`;

  const token = () => {
    const tk = env.GH_TOKEN || env.GITHUB_TOKEN;
    if (!tk) throw new Error("GH_TOKEN / GITHUB_TOKEN is not set");
    return tk;
  };

  async function request(method, url, body) {
    const res = await fetchImpl(url.startsWith("http") ? url : `${API}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null; // 5xx may return HTML: keep the text for the error, don't let SyntaxError hide the status
    }
    if (!res.ok) {
      const err = new Error(`${method} ${url} → ${res.status}: ${data?.message ?? text.slice(0, 200)}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return { data, link: res.headers.get("link") };
  }

  const rest = {
    get: async (url) => (await request("GET", url)).data,
    post: async (url, body) => (await request("POST", url, body ?? {})).data,
    put: async (url, body) => (await request("PUT", url, body ?? {})).data,
    patch: async (url, body) => (await request("PATCH", url, body ?? {})).data,
    delete: async (url) => (await request("DELETE", url)).data,
    /** All pages (100 per page). */
    async paginate(url) {
      const out = [];
      let next = `${url}${url.includes("?") ? "&" : "?"}per_page=100`;
      while (next) {
        const { data, link } = await request("GET", next);
        out.push(...(Array.isArray(data) ? data : []));
        next = /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1] ?? null;
      }
      return out;
    },
  };

  /** Raw text (e.g. `application/vnd.github.diff`), not parsed. */
  async function rawGet(url, accept) {
    const res = await fetchImpl(url.startsWith("http") ? url : `${API}${url}`, {
      headers: { authorization: `Bearer ${token()}`, accept, "x-github-api-version": "2022-11-28" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${text.slice(0, 200)}`);
    return text;
  }

  async function graphql(query, variables = {}) {
    const { data } = await request("POST", "/graphql", { query, variables });
    if (data?.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(data.errors).slice(0, 500)}`);
    return data.data;
  }

  return {
    id: "github",
    prTerm: "PR",
    /** The identity CI writes statuses as; only its statuses are trusted. */
    ciIdentity: "github-actions[bot]",
    repo: full,
    owner,
    name,
    rest,
    rawGet,
    graphql,

    loadReviewThreads: (pr) => loadReviewThreads(owner, name, pr, graphql),

    defaultBranch: async () => (await rest.get(base)).default_branch,

    /** Label names of a PR. */
    changeLabels: async (number) => ((await rest.get(`${base}/pulls/${number}`)).labels ?? []).map((l) => l.name),

    /** The PR's diff and title (the classifier's input): `{ diff, title, headSha }`. */
    async loadDiff(number) {
      const path = `${base}/pulls/${number}`;
      const [diff, meta] = await Promise.all([rawGet(path, "application/vnd.github.diff"), rest.get(path)]);
      return { diff, title: meta?.title ?? "", headSha: meta?.head?.sha ?? null };
    },

    /**
     * Issues: the sweep's findings and the eval / metrics reports. An issue is `{ number, title, body, state }`.
     * Label creation errors are ignored (the label usually exists; creating an issue with it still works).
     */
    issues: {
      ensureLabel: (label, color) => rest.post(`${base}/labels`, { name: label, color }).catch(() => {}),
      /** Every issue with the label, open and closed by default. */
      withLabel: async (label, state = "all") => (await rest.paginate(`${base}/issues?labels=${encodeURIComponent(label)}&state=${state}`)).map(toIssue),
      newestOpen: async (label) => {
        const found = await rest.get(`${base}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=1`);
        return found?.[0] ? toIssue(found[0]) : null;
      },
      /** `{ title, labels, body }` → the new issue's number. */
      create: async (issue) => (await rest.post(`${base}/issues`, issue)).number,
      update: (number, { body }) => rest.patch(`${base}/issues/${number}`, { body }),
      comment: (number, body) => rest.post(`${base}/issues/${number}/comments`, { body }),
    },

    /** What the weekly metrics read (cli/metrics.mjs). */
    metrics: {
      /**
       * PRs merged into `branch` at or after `since` (a Date), as `{ number, title, author, createdAt, mergedAt, labels,
       * mergeSha }`. The search filters by day only, so each PR is refetched and filtered by its merge time.
       */
      async mergedSince(branch, since, concurrency = 4) {
        const found = await searchAll(rest, `repo:${full} is:pr is:merged base:${branch} merged:>=${since.toISOString().slice(0, 10)}`);
        const prs = await mapLimit(found, concurrency, (i) => rest.get(`${base}/pulls/${i.number}`));
        return prs
          .filter((p) => p.merged_at && Date.parse(p.merged_at) >= since.getTime())
          .map((p) => ({ number: p.number, title: p.title ?? "", author: p.user?.login, createdAt: p.created_at, mergedAt: p.merged_at, labels: p.labels ?? [], mergeSha: p.merge_commit_sha ?? null }));
      },
      /** Commits on `branch` since `since` (a Date): `{ sha, message }`. */
      commitsSince: async (branch, since) =>
        (await rest.paginate(`${base}/commits?sha=${encodeURIComponent(branch)}&since=${since.toISOString()}`)).map((c) => ({ sha: c.sha, message: c.commit?.message ?? "" })),
      /**
       * Reviews, comments, threads and the merge commit's message of one merged PR (from mergedSince). No files, statuses
       * or write access (the gate's loadChange would be wasted here).
       * @param mergeMessages  sha → message of the default-branch commits already fetched
       */
      async load(pr, mergeMessages) {
        const threads = await loadReviewThreads(owner, name, Number(pr.number), graphql);
        const [reviews, comments] = await Promise.all([rest.paginate(`${base}/pulls/${pr.number}/reviews`), rest.paginate(`${base}/issues/${pr.number}/comments`)]);
        // The merge commit's message (the merge queue records an AI review waiver there): look in the default-branch commits
        // already fetched, else fetch it. A failure fails the report instead of silently reading as "not waived": the waiver
        // count is the only record of people standing in for the AI review.
        let mergeMessage = "";
        if (pr.mergeSha) mergeMessage = mergeMessages.get(pr.mergeSha) ?? (await rest.get(`${base}/commits/${pr.mergeSha}`)).commit?.message ?? "";
        return {
          mergeMessage,
          author: pr.author,
          createdAt: pr.createdAt,
          mergedAt: pr.mergedAt,
          labels: pr.labels,
          reviews: reviews.map((r) => ({ login: r.user?.login, type: r.user?.type, state: r.state, submittedAt: r.submitted_at, body: r.body, commitId: r.commit_id })),
          comments: comments.map((c) => ({ login: c.user?.login, type: c.user?.type, body: c.body, createdAt: c.created_at, updatedAt: c.updated_at })),
          threads,
        };
      },
    },

    /** Open PR whose head is `sha` (workflow_run carries no PR for forks). */
    async findOpenPrByHead(sha) {
      const open = await rest.paginate(`${base}/pulls?state=open`);
      return open.find((p) => p.head?.sha === sha)?.number ?? null;
    },

    /** write / maintain / admin on this repository; unknown ⇒ false. */
    async hasWriteAccess(login) {
      try {
        const r = await rest.get(`${base}/collaborators/${encodeURIComponent(login)}/permission`);
        return ["admin", "maintain", "write"].includes(r.role_name ?? r.permission);
      } catch {
        return false;
      }
    },

    /** Keep one marked comment on the PR (edit if present, else create); returns its id. */
    async upsertMarkedComment(number, marker, body, isOwn = (c) => c.user?.type === "Bot" || /\[bot\]$/i.test(c.user?.login ?? "")) {
      const comments = await rest.paginate(`${base}/issues/${number}/comments`);
      const mine = comments.find((c) => isOwn(c) && c.body?.includes(marker));
      const text = `${marker}\n${body}`;
      if (mine) {
        if (mine.body !== text) await rest.patch(`${base}/issues/comments/${mine.id}`, { body: text });
        return mine.id;
      }
      return (await rest.post(`${base}/issues/${number}/comments`, { body: text })).id;
    },

    postComment: (number, body) => rest.post(`${base}/issues/${number}/comments`, { body }),

    /** Commit status (the ruleset requires it). GitHub rejects descriptions over 140 characters. */
    async setStatus(sha, context, state, description, targetUrl) {
      await rest.post(`${base}/statuses/${sha}`, {
        state,
        context,
        description: [...String(description)].slice(0, 138).join(""),
        ...(targetUrl ? { target_url: targetUrl } : {}),
      });
    },

    /** Link to the current Actions run. */
    runUrl() {
      return env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    },

    /** Keep exactly one `<prefix><tier>` label on the PR. */
    async syncRiskLabel(number, tier, existing, prefix = "risk:") {
      const want = `${prefix}${tier}`;
      const colors = { low: "0e8a16", medium: "fbca04", high: "b60205" };
      for (const l of existing) {
        if (l.name.startsWith(prefix) && l.name !== want) await rest.delete(`${base}/issues/${number}/labels/${encodeURIComponent(l.name)}`).catch(() => {});
      }
      if (existing.some((l) => l.name === want)) return;
      await rest.post(`${base}/labels`, { name: want, color: colors[tier] }).catch((e) => {
        if (e.status !== 422) throw e; // already exists
      });
      await rest.post(`${base}/issues/${number}/labels`, { labels: [want] });
    },

    /** Current head commit of a PR (one request). */
    headOf: async (number) => (await rest.get(`${base}/pulls/${number}`)).head.sha,

    async requestedReviewers(number) {
      const r = await rest.get(`${base}/pulls/${number}/requested_reviewers`).catch(() => ({ users: [] }));
      return (r.users ?? []).map((u) => u.login);
    },

    /**
     * Ask the AI reviewer to review again: `gh pr edit --add-reviewer @copilot` (the REST endpoint does not accept it).
     * Only reviewers with `rerequestable` get here; Claude's review workflow re-runs on its own events instead.
     */
    async requestAiReview(number, reviewerId) {
      if (reviewerId === "copilot") {
        execFileSync("gh", ["pr", "edit", String(number), "--repo", full, "--add-reviewer", "@copilot"], { stdio: "pipe" });
        return;
      }
      throw new Error(`requestAiReview: reviewer "${reviewerId}" cannot be re-requested on GitHub`);
    },

    /**
     * Everything the gate needs about one PR, normalized:
     * `{ number, author, headSha, baseRef, draft, fromFork, labels, files, reviews, comments, threads, statuses,
     *    baseChangedAt, raw }`. `baseHint`: the event's own base-change time (the timeline may lag).
     */
    async loadChange(number, { baseHint = null } = {}) {
      const p = await rest.get(`${base}/pulls/${number}`);
      const [files, reviews, comments, threads, statuses, baseTimeline] = await Promise.all([
        rest.paginate(`${base}/pulls/${number}/files`),
        rest.paginate(`${base}/pulls/${number}/reviews`),
        rest.paginate(`${base}/issues/${number}/comments`),
        loadReviewThreads(owner, name, Number(number), graphql),
        // status history (not the combined view): we need to know who wrote each one
        rest.paginate(`${base}/commits/${p.head.sha}/statuses`),
        graphql(BASE_CHANGE_QUERY, { o: owner, n: name, pr: Number(number) }),
      ]);
      return {
        number: p.number,
        author: p.user.login,
        headSha: p.head.sha,
        baseRef: p.base?.ref,
        draft: Boolean(p.draft),
        fromFork: p.head?.repo?.full_name !== full,
        labels: (p.labels ?? []).map((l) => ({ name: l.name })),
        files: files.map((f) => ({ filename: f.filename, previous_filename: f.previous_filename, additions: f.additions, deletions: f.deletions })),
        reviews: reviews.map((r) => ({
          login: r.user?.login,
          type: r.user?.type,
          state: r.state,
          commitId: r.commit_id,
          submittedAt: r.submitted_at,
          association: r.author_association,
          body: r.body,
        })),
        comments: comments.map((c) => ({ id: c.id, login: c.user?.login, type: c.user?.type, body: c.body, createdAt: c.created_at, updatedAt: c.updated_at })),
        threads,
        statuses,
        baseChangedAt: latest(baseTimeline.repository.pullRequest.timelineItems.nodes.at(-1)?.createdAt, baseHint),
        raw: p,
      };
    },
  };
}
