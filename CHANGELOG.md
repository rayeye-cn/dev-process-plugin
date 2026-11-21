# Changelog

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
