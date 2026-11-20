---
name: upgrade
description: Re-render the dev-process files of a repository with the installed plugin version and its saved answers (or changed answers), showing exactly what changes and never overwriting files people edited without asking. Use when the user asks to upgrade, update or re-render the installed review process, or to change its configuration (people, paths, reviewer, language, loops).
when_to_use: The user runs /dev-process:upgrade, or asks to update the installed dev process to the latest plugin version or to change its answers.
disable-model-invocation: true
argument-hint: "[repository path, default: current directory]"
---

# dev-process: upgrade

`<repo>` is the repository (the argument, or the current directory); `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`. Talk to the user in their language.

1. `<repo>/.dev-process/answers.json` must exist (otherwise offer `/dev-process:init`). Compare `<repo>/.dev-process/VERSION` with `<plugin>/.claude-plugin/plugin.json` `version` and tell the user both.
2. If the user wants to change answers (people, paths, reviewer, language, loops, CI), edit `answers.json` with them first (its fields are documented in `<plugin>/tools/answers.mjs`).
3. Plan: `node <plugin>/tools/render.mjs --answers <repo>/.dev-process/answers.json --target <repo>`.
   - `update`: files the plugin generated and nobody edited — safe.
   - `conflict`: files someone edited since the last render. Show the difference and ask per file: keep theirs (stop and fold the change into the answers instead) or replace (`--force <path>`).
   - `remove`: outputs no longer needed (e.g. the queue workflow after switching to a native queue), untouched — deleted. `orphan`: same but edited — left alone; mention them.
4. On a branch (`git -C <repo> switch -c dev-process/upgrade`), write: same command with `--write` (plus approved `--force`), then `node <repo>/.dev-process/engine/cli/doctor.mjs` and show `git -C <repo> diff --stat`.
5. Commit (project language), ask before pushing and opening the pull request. Changes to `.github/**`, `CLAUDE.md` and `.dev-process/**` are high-risk by design: the gate will ask for the author's sign-off and another person's approval — the humans do that, never Claude.
6. If the required checks changed (CI jobs, release gate, queue mode), the branch protection must follow after the PR merges: `apply-protection --dry-run`, then for real with the user's yes. Finish with `doctor --remote`.
