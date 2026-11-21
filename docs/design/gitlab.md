# GitLab design (M5)

GitLab self-managed 17.11+ and gitlab.com, every tier (CE, EE without a license, Premium, Ultimate). Facts marked
**[M6]** came from the documentation or GitLab's source; the E2E run on GitLab CE 19.6.1 (M6, below) checked most of
them. What one English CE 19.6.1 instance could not check is listed under "Still unverified".

## The rule the design follows

The process bot's token (a project access token, `api` scope, Maintainer) never reaches code a developer controls before
a person has reviewed it. Everything that writes with it runs in pipelines of the **default branch**, with the default
branch's configuration and engine; a merge request cannot change how it is judged.

## Pipelines

| Pipeline | Runs as | Configuration and code | Protected variables | Bot token |
| --- | --- | --- | --- | --- |
| Merge request pipeline (`merge_request_event`) | the MR author | the source branch's | no ¹ | no |
| Bot pipeline: default branch, source `trigger` / `schedule` / `api` / `web` | the bot (it owns the trigger and the schedules; `api` pipelines are the queue's) | the default branch's; the MR head is checked out read-only by the review job | yes | only jobs in environment `dev-process-bot` ² |
| Candidate pipeline: branch `merge-queue/pr-N`, source `api` | the bot | default branch + the MR (only MRs the gate passed) | no (unprotected branch) | no ³ |
| Default branch push pipeline (after a merge) | the merger (the bot) | the merged configuration (reviewed) | yes | only jobs in the environment |

1. GitLab 18.1+ can give MR pipelines protected variables (`protect_merge_request_pipelines`, on by default for projects
   created on 18.1+) when the source and target branches are both protected; 17.11 may do so when a wildcard protected
   branch matches `refs/merge-requests/…`. Doctor reports a wildcard protected branch as an error and
   `protect_merge_request_pipelines` as a warning (it only matters when a source branch is protected too). **[M6]**
2. `DEV_PROCESS_TOKEN` is protected, masked and scoped to environment `dev-process-bot`; jobs that need it declare
   `environment: { name: dev-process-bot, action: access }`. Environment scope alone is not a boundary (a branch's job can
   name the environment), so the variable is also protected: branch and MR pipelines never get it.
3. The bot creates the candidate pipeline, so its jobs get a `CI_JOB_TOKEN` with the bot's rights, which can call the
   trigger API on the default branch. Bot jobs therefore refuse `CI_PIPELINE_SOURCE == "pipeline"`, take only an MR
   number from any payload or variable, and re-read everything from the API.

## Events

GitLab CI runs nothing on comments or approvals. Two ways in, both into a bot pipeline:

- **Webhook → pipeline trigger** (merge request and comment events; `TRIGGER_PAYLOAD` carries the body). No pipeline
  events: the trigger's own pipeline would send them and start another (a loop). A passing gate on a queued MR wakes the
  queue directly; an MR pipeline finishing reaches the queue through the poll. Fast,
  but self-managed GitLab blocks webhooks to its own address by default: an admin must allow requests to the local
  network (or allowlist the host). M6 used "allow requests to the local network"; the allowlist alone was not tried.
- **Scheduled poll** (bot-owned schedule; self-managed runs schedules every 10 minutes by default): re-judges open MRs,
  reviews heads that have neither a review nor a notice, runs the queue. Always on, also as the fallback for lost events.

`core/gitlab-events.mjs` maps an event to tasks. The bot's own events are ignored (each still costs one no-op
pipeline), except a retarget: when the bot merges a stacked MR's parent, GitLab retargets the child in the bot's name.

## Statuses are information, not enforcement

Any Developer can post a commit status, and a status named like a job retires that job **[M6]**. So:

- the gate's and the queue's statuses are attached by `ref` to the MR's source branch (an external pipeline), never to the
  MR pipeline that GitLab judges merges by;
- the queue reads CI verdicts from the builds of one pipeline (retried builds included, newest per name), never from
  statuses, and trusts only the bot's own statuses.

## Enforcement per tier

| | Free / CE | Premium | Ultimate |
| --- | --- | --- | --- |
| Who merges | the default branch is protected: push "No one", merge "Maintainer"; people are Developers; the bot is the only Maintainer and merges only through the queue after re-judging | same | same |
| Settings | Pipelines must succeed; All threads must be resolved | + reset approvals on push, no author / committer approval, Code Owner approval | + (later) external status check |
| Queue | self-built (`merge-queue/pr-N` from GitLab's merge ref) | self-built or merge trains | same |
| Bypass | any human Maintainer / Owner, instance admins — doctor warns about human Maintainers / Owners (a project always has an Owner) | same | same |

## The Claude review

- The review job (bot pipeline, no bot token, `ANTHROPIC_API_KEY` only) checks the MR head out into its own directory,
  computes the diff with git, and runs
  `claude --bare --restricted --strict-mcp-config -p --tools "Read,Grep,Glob" --permission-mode dontAsk --output-format json --json-schema <REVIEW_SCHEMA>`
  from that directory with a cleaned environment. `--bare`: no hooks, no CLAUDE.md discovery; `--restricted`: no
  settings files, file tools confined to the working directory (no `/proc/self/environ`); `--strict-mcp-config`: no
  project MCP servers.
- Its answer (one JSON object) goes to the posting job (environment `dev-process-bot`), which opens one thread per
  finding, writes the summary itself with the review marker as the last line, scrubs secrets and neutralizes mentions,
  references and quick actions (`noQuickActions` runs on every note and issue text the adapter writes: GitLab executes
  `/merge`, `/approve`, … at the start of a line, also for API notes).

## M6 results (GitLab CE 19.6.1, local, 2026-11-20)

Verified on a real instance:
- The setup (`apply-protection`) end to end, and idempotent: protected branch, settings, project access token
  (`project_<id>_bot_<32 hex>`), environment-scoped protected variable, bot-owned trigger and schedules, webhook with a
  masked `{token}` URL variable.
- Webhook → trigger → the bot's pipeline on the default branch with `TRIGGER_PAYLOAD`; the bot's own events end as
  no-ops.
- Commit statuses posted with `ref` = the source branch land on an external pipeline; the MR pipeline is untouched.
- The review pipeline (no key ⇒ notice; the gate quotes it); `post-review` against the real API: a DiffNote on the
  changed line, the summary with the marker, a `/merge` line in the model's text not executed.
- Waiver + approval (`approved_at` present on 19.x); sign-off; `wrong:` reply.
- The queue: `merge_ref` returns `commit_id`, parents [target, MR head]; a branch at that commit; the candidate pipeline
  runs as the bot with our variables; the bot merges with the sha; the merge commit cites `!N` and carries the waiver
  trailer; the candidate branch is deleted.
- GitLab's CI lint accepts both rendered files (`environment: action: access`, `resource_group`, `extends` lists,
  `workflow:rules:auto_cancel`).
- The scenarios: a docs-only MR (waiver + one approval); a medium MR whose AI thread blocks until a `wrong:` reply,
  then waits for "resolve"; a high-tier MR (sign-off + one other approval) that upgrades the process itself with the new
  plugin (only changed files re-rendered, the eval cases kept); a semantic-conflict pair (the second MR ejected when its
  candidate CI fails on top of the first); a stacked MR retargeted by GitLab after its parent merged (the note
  "deleted the `x` branch. This merge request now targets the `main` branch", an event in the bot's name, the gate and the
  review re-run, the notice re-posted after the base change).
- The weekly metrics from GitLab's data (merged MRs, tiers, `wrong:` replies, the waiver trailer, fix MRs) into an issue.
- `doctor --remote` against the instance: only the expected findings.

Not run (need an Anthropic API key): a real Claude review, the classifier, the nightly sweep, the review eval.

Found and fixed:
- Pending bot pipelines were auto-canceled as "redundant" whenever a merge moved the default branch: the bot's workflow
  rule now sets `auto_cancel: on_new_commit: none`.
- The queue tested candidates GitLab would refuse to merge (unresolved threads ⇒ 405 after a full CI run): it now waits
  on GitLab's `detailed_merge_status` blockers, and a refused merge names GitLab's reason.
- Texts that told GitLab users to re-run jobs (they can't re-run the bot's jobs): now "push again".
- Runners need two concurrent slots (the queue job waits while holding one).

Test-environment notes (not plugin issues): with `external_url` on `localhost`, webhooks resolve `::1`, so nginx must
listen on IPv6 too; a runner restart orphans a running job in "canceling" (force-cancel it).

## Checked after the M6 run (same instance, 2026-11-21)

- Statuses with `ref` = source branch land on an external pipeline; `/pipelines/:id/jobs` (also with
  `include_retried=true`) lists that pipeline's builds only: the generic statuses are not in it.
- The commit statuses list without `ref` returns statuses on every ref (the MR pipeline's jobs on
  `refs/merge-requests/N/head` and the bot's statuses on the source branch).
- `merge_ref`: `commit_id`, parents [target, MR head]; a branch can be created at that commit.
- Webhook payloads: `changes.target_branch` `{previous, current}`, `changes.labels` `{previous, current}` (label objects
  with `title`), `changes.draft` `{previous, current}` booleans. Pipeline events are no longer subscribed, so their
  `source` field no longer matters.
- Quick actions inside a fenced code block are not run (a note with `/label` and `/award` in a fence kept both lines and
  changed nothing).
- `environment: action: access` works; a job timeout above the project timeout is kept (the queue job ran with 200 min
  against the project's 60).

## Still unverified

- `TRIGGER_PAYLOAD` availability with 17.11's pipeline-variable restrictions (fixed in 18.5). M6 ran 19.6.1 only.
- Approval webhook actions on EE without a license; Premium and Ultimate paths (approval rules, code owners, reset on
  push) are covered by recorded API shapes only.
- Whether the outbound allowlist alone (without "allow requests to the local network") lets a webhook call the instance's
  own address.
- System note texts ("changed target branch from", "approved this merge request", "…now targets the…") on an instance
  whose default language is not English.
- Anything that needs a real Claude run: the review job's answer as the CLI prints it, the classifier, the nightly sweep
  and the review eval (M6 ran without an Anthropic API key; the review was simulated by posting a review object through
  `post-review`).
