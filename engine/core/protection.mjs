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
