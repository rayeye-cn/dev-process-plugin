# GitLab design (M5)

GitLab self-managed 17.11+ and gitlab.com, every tier (CE, EE without a license, Premium, Ultimate). Facts marked
**[M6]** come from the documentation or GitLab's source but have not been run on a real instance yet; the GitLab CE E2E
(M6) checks each one.

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
   branch matches `refs/merge-requests/…`. Doctor reports either as an error. **[M6]**
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
  network (or allowlist the host) **[M6: does the allowlist cover the instance itself?]**.
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
| Bypass | any human Maintainer / Owner, instance admins — doctor reports human Maintainers as errors | same | same |

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

## Unverified until M6

- Commit status with `ref` = source branch lands on an external / branch pipeline and leaves the MR pipeline alone.
- `/pipelines/:id/jobs` lists builds only (no generic statuses).
- `GET …/merge_ref` response field and parent order.
- Webhook payload shapes (`changes.target_branch`, `changes.draft`, `changes.labels`, pipeline `source`).
- `TRIGGER_PAYLOAD` availability with 17.11's pipeline-variable restrictions (fixed in 18.5).
- Approval webhook actions on EE without a license.
- Quick actions are not run inside fenced code blocks.
- The commit statuses list without `ref` also returns statuses attached to other refs (the gate status, the classifier
  status and the write-skipping all read through it).
- Creating a branch at the merge-ref commit; `environment: action: access`; job timeouts above the project timeout.
- System note texts ("changed target branch from", "approved this merge request", "…now targets the…") on an instance
  whose default language is not English.
