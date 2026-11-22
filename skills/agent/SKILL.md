---
name: agent
description: Set up, check, pause or remove this machine's role agent (macOS or Windows) — the scheduled job that picks up the GitHub issues assigned to you for your role (product, UI, engineering, marketing…), works on them with Claude Code and hands them on to the next role, with the repository's review process as the human gate. Use when the user wants their computer to take issues automatically, or asks about the agent's status, logs, pausing or removing it.
when_to_use: The user runs /dev-process:agent, or asks to set up, check, pause, resume or remove the role agent on this machine.
disable-model-invocation: true
argument-hint: "[setup | status | pause | resume | run-now | remove] [owner/name …]"
---

# dev-process: role agent on this machine

`<plugin>` is `${CLAUDE_PLUGIN_ROOT}`. `<repo>` is each repository the user names (`owner/name`), or the current directory's GitHub origin. Talk to the user in their language. Design and limits: `<plugin>/docs/design/agents.md`.

## Hard rules

- Never ask for, print or store the Claude token or any GitHub token in the conversation. The person creates the Claude token in their OWN terminal (not with `!` here, which would show it in the conversation). You only check that it exists, with the check command below, which never prints it.
- Set up only this machine, for the person logged in to `gh` here. Never install on anyone else's behalf.
- Never edit `.dev-process/team.json` on the default branch or push it: joining the team is a pull request the team reviews (it is a high-risk path).
- Never post `/signoff` or the waiver command, never approve, never add the merge-queue label by hand for the agent.
- macOS or Windows (on Linux, say it is not supported yet and stop). On Windows, by default only roles without Bash run (product, UI, marketing as usually set up): Claude Code has no sandbox on native Windows. A role that runs commands (engineering) runs there only if the person explicitly accepts running it unsandboxed (setup step 2); never turn that on for them.

## setup

1. Run `node <plugin>/tools/agent-install.mjs check --repo <repo>` (one `--repo` per repository) and show the result. Fix each ✗ with the user:
   - **gh logged in** / **git can read without a prompt**: the user runs `gh auth login`, then `gh auth setup-git` (they may type them with `!` here; neither prints a token).
   - **Claude token stored for the agent**: the user, in their own terminal (not with `!` here: it would show the token in the conversation), runs `claude setup-token` and copies the token it prints (it starts with `sk-ant-oat`). Then run `node <plugin>/tools/agent-install.mjs store-token`: it reads the token from the clipboard, stores it (macOS: the login keychain; Windows: a file encrypted for this Windows user with DPAPI) and prints only its length. Ask the user to copy something else afterwards to clear the clipboard. The token uses their own Claude plan and lasts a year.
   - **Claude Code installed** (Windows): it finds `claude.exe` on PATH, beside the npm shim, or in `%USERPROFILE%\.local\bin` (the native installer's place). Git for Windows and the GitHub CLI must be installed too.
   - **roles this machine can run** (Windows): roles with Bash are left for a Mac; if none of the person's roles can run here, stop and say so.
   - **roles for <login>**: the person is not in `.dev-process/team.json` on the default branch (or the file is missing). The team lead adds them (login and roles) in a pull request; the agent starts working once it is merged. Do not change the file yourself.
   - **can push branches**: a repository admin gives them Write access (pushing to the default branch stays blocked by the branch protection).
2. **Let the person choose.** Everything below is their decision for their own machine; offer defaults, never decide for them. Ask with AskUserQuestion (several questions in one call where they fit):
   - **Repositories**: the ones from step 1; ask whether to add others where they have a role.
   - **Roles on this machine** (multiSelect): their roles from check (`roles for <login>`). Default all; someone who also has a second computer may run some roles there instead. Becomes `--roles a,b` (omit when all are chosen).
   - **Without the sandbox** (Windows only, only when a chosen role uses Bash — check lists it under "roles this machine can run"): explain plainly first, then ask; the first option is **no** (that role stays on a Mac). What yes means: the commands and test scripts the agent edits run as them, can read their credentials (GitHub login, files) and reach the network; the allowlist only limits what the model runs directly; every PR the agent opens says it ran unsandboxed. Hardening option: a separate Windows user account just for the agent. Only on an explicit yes add `--unsandboxed`; Git for Windows must be installed (the Bash tool and npm scripts use its bash). On no, drop those roles from `--roles`.
   - **Mode**: `comment` (recommended at first: the agent works and posts what it would do as a comment; nothing is committed) or `full` (it pushes branches, opens pull requests and hands issues on).
   - **Trigger**: `watch` (recommended: a small process stays running and starts work within about a minute when an issue becomes ready for them — conditional requests, so waiting costs no rate limit and no Claude use; a full check still runs every N minutes) or `schedule` (a run every N minutes, nothing stays running). Becomes `--trigger watch|schedule`.
   - **How often** (schedule: every N minutes; watch: the full check every N minutes): 10 (schedule default), 15, 30 (watch default).
   - **Model**: the team's setting (default: the role's model, else their account's default), `sonnet` (cheaper) or `opus` (stronger). Their own Claude plan pays. Becomes `--model <name>` (omit for the team's setting).
3. Repeat the choices back in one short list and ask nothing more unless something is unclear.
4. Install: `node <plugin>/tools/agent-install.mjs install --repo <repo> --mode <mode> --trigger <trigger> --interval <minutes>` plus `--roles …`, `--model …`, `--unsandboxed` as chosen. It copies the engine to the agent folder (`.dev-process/agent` in the home folder), writes the config and the scheduled job — macOS: a LaunchAgent; Windows: a Task Scheduler task "dev-process-agent" (it tries a windowless start first and falls back to a hidden PowerShell window, saying which) — and loads it. It runs only while the user is logged in and the machine is awake. To change a choice later, run setup again: it replaces the config and the job.
5. Prove it: `node <plugin>/tools/agent-install.mjs run-now`, wait about a minute, then `node <plugin>/tools/agent-install.mjs status` and show the last log lines. With no issue assigned to them and marked `agent:ready`, "noTask" is the expected result.
6. Tell the user how work reaches their agent: an issue assigned to them with their role label (`role:<role>`) and the `agent:ready` label added by a team member. Issues without a role go to the triage role's person. When the agent needs them, it adds `agent:blocked` and assigns the issue to them; adding `agent:ready` again continues.

## status, pause, resume, run-now, remove

- `node <plugin>/tools/agent-install.mjs status` — loaded or paused, the config, the last log lines (logs live in `~/.dev-process/agent/logs/`).
- `pause` / `resume` — stop or restart the scheduled job (the config stays).
- `run-now` — one run immediately.
- `uninstall` (remove) — removes the scheduled job; the clones and logs in the agent folder stay. The stored Claude token stays until `node <plugin>/tools/agent-install.mjs forget-token`.

After an update of this plugin, run setup again so the job uses the new engine.
