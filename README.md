# dev-process

A Claude Code plugin that installs a **Claude-Code-team-style development and review process** into a new repository, modeled on *How the Claude Code team does code review* (claude.dev, 2026-10-15): most changes merge with at most one human in the loop, while revert and incident rates must not rise.

中文说明见 [README.zh.md](README.zh.md).

> **Status: pre-release (M5).** Installs on GitHub (GitHub Copilot or Claude as the reviewer) and on GitLab 17.11+ (Claude), both with the built-in merge queue. GitHub is partly validated on a sandbox repository (M4: the Claude-review scenarios wait for an API key); GitLab is unit-tested against the documented API and waits for its end-to-end run (M6). The native merge queue and GitLab merge trains come later.

## What it installs

| Layer | What you get |
| --- | --- |
| Before the PR | `CLAUDE.md` conventions: run the checks and show output, `/code-review` (and `/security-review` on sensitive paths), keep PRs small, "you land it, you own it" |
| AI review on every PR/MR | GitHub Copilot code review **or** Claude (`anthropics/claude-code-action` on GitHub, a Claude CLI job on GitLab), steered by repo instruction files |
| Risk gate | A required check that sets a risk tier from changed paths (an AI classifier may only raise it) and requires: a real AI review of the head commit, author sign-off, N human approvals on the head by tier, every AI thread answered (`fixed:` / `wrong:` / `intended:` / `wontfix:`) |
| Merge queue | GitHub native merge queue where available, GitLab merge trains on Premium+, otherwise a self-built queue that re-runs CI on the updated branch before merging |
| Protection | Ruleset / protected branch applied **last**, after a test PR passes |
| CI | Fast checks on hosted runners, full tests optionally on self-hosted runners, non-fork only |
| Loop | Nightly AI sweep that files issues, a review eval that replays past bugs, weekly metrics |
| Release and operations | Staged rollout and on-call docs, an incident review template |

## Supported

- **Forges:** GitHub.com; GitLab 17.11+ (self-managed or gitlab.com; Free/CE, Premium, Ultimate; tier detected, with what each tier can enforce stated in the generated docs; design in `docs/design/gitlab.md`). Planned: GitHub Enterprise Server.
- **AI reviewer:** GitHub Copilot, or Claude (GitHub: `anthropics/claude-code-action` in a generated workflow, needs `ANTHROPIC_API_KEY` and the Claude GitHub app; GitLab: a read-only Claude Code job whose findings the process bot posts).
- **Merge queue:** the built-in queue (on GitLab it builds candidates from GitLab's own merge ref). Planned: GitHub's native merge queue where the plan allows it, GitLab merge trains.
- **Language:** Chinese or English, chosen at init.

## Install (once released)

```
/plugin marketplace add rayeye-cn/dev-process-plugin
/plugin install dev-process@dev-process-plugin
```

Then, in the repository to set up: `/dev-process:init`.

## Roadmap

- [x] M0 Repository skeleton, manifests, CI
- [x] M1 Engine extracted from the reference implementation (GitHub, Copilot, Chinese)
- [x] M2 English catalog, bilingual templates, deterministic renderer, `init`, `doctor` and `upgrade` skills (GitHub + Copilot + built-in queue)
- [x] M3 Claude reviewer on GitHub (review workflow, reviewer adapter, notices)
- [ ] M4 End-to-end validation in a sandbox GitHub repository
- [x] M5 GitLab, all tiers (forge adapter, bot pipelines on the default branch, Claude review job, queue, setup, doctor; the review eval is not ported yet)
- [ ] M6 End-to-end validation on GitLab
- [ ] M7 v1.0.0

## Development

```
npm test          # node:test, zero dependencies (Node ≥ 24)
npm run validate  # claude plugin validate --strict .
claude --plugin-dir .   # load the plugin for one session
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
