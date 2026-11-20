/**
 * Branch protection derived from the policy (pure). Applied LAST, after a test PR shows every required check reporting —
 * otherwise every PR is blocked.
 *
 * GitHub ruleset (why each rule, see the generated CLAUDE.md "review process"):
 * - PRs only; no deletion, no force push; merge method from the policy;
 * - 0 base approvals: the risk gate computes how many people each tier needs (rulesets cannot vary it per tier);
 * - stale approvals dismissed on push; CODEOWNERS paths need an owner's approval; every conversation resolved;
 * - required checks: the CI checks, the risk gate, and (self-built queue) the queue status, which only the queue writes;
 *   all bound to the CI integration (GitHub Actions = 15368), so a status posted with a personal token does not count;
 * - repository admins may bypass ON A PR only (bypass_mode=pull_request), and must say why in the PR.
 * Native merge queue mode adds the `merge_queue` rule instead of the queue status.
 */

/** Stable, language-neutral ruleset name: it is the lookup key, so it must not change with the project's language. */
export const RULESET_NAME = "dev-process";

/** Required check contexts, in a stable order, without duplicates. */
export function requiredContexts(policy) {
  const own = [...policy.checks.required, ...policy.checks.skippable, policy.names.gateContext];
  if (policy.queue.mode === "self") own.push(policy.names.queueContext);
  return [...new Set(own)];
}

export function githubRuleset(policy) {
  const integration = policy.protection.integrationId;
  const rules = [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: true,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: [policy.queue.mergeMethod],
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: requiredContexts(policy).map((context) => ({ context, ...(integration ? { integration_id: integration } : {}) })),
      },
    },
  ];
  if (policy.queue.mode === "native") {
    rules.push({
      type: "merge_queue",
      parameters: {
        merge_method: policy.queue.mergeMethod.toUpperCase(),
        grouping_strategy: "ALLGREEN",
        max_entries_to_build: 5,
        max_entries_to_merge: 5,
        min_entries_to_merge: 1,
        min_entries_to_merge_wait_minutes: 5,
        check_response_timeout_minutes: policy.queue.ciTimeoutMin,
      },
    });
  }
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [{ actor_id: policy.protection.bypassActorId, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
    rules,
  };
}

/* ───────────────────────────── GitLab ───────────────────────────── */

/** GitLab access levels. */
export const GL = Object.freeze({ NO_ONE: 0, DEVELOPER: 30, MAINTAINER: 40 });
/** The environment the bot token is scoped to (only jobs that declare it see the variable). */
export const BOT_ENVIRONMENT = "dev-process-bot";
/** Descriptions mark what the setup owns (trigger, schedules), so a re-run finds them. */
export const GITLAB_MARK = "dev-process";

/**
 * What the GitLab setup wants (pure). Free-tier enforcement is "only the bot merges": the default branch takes no pushes,
 * merges need Maintainer, the bot is the only Maintainer (doctor reports human Maintainers). Premium adds approval
 * settings and Code Owner approval; merge trains are a queue mode.
 * The tier and the schedules come from `policy.gitlab` (rendered from the answers).
 */
export function gitlabPlan(policy, { defaultBranch } = {}) {
  const tier = policy.gitlab?.tier ?? "free";
  const premium = tier !== "free";
  const wanted = new Set(policy.gitlab?.schedules ?? ["poll"]);
  return {
    protectedBranch: {
      name: defaultBranch,
      push_access_level: GL.NO_ONE,
      merge_access_level: GL.MAINTAINER,
      unprotect_access_level: GL.MAINTAINER,
      allow_force_push: false,
      ...(premium ? { code_owner_approval_required: true } : {}),
    },
    project: {
      only_allow_merge_if_pipeline_succeeds: true,
      only_allow_merge_if_all_discussions_are_resolved: true,
      // Pipelines with variables (the queue's) need Maintainer; a Developer cannot start one with variables.
      ci_pipeline_variables_minimum_override_role: "maintainer",
    },
    ...(premium
      ? { approvals: { reset_approvals_on_push: true, merge_requests_author_approval: false, merge_requests_disable_committers_approval: true, disable_overriding_approvers_per_merge_request: true } }
      : {}),
    schedules: [
      { task: "poll", cron: "*/10 * * * *", description: `${GITLAB_MARK}: poll (re-judge, missed reviews, queue)` },
      { task: "sweep", cron: "17 3 * * *", description: `${GITLAB_MARK}: nightly sweep` },
      { task: "metrics", cron: "23 1 * * 1", description: `${GITLAB_MARK}: weekly metrics` },
    ].filter((x) => wanted.has(x.task)),
    hookEvents: { merge_requests_events: true, note_events: true, pipeline_events: true, push_events: false, issues_events: false, tag_push_events: false, enable_ssl_verification: true },
    labels: [policy.names.queueLabel],
  };
}
