---
name: agent
description: Set up, check, pause or remove this machine's role agent — the scheduled job that picks up the GitHub issues assigned to you for your role (product, UI, engineering, marketing…), works on them with Claude Code and hands them on to the next role, with the repository's review process as the human gate. Use when the user wants their computer to take issues automatically, or asks about the agent's status, logs, pausing or removing it.
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
- macOS only for now (Windows comes later): on another OS, say so and stop.

## setup

1. Run `node <plugin>/tools/agent-install.mjs check --repo <repo>` (one `--repo` per repository) and show the result. Fix each ✗ with the user:
   - **gh logged in** / **git can read without a prompt**: the user runs `gh auth login`, then `gh auth setup-git` (they may type them with `!` here; neither prints a token).
   - **Claude token in the keychain**: the user, in their own terminal, runs `claude setup-token`, copies the token it prints (it starts with `sk-ant-oat`), then runs this line, which reads the token from the clipboard:
     `` security add-generic-password -U -a "`whoami`" -s dev-process-agent-claude -w "`pbpaste`" ``
     then copies something else to clear the clipboard. If check says the stored value is not a token, they pasted something else: repeat. The token uses their own Claude plan and lasts a year.
   - **roles for <login>**: the person is not in `.dev-process/team.json` on the default branch (or the file is missing). The team lead adds them (login and roles) in a pull request; the agent starts working once it is merged. Do not change the file yourself.
   - **can push branches**: a repository admin gives them Write access (pushing to the default branch stays blocked by the branch protection).
2. Ask, with AskUserQuestion:
   - **Mode**: `comment` (recommended at first: the agent works and posts what it would do as a comment, and nothing is committed) or `full` (it pushes branches, opens pull requests and hands issues on).
   - **How often**: every 10 minutes (default), 15 or 30.
3. Install: `node <plugin>/tools/agent-install.mjs install --repo <repo> --mode <mode> --interval <minutes>`. It copies the engine to `~/.dev-process/agent/`, writes the config and the LaunchAgent, and loads it. It runs only while the user is logged in and the machine is awake.
4. Prove it: `node <plugin>/tools/agent-install.mjs run-now`, wait about a minute, then `node <plugin>/tools/agent-install.mjs status` and show the last log lines. With no issue assigned to them and marked `agent:ready`, "noTask" is the expected result.
5. Tell the user how work reaches their agent: an issue assigned to them with their role label (`role:<role>`) and the `agent:ready` label added by a team member. Issues without a role go to the triage role's person. When the agent needs them, it adds `agent:blocked` and assigns the issue to them; adding `agent:ready` again continues.

## status, pause, resume, run-now, remove

- `node <plugin>/tools/agent-install.mjs status` — loaded or paused, the config, the last log lines (logs live in `~/.dev-process/agent/logs/`).
- `pause` / `resume` — unload or load the LaunchAgent (the config stays).
- `run-now` — one run immediately.
- `uninstall` (remove) — unloads and deletes the LaunchAgent; the clones and logs in `~/.dev-process/agent/` stay. Tell the user the keychain token stays until they delete it in their own terminal: `security delete-generic-password -s dev-process-agent-claude`.

After an update of this plugin, run setup again so the job uses the new engine.
