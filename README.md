# dev-process

A Claude Code plugin that installs a **Claude-Code-team-style development and review process** into a new repository, modeled on *How the Claude Code team does code review* (claude.dev, 2026-10-15): most changes merge with at most one human in the loop, while revert and incident rates must not rise.

中文说明见 [README.zh.md](README.zh.md).

> **Status: pre-release (M2).** Installs on GitHub with GitHub Copilot as the reviewer and the built-in merge queue; not yet validated end to end on a real repository (M4). Claude as the reviewer, the native merge queue and GitLab come next.

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

- **Forges:** GitHub.com. Planned: GitHub Enterprise Server, self-managed GitLab (Free/CE, Premium, Ultimate; ≥ 17.11, tier detected, with what each tier can enforce stated in the generated docs).
- **AI reviewer:** GitHub Copilot. Planned: Claude (`anthropics/claude-code-action` on GitHub, a Claude CLI job on GitLab).
- **Merge queue:** the built-in queue. Planned: GitHub's native merge queue where the plan allows it, GitLab merge trains.
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
- [ ] M3 Claude reviewer on GitHub
- [ ] M4 End-to-end validation in a sandbox GitHub repository
- [ ] M5 Self-managed GitLab (all tiers)
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
