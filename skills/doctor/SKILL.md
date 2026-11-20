---
name: doctor
description: Check that the dev-process installed by /dev-process:init is complete and wired correctly — configuration consistency (CODEOWNERS, review instructions, CLAUDE.md), the workflows the configuration needs, hand edits to the vendored engine, and on GitHub the branch protection and required checks and the reviewer's secrets. Use when the user asks whether the review process is set up correctly or why the gate or queue misbehaves.
when_to_use: The user runs /dev-process:doctor, or asks to check, diagnose or verify the installed review process, risk gate or merge queue.
argument-hint: "[repository path, default: current directory]"
---

# dev-process: doctor

`<repo>` is the repository (the argument, or the current directory). Talk to the user in their language.

1. Make sure it is installed: `<repo>/.dev-process/config.json` exists. If not, offer `/dev-process:init`.
2. Run `node <repo>/.dev-process/engine/cli/doctor.mjs --remote` (GitHub: needs `gh auth status`; GitLab: the user runs it with `GITLAB_TOKEN` set, adding `--repo <group/name>` — in their own terminal, or with `!` only when the value comes from command substitution of `glab auth token`; never ask for the token in the conversation; without access run it without `--remote` and say the remote half was skipped). Findings print in the project language; exit code 1 means at least one error.
3. For each finding, explain what it means and the fix:
   - consistency findings: edit `<repo>/.dev-process/answers.json` (high/security/low paths, people) and re-render with `/dev-process:upgrade` — never hand-edit CODEOWNERS or the instruction files' front matter, they mirror the configuration;
   - a missing or extra workflow: re-render;
   - a hand-edited engine: the change will conflict on the next upgrade — move it into the configuration or propose it to the plugin;
   - no ruleset yet: expected until a test pull request shows every required check; then `apply-protection` (the user's call, admin rights);
   - ruleset drift: re-run `apply-protection` after the user agrees;
   - a missing secret: the repository admin adds it in Settings → Secrets and variables → Actions.
   - GitLab setup items (protection, settings, the bot token variable, trigger, schedules, webhook): re-run `apply-protection` with the user's yes (its `--dry-run` shows the same list); a refused webhook needs a GitLab admin to allow webhooks to the local network; human Maintainers must become Developers (on Free they can merge past the gate); a bot token close to expiry must be rotated and `DEV_PROCESS_TOKEN` updated;
   - the Claude GitHub App missing (Claude reviewer): an organization admin installs it from github.com/apps/claude, selecting at least this repository; doctor cannot see which repositories a "selected" installation covers, so if review jobs still fail with a token error, check that list.
4. If the user reports a red gate on a pull request, read the gate's sticky comment on that PR ("still missing" list) and explain each item. Never post `/signoff` or waiver commands, never approve, never hand-post statuses to turn it green.
