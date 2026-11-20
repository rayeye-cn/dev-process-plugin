/**
 * GitHub forge adapter (github.com and GHES). Built-in fetch only, no dependencies.
 * Token: `GH_TOKEN` or `GITHUB_TOKEN` (in Actions, `github.token`); API base: `GITHUB_API_URL` (set by Actions on GHES).
 * REST pages follow `Link: rel="next"`; GraphQL errors throw with the error text.
 *
 * The adapter normalizes a pull request into the shape the core expects (see `loadChange`); the GitLab adapter returns
 * the same shape for merge requests.
 */
import { execFileSync } from "node:child_process";

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

/** The latest time among the arguments (ISO strings), or null. */
const latest = (...times) => {
  const valid = times.filter((x) => Number.isFinite(Date.parse(x ?? "")));
  return valid.length ? valid.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
};

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
