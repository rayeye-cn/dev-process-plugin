---
name: init
description: Install a Claude-Code-team-style development and review process into a repository — CLAUDE.md conventions, AI review (GitHub Copilot or Claude), a tiered risk gate with author sign-off, a merge queue, branch protection, CI, nightly AI sweep, review eval and weekly metrics, in Chinese or English. Use when the user asks to set up, initialize or adopt this development/review process for a project.
when_to_use: The user runs /dev-process:init, or asks to set up the Claude Code team's review process, risk gate, merge queue or "the dev process" in a repository.
disable-model-invocation: true
argument-hint: "[repository path, default: current directory]"
---

# dev-process: init

Install the process into one repository, end to end: detect → confirm answers with the user → render → verify → open a pull request → walk the admin through enabling it. Talk to the user in their language (the language they write to you in), regardless of the project language you configure.

The plugin's files are at `${CLAUDE_PLUGIN_ROOT}`. In the commands below, `<repo>` is the absolute path of the repository (the argument, or the current directory) and `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`.

## Hard rules

- Never post `/signoff` or the AI-review waiver command, never approve a pull request, never hand-post commit statuses — those are the humans' accountability, also during setup.
- Never overwrite a file the user wrote (a render "conflict") without the user's explicit yes for that path.
- Never enable branch protection (`apply-protection`) before a test pull request shows every required check reporting, and never without the user's explicit yes: it blocks every PR if a check never reports.
- Work on a branch, never on the default branch. Ask before pushing and before opening the pull request.

## 1. Preconditions

Run and check:
- `git -C <repo> rev-parse --show-toplevel` (a git repository) and `git -C <repo> remote get-url origin`.
- `node --version` is 24 or newer (the engine uses `fetch` and `path.matchesGlob`).
- `gh auth status` (GitHub). If not logged in, ask the user to run `! gh auth login` themselves.

Only github.com is supported in this version. If the remote's host is anything else — a GitLab instance (self-managed GitLab often has a host name without "gitlab" in it) or GitHub Enterprise Server — tell the user that support for their host is in development and stop.

## 2. Detect

`node <plugin>/tools/detect.mjs --target <repo> --remote`

It prints `{ facts, proposal }`. `proposal` has the answers shape (see `<plugin>/tools/answers.mjs`, whose header documents every field). If `facts.existing.devProcess` is true, the repository is already set up: offer `/dev-process:upgrade` (same answers, newer plugin) or continue with the existing `<repo>/.dev-process/answers.json` as the starting point to change answers.

## 3. Confirm the answers with the user

Show the proposal as a short summary, then ask (AskUserQuestion, at most 4 questions per call, recommended option first):

1. **Project language** (zh / en) for everything the team reads: CLAUDE.md, PR template, review instructions, gate comments, docs. Default: `facts.language`.
2. **AI reviewer**: GitHub Copilot code review. It needs the organization's Copilot code review policy: reviews without a license, billed to the organization, an AI-credit budget above zero — reviews cost money, say so. **In this version Copilot is the only reviewer**; Claude as the reviewer arrives in the next version (the renderer refuses `reviewer: "claude"` until then — tell the user if they ask).
3. **Merge queue**: `self` — the built-in queue that re-runs CI on the latest default branch before merging. The forge's native merge queue is not supported yet even where `facts.remote.nativeQueue` is true (the renderer refuses `queue.mode: "native"`); mention it as a later option when it applies.
4. **Loops** (multi-select): AI risk classifier (second opinion, can only raise a tier), nightly AI sweep (needs security paths), review eval (replays past bugs weekly), weekly metrics.

Then, in follow-up questions or plain conversation:
- **People**: trusted authors (proposal: collaborators with write access), code owners (two or more, so nobody approves their own PR), on-call rotation. Logins only, no emails.
- **Paths**: high (always need a human), security (security checklist + nightly sweep), low-only (docs; zero-person merges allowed). Never put `CLAUDE.md` or process files in low-only; the renderer adds `.github/**`, `CLAUDE.md`, `.dev-process/**` to high by itself.
- **Project-specific review lines** (optional, 0–5 each): "what breaking looks like here" (`failureModes`) and security checklist lines (`securityChecklist`). Offer to draft them from the code you've seen; the user confirms.
- **CI**: the proposed setup / checks / tests steps; tests on hosted or self-hosted runners (labels); an optional heavy release gate (steps, runner) that only runs on release PRs (label `release` or a version bump).

Write the confirmed answers to `<repo>/.dev-process/answers.json` (pretty JSON).

## 4. Plan the render

`node <plugin>/tools/render.mjs --answers <repo>/.dev-process/answers.json --target <repo>`

- Exit 2: an answers error naming the field — fix it with the user and retry.
- The plan lists each file as create / update / insert (CLAUDE.md gets a marked section, the rest of the file is untouched) / conflict / unchanged.
- Exit 3 (conflicts): existing files the plugin would replace (e.g. an existing CODEOWNERS or PR template). For each, show the user what is there and ask: replace it (then pass `--force <path>`), or keep theirs and stop to adjust. CODEOWNERS must mirror the high paths exactly (a consistency check enforces it) — if they keep their own, add its patterns to the high paths instead.

## 5. Render on a branch

```
git -C <repo> switch -c dev-process/init
node <plugin>/tools/render.mjs --answers <repo>/.dev-process/answers.json --target <repo> --write [--force <paths the user approved>]
node <repo>/.dev-process/engine/cli/doctor.mjs
```

Exit 4 or doctor errors: explain each finding (they are printed in the project language) and fix the answers, then re-render. Warnings that are expected on a new repository (a path rule that matches no file yet, a one-person team) can stay — say why.

## 6. Commit and open the pull request

Commit in three topic commits, messages in the project language:
1. Conventions and review instructions: `CLAUDE.md`, the PR template, the AI review instruction files, `CODEOWNERS`, `.dev-process/config.json`, `.dev-process/answers.json`, `.dev-process/VERSION`, `.dev-process/render-lock.json`, `.dev-process/engine/`.
2. CI, risk gate and merge queue: `.github/workflows/ci.yml`, `risk-gate.yml`, `risk-gate-events.yml`, `merge-queue.yml`.
3. Loops and docs: the remaining workflows, `docs/dev-process/`, `docs/incident-review-template.md`, the review-eval files.

Ask before `git push -u origin dev-process/init` and before `gh pr create`. The PR body (project language) says what was installed, links `docs/dev-process/review-setup.md`, and lists the admin steps below. This first PR is not judged by the gate (the gate workflows run from the default branch, where they don't exist yet) — say so; it needs a normal human review.

## 7. After it merges: enable it, in order

Walk the user through `docs/dev-process/review-setup.md`:
1. Reviewer setup (Copilot policies and budget, or the `ANTHROPIC_API_KEY` secret and the Claude GitHub App).
2. Self-hosted runners, if configured.
3. A test pull request: every required check (`checks`, `tests`, the release gate when present, `risk-gate`, and `merge-queue` after adding the queue label) shows a result.
4. Only then, with the user's yes: `node <repo>/.dev-process/engine/cli/apply-protection.mjs --dry-run`, show the output, then without `--dry-run` (needs repository admin). The engine reads the token from `GH_TOKEN`: when the user runs it themselves, tell them to pass their `gh auth token` output as `GH_TOKEN` to `node .dev-process/engine/cli/apply-protection.mjs` (prefix the command with `!` in this session).
5. `node <repo>/.dev-process/engine/cli/doctor.mjs --remote` — everything green.

End with a short summary of what is enforced now, what still depends on the admin steps, and that `/dev-process:doctor` re-checks the setup any time.
