# dev-process

A Claude Code plugin that installs a **Claude-Code-team-style development and review process** into a new repository, modeled on *How the Claude Code team does code review* (claude.dev, 2026-10-15): most changes merge with at most one human in the loop, while revert and incident rates must not rise.

中文说明见 [README.zh.md](README.zh.md).

> **Status: 1.1.1** (role agents, a pilot). Installs on GitHub (GitHub Copilot or Claude as the reviewer) and on GitLab 17.11+ (Claude), both with the built-in merge queue. Some paths have not run end to end yet, notably a real Claude review: see [What has been validated](#what-has-been-validated).

## What it installs

| Layer | What you get |
| --- | --- |
| Before the PR | `CLAUDE.md` conventions: run the checks and show output, `/code-review` (and `/security-review` on sensitive paths), keep PRs small, "you land it, you own it" |
| AI review on every PR/MR | GitHub Copilot code review **or** Claude (`anthropics/claude-code-action` on GitHub, a Claude CLI job on GitLab), steered by repo instruction files |
| Risk gate | A required check that sets a risk tier from changed paths (an AI classifier may only raise it) and requires: a real AI review of the head commit, author sign-off, N human approvals on the head by tier, every AI thread answered (`fixed:` / `wrong:` / `intended:` / `wontfix:`) |
| Merge queue | A built-in queue that re-tests each change on top of the latest default branch before merging (GitHub's native merge queue and GitLab merge trains are planned) |
| Protection | Ruleset / protected branch applied **last**, after a test PR passes |
| CI | Fast checks on hosted runners, full tests optionally on self-hosted runners, non-fork only |
| Loop | Nightly AI sweep that files issues, a review eval that replays past bugs, weekly metrics |
| Release and operations | Staged rollout and on-call docs, an incident review template |

## Supported

- **Forges:** GitHub.com; GitLab 17.11+ (self-managed or gitlab.com; Free/CE, Premium, Ultimate; tier detected, with what each tier can enforce stated in the generated docs; design in `docs/design/gitlab.md`). Planned: GitHub Enterprise Server.
- **AI reviewer:** GitHub Copilot, or Claude (GitHub: `anthropics/claude-code-action` in a generated workflow, needs `ANTHROPIC_API_KEY` and the Claude GitHub app; GitLab: a read-only Claude Code job whose findings the process bot posts).
- **Merge queue:** the built-in queue (on GitLab it builds candidates from GitLab's own merge ref). Planned: GitHub's native merge queue where the plan allows it, GitLab merge trains.
- **Language:** Chinese or English, chosen at init.

## Install

The repository is private: you need read access and git credentials that work without a prompt (SSH agent, or `gh auth setup-git`). Details, updates, pinning a version and team setup: [docs/install.md](docs/install.md).

```
/plugin marketplace add rayeye-cn/dev-process-plugin
/plugin install dev-process@dev-process-plugin
```

Then, in the repository to set up: `/dev-process:init`.

## Role agents (1.1, pilot)

Optionally, each participant's computer can run a **role agent**: a scheduled job that picks up the GitHub issues assigned to that person for their role (product, UI, engineering, marketing…), works on them with Claude Code and hands them on to the next role. The model gets no GitHub credential and runs in a sandbox; a deterministic runner does every write under the person's login, and the review process stays the human gate (sign-off, approvals, merges, releases and publishing are always people). Set it up per machine with `/dev-process:agent`; the team, roles and hand-offs live in `.dev-process/team.json`. Design and the safety checks run so far: [docs/design/agents.md](docs/design/agents.md). GitHub only for now; macOS, or Windows for roles that don't run commands (no sandbox on native Windows); run end to end on a throwaway repository, the first real pilot is next.

## What has been validated

Every path has unit tests (577), with API responses written from each forge's documentation. End to end:

- **GitLab** (CE 19.6.1, Free, in Docker): the setup (`apply-protection`, idempotent), webhook → trigger → gate, the review job's notice without a key, posting a review (a diff thread on the changed line, the summary with the marker, quick actions in the text not run), waiver and approval, sign-off, a `wrong:` reply then "resolve", the queue (candidate from GitLab's merge ref, CI as the bot, merge by sha), a semantic conflict ejected by the queue, a stacked MR retargeted by GitLab, a process upgrade MR, weekly metrics, `doctor --remote`. Details: [docs/design/gitlab.md](docs/design/gitlab.md).
- **GitHub** (private sandbox, Team plan): init PR rendered and merged, the ruleset applied, the no-key notice quoted by the gate, the queue waiting on an unsatisfied gate, a retarget re-running the Claude review job and moving the tier label.

Not run yet:

- A real Claude review, the AI classifier, the nightly sweep and the review eval (both forges): no Anthropic API key in the test setups.
- GitHub: a PR passing the gate and merged by the queue (needs a real review and a second account); the Copilot path; the Claude GitHub App's behavior.
- GitLab: versions other than 19.6.1 (17.11's `TRIGGER_PAYLOAD` restriction in particular), Premium and Ultimate (unit tests only), an instance whose default language is not English.

## Roadmap

- [x] M0 Repository skeleton, manifests, CI
- [x] M1 Engine extracted from the reference implementation (GitHub, Copilot, Chinese)
- [x] M2 English catalog, bilingual templates, deterministic renderer, `init`, `doctor` and `upgrade` skills (GitHub + Copilot + built-in queue)
- [x] M3 Claude reviewer on GitHub (review workflow, reviewer adapter, notices)
- [~] M4 End-to-end validation in a sandbox GitHub repository (partial, see above)
- [x] M5 GitLab, all tiers (forge adapter, bot pipelines on the default branch, Claude review job, queue, setup, doctor; review eval included)
- [~] M6 End-to-end validation on GitLab (partial, see above)
- [x] M7 v1.0.0
- [ ] Later: the runs that need an API key; GitHub's native merge queue; GitLab merge trains and Ultimate external status checks; GitHub Enterprise Server

## Development

```
npm test          # node:test, zero dependencies (Node ≥ 24)
npm run validate  # claude plugin validate --strict .
claude --plugin-dir .   # load the plugin for one session
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
