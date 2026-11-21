/**
 * GitHub calls the role-agent runner makes (cli/agent-run.mjs), as plain functions of a forge from createGithub, so
 * tests can fake REST / GraphQL. Every write here happens under the person's own login; model text reaches these only
 * after core/team.mjs `safeText`.
 */
const repoPath = (forge) => `/repos/${forge.owner}/${forge.name}`;
const enc = encodeURIComponent;

const LABELED_QUERY = `query($o:String!,$n:String!,$i:Int!){ repository(owner:$o,name:$n){ issue(number:$i){
  timelineItems(itemTypes:[LABELED_EVENT], last:100){ nodes{ ... on LabeledEvent{ createdAt label{ name } actor{ login } } } } } } }`;

/** An issue in the runner's shape (labels and assignees as names; `isPull` for pull requests the issues API returns). */
export function normalizeIssue(i) {
  return {
    number: i.number,
    title: i.title ?? "",
    body: i.body ?? "",
    state: i.state,
    isPull: Boolean(i.pull_request),
    author: i.user?.login ?? null,
    labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    assignees: (i.assignees ?? []).map((a) => a.login),
  };
}

/** Open issues carrying `label` (pull requests left out). */
export async function issuesWithLabel(forge, label) {
  return (await forge.rest.paginate(`${repoPath(forge)}/issues?state=open&labels=${enc(label)}`)).map(normalizeIssue).filter((i) => !i.isPull);
}

/** Who last applied `label` to issue `number` (timeline), or null. */
export async function labeledBy(forge, number, label) {
  const nodes = (await forge.graphql(LABELED_QUERY, { o: forge.owner, n: forge.name, i: Number(number) })).repository?.issue?.timelineItems?.nodes ?? [];
  const hit = nodes.filter((e) => e?.label?.name === label).at(-1);
  return hit?.actor?.login ?? null;
}

/** The last `limit` comments of an issue: `[{ login, body }]`. */
export async function issueComments(forge, number, limit = 20) {
  return (await forge.rest.paginate(`${repoPath(forge)}/issues/${number}/comments`)).slice(-limit).map((c) => ({ login: c.user?.login ?? "", body: c.body ?? "" }));
}

export async function addLabels(forge, number, labels) {
  if (labels.length) await forge.rest.post(`${repoPath(forge)}/issues/${number}/labels`, { labels });
}

/** Remove labels one by one; an already missing label is fine. */
export async function removeLabels(forge, number, labels) {
  for (const l of labels) {
    try {
      await forge.rest.delete(`${repoPath(forge)}/issues/${number}/labels/${enc(l)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
}

/** Make `logins` the assignees (others removed). The caller has checked each login with `assignable`. */
export async function setAssignees(forge, number, current, logins) {
  const drop = current.filter((l) => !logins.some((x) => x.toLowerCase() === l.toLowerCase()));
  const add = logins.filter((l) => !current.some((x) => x.toLowerCase() === l.toLowerCase()));
  if (drop.length) await forge.rest.delete(`${repoPath(forge)}/issues/${number}/assignees`, { assignees: drop });
  if (add.length) await forge.rest.post(`${repoPath(forge)}/issues/${number}/assignees`, { assignees: add });
}

export async function comment(forge, number, body) {
  await forge.rest.post(`${repoPath(forge)}/issues/${number}/comments`, { body });
}

/** A new issue; returns its number. */
export async function createIssue(forge, { title, body, labels = [], assignees = [] }) {
  return (await forge.rest.post(`${repoPath(forge)}/issues`, { title, body, labels, assignees })).number;
}

/** A new pull request; returns `{ number, url }`. */
export async function createPull(forge, { head, base, title, body }) {
  const p = await forge.rest.post(`${repoPath(forge)}/pulls`, { head, base, title, body, maintainer_can_modify: true });
  return { number: p.number, url: p.html_url };
}

/** Open pull requests from the runner's branches (`agent/…`) opened by `login`: `[{ number, labels, headSha, ref }]`. */
export async function agentPulls(forge, login, prefix = "agent/") {
  return (await forge.rest.paginate(`${repoPath(forge)}/pulls?state=open`))
    .filter((p) => p.user?.login?.toLowerCase() === String(login).toLowerCase() && String(p.head?.ref ?? "").startsWith(prefix) && p.head?.repo?.full_name === forge.repo)
    .map((p) => ({ number: p.number, labels: (p.labels ?? []).map((l) => l.name), headSha: p.head?.sha, ref: p.head?.ref, body: p.body ?? "" }));
}

/** Requested reviewers of a pull request (logins), to take the never-notify accounts off again. */
export async function dropReviewers(forge, number, logins) {
  const req = (await forge.rest.get(`${repoPath(forge)}/pulls/${number}/requested_reviewers`))?.users?.map((u) => u.login) ?? [];
  const drop = req.filter((l) => logins.some((x) => x.toLowerCase() === l.toLowerCase()));
  if (drop.length) await forge.rest.delete(`${repoPath(forge)}/pulls/${number}/requested_reviewers`, { reviewers: drop });
  return drop;
}
