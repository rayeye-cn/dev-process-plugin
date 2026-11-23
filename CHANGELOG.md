# Changelog

## 1.1.2 (2026-11-23)

- Role agents, setup on macOS: re-running setup while the watch trigger is running failed once with "Bootstrap failed:
  5" (the kept-alive watcher had not stopped yet). Setup now waits for the old job to stop, and retries the load once.

## 1.1.1 (2026-11-23)

- Role agents, comment mode: the issue comment now also shows the commands the agent ran and their results (or that it
  reported none), its questions, its hand-off notes and any refused commands, so a run can be judged without opening
  anything.
- After updating the plugin, run `/dev-process:agent` setup again on each machine: the scheduled job runs the engine
  copied at install time.

## 1.1.0 (2026-11-22)

Role agents (pilot, GitHub; macOS and Windows). Each participant's computer runs a scheduled job that picks up the issues assigned
to that person for their role, works on them with Claude Code and hands them on to the next role; the review process
stays the human gate. Design and the safety checks run on a Mac: `docs/design/agents.md`.

- `/dev-process:agent`: set up, check, pause, resume or remove the job on this machine (`tools/agent-install.mjs`:
  a LaunchAgent on macOS, a Task Scheduler task on Windows; the Claude token, created by the person in their own
  terminal, stays in the macOS keychain or a DPAPI-encrypted file on Windows).
- `.dev-process/team.json` (from the answers' new `team` section, read from the default branch only): people and roles,
  allowed hand-offs, each role's writable paths, tools, allowed commands, setup commands and model, accounts never to
  notify. Each role's instructions are seeded once in `.dev-process/agents/<role>.md` (product, UI, engineering,
  marketing, or a generic one).
- The runner (`engine/cli/agent-run.mjs`): the model gets no GitHub credential — `claude --restricted` with dontAsk and
  the role's allowlist, a sandbox the model cannot switch off (credential paths and the keychain unreachable from it), a clean environment and its own config
  directory, structured output; the runner does every write under the person's login (claim, commit, push, pull
  request, labels, assignment), refuses changes to the review process files, strips mentions, references, hidden
  markers and command lines from model text. A "comment" mode commits nothing.
- Assignment, not self-claiming: issues without a role go to the triage role's person; hand-offs assign the next role's
  person. Low-tier agent pull requests can be queued automatically (`autoQueueLow`); medium / high remind the author to
  sign off.
- The project lead's machine posts a daily and a weekly report to a fixed issue.
- The person installing chooses for their machine: repositories, the trigger (`--trigger watch` starts work within about
  a minute of an issue becoming ready, `schedule` every N minutes), which of their roles run there (`--roles`), mode,
  interval, model (`--model`), and on Windows the unsandboxed opt-in.
- `apply-protection` (GitHub) creates the role and status labels when the team file exists.
- Windows: the token in a DPAPI-encrypted file, a Task Scheduler task, `claude.exe` resolution; roles without Bash by default
  (no sandbox on native Windows); `--unsandboxed` lets a person run Bash roles there after accepting the risk (each PR
  says so). `store-token` / `forget-token` on both platforms.

Run end to end on a private throwaway repository (chains across all roles, stacked PRs, a stop for a person and the
continuation, launchd); details in the design doc. Not yet: a large repository's engineering task (setup and cost),
GitLab, the marketing role across repositories, a real run on a colleague's Windows machine.

## 1.0.0 (2026-11-20)

First release. Installs a Claude-Code-team-style development and review process into a repository.

- **Forges:** GitHub.com; GitLab 17.11+ (self-managed or gitlab.com), every tier, detected at init.
- **AI reviewer:** GitHub Copilot or Claude on GitHub (`anthropics/claude-code-action`); Claude on GitLab (a read-only
  Claude Code job whose findings the process bot posts).
- **Language:** Chinese or English, chosen at init.
- **Skills:** `/dev-process:init`, `/dev-process:doctor`, `/dev-process:upgrade`.
- **Installed into the repository:** `CLAUDE.md` conventions, AI review instructions, PR / MR template with author
  sign-off, CODEOWNERS, the risk gate (tier from paths, an AI classifier that may only raise it, review, sign-off,
  approvals and thread answers per tier), the built-in merge queue, branch protection (GitHub ruleset; GitLab protected
  branch, settings, bot token, trigger, webhook and schedules), CI, the nightly sweep, the review eval, weekly metrics,
  release and on-call docs. The engine is vendored into `.dev-process/engine` (Node 24+, no dependencies).

Not in 1.0.0: GitHub's native merge queue, GitLab merge trains, GitLab Ultimate external status checks, GitHub
Enterprise Server (rendering refuses the queue modes that are not built yet; `init` stops on hosts other than github.com and GitLab).

Not run end to end before this release (unit-tested only):

- a real Claude review, the AI classifier, the nightly sweep and the review eval, on both forges (no Anthropic API key
  in the test setups);
- GitHub: a pull request that passes the gate and is merged by the queue, the Copilot path, the Claude GitHub App;
- GitLab: versions other than CE 19.6.1, Premium and Ultimate, instances whose default language is not English.

What did run is listed in the README ("What has been validated") and in `docs/design/gitlab.md` ("M6 results").
