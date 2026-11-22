# Role agents design (1.1)

Each participant's computer runs a scheduled job that picks up the GitHub issues assigned to that person for their
role (product, UI, engineering, marketing), works on them with Claude Code, and hands them on to the next role. The
review process stays the human gate: no agent signs off, waives the AI review, approves, merges by itself, releases or
publishes.

## The rule the design follows

The model never holds a GitHub write credential. Claude works inside a fresh worktree and answers with one JSON object
(`AGENT_RESULT_SCHEMA`); the runner, deterministic code using the person's own `gh` login, does every write: claim,
commit, push, pull request, comment, labels, assignment. This is the GitLab review split (review job without the bot
token, posting job with it) applied to a person's machine.

## Shared state

- Labels: `role:<role>` (which role the issue is with) and `agent:ready | agent:working | agent:review |
  agent:blocked` (where it stands). The assignee is the person responsible.
- A machine only takes open issues that are assigned to its owner, carry one of the owner's role labels, and carry
  `agent:ready` applied by a participant (timeline `LABELED_EVENT` actor). Assignment, not self-claiming: two machines
  never race for one issue.
- New issues without a role are triaged by the product role's agent (decides the role, splits, assigns).
- `.dev-process/team.json`, read from the default branch only (reviewed), lists participants and their roles, the
  allowed hand-offs, each role's instructions file, writable paths, setup commands, model, and the accounts never to
  notify.

## The Claude run

```
env -i HOME PATH CLAUDE_CONFIG_DIR=<agent config dir> CLAUDE_CODE_OAUTH_TOKEN=<from the keychain> \
  claude --restricted --strict-mcp-config -p --tools <role tools> --permission-mode dontAsk \
    --allowedTools <role rules> --settings <sandbox json> --max-turns N --model <role model> \
    --output-format json --json-schema <AGENT_RESULT_SCHEMA>  < prompt
```

- `--restricted`: no user / project / local settings files, file tools confined to the working directories, Bash only
  when `--tools` names it, no `bypassPermissions`. CLAUDE.md is still read (unlike `--bare`, which also refuses OAuth).
- A separate `CLAUDE_CONFIG_DIR`: no personal CLAUDE.md, memory, plugins or hooks, so every machine behaves the same.
- `env -i`: no `GH_TOKEN` / `GITHUB_TOKEN`, no `ANTHROPIC_API_KEY` (it would take precedence over the OAuth token).
- Sandbox (`--settings`, which `--restricted` still loads): `enabled`, `failIfUnavailable`,
  `allowUnsandboxedCommands: false`, `filesystem.denyRead` for credential paths, `network.allowedDomains` +
  `strictAllowlist`. An allowed command (`npm test`) runs scripts the agent can edit; the sandbox is what keeps them from
  reading credentials.
- The issue text goes into the prompt as data, in a fenced block, after the role instructions.

## Phase 0 results (this Mac, Claude Code 2.1.330, 2026-11-21)

Run, not read:
- `--restricted --strict-mcp-config -p --tools "Read,Grep,Glob,Edit,Write,Bash" --permission-mode dontAsk` with an
  allowlist of `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash(npm test)`:
  - the Read tool on a file outside the working directory: denied (restricted mode);
  - `cat <outside file>`, `gh api user`, `git push origin HEAD`, `curl https://example.com`: denied (dontAsk), listed
    in `permission_denials`;
  - `npm test` and an Edit of a tracked file: allowed;
  - `--json-schema`: the answer arrives in `structured_output`.
- An allowed script that reads a secret outside the worktree (`"leak": "cat ../outside/secret.txt"`, allowed as
  `Bash(npm run leak)`): without the sandbox the secret appears in the output; with the sandbox (`denyRead` on that
  path, `failIfUnavailable`, `allowUnsandboxedCommands: false`) the command fails and the secret does not appear.
- Auth: `claude setup-token` stored in the login keychain (`security add-generic-password -s
  dev-process-agent-claude`), read with `security find-generic-password -w`, passed as `CLAUDE_CODE_OAUTH_TOKEN` under
  `env -i` with an empty `CLAUDE_CONFIG_DIR`: the run succeeds; the model sees no CLAUDE.md, memory, hooks or plugins
  from the person's profile. The default model in an empty config dir was Sonnet, so the role sets `--model`.
- A LaunchAgent (`launchctl bootstrap gui/<uid>` + `kickstart`) reads the token from the keychain without a prompt and
  completes the same run (7 s).
- The production arguments (`claudeArgs`, with the worktree and the agent's clone under `~/.dev-process/…`, which is
  otherwise denied) in a clean environment with the keychain token: `npm test` and `git status` work; an allowed script
  that runs `security find-generic-password -s dev-process-agent-claude -w` gets "item could not be found" (no keychain
  from the sandbox), `gh auth token` cannot read `~/.config/gh`, `cat ~/.config/gh/hosts.yml` and another file under
  `~/.dev-process` are "Operation not permitted"; neither token appears anywhere in the output.
- Before committing, the runner also scans the changes for the two known token values and refuses.

## End-to-end run (private throwaway repository `agent-sandbox`, 2026-11-21)

One person holding every role, full mode, real Claude runs (each pass 45–90 s on a tiny Node project):
- A role-less issue: triage → product (stopped with five questions; after the answers in the issue and `agent:ready`
  again, it wrote the requirement) → UI spec → engineering (code + tests, `npm test` run inside the sandbox) → PR.
- A second chain: triage → product (PR) → engineering, stacked on the product branch (PR base = that branch) → product
  acceptance on the engineering branch. After both PRs merged, the runner closed the issue itself.
- A direct engineering issue → PR with `Closes`, the repository's PR template appended, commit trailers, worktree
  removed afterwards.
- `agent-install install` → LaunchAgent → `run-now`: the copied engine ran the same flow from launchd.

Found and fixed during the run:
- Two "fetch failed" on opening a PR: the Claude call blocked the event loop (spawnSync) for minutes, so the HTTP client
  reused a keep-alive connection GitHub had closed. Child processes are async now; GitHub requests retry on network
  failures (POST only when no connection was made); a failed PR creation looks for an existing PR and names the branch.
- Work done before stopping for a person was lost: it now goes to a draft PR that the next run continues.
- Later roles could not see earlier roles' unmerged files: hand-offs name the branch and the next role stacks on it.
- `npm test` refused when the model added `cd` or a pipe: the prompt lists the allowed commands verbatim; refused
  actions are logged and named in the issue comment.
- A role coming back (acceptance) resumed its own finished PR: only draft PRs are continued.
- The issue was closed while stacked PRs were still open: it now waits in `agent:review` until all its agent PRs merge.

Not run yet: a real engineering task on a large repository (setup cost, test time, Claude cost), Windows, GitLab.

Pitfall seen while setting up: a person pasted the `security` command itself at the password prompt. Storing with
`-w "$(pbpaste)"` after copying the token avoids it; the setup skill checks the stored value starts with `sk-ant-oat`
without printing it.

## Windows

Native Windows has no Claude Code sandbox ("On native Windows, Claude Code runs commands unsandboxed"; with
`failIfUnavailable` it exits at startup). So on Windows the runner only takes roles without Bash: they use file tools
only, which `--restricted` confines to the worktree, and the settings carry no sandbox block. A role with Bash is left
for a macOS machine (`check` says so; the runner logs and skips its issues). The child environment also sets
`CLAUDE_CODE_USE_POWERSHELL_TOOL=0`.

- Token: a file encrypted with DPAPI for the current Windows user (PowerShell's `ConvertFrom-SecureString`), read and
  written through stdin / stdout; `PSModulePath` is dropped when calling `powershell.exe`, or Windows PowerShell 5.1
  started from PowerShell 7 cannot load `ConvertTo-SecureString`.
- Scheduler: a Task Scheduler task from an XML definition (every N minutes while logged on, one instance at a time, a
  3-hour limit), started through `conhost.exe --headless` when that works on the machine (tried at install), otherwise a
  hidden PowerShell window. The runner writes its own log (`--log`).
- Claude executable: `claude.exe` on PATH, the one beside the npm shim (a `.cmd` cannot be spawned without a shell), or
  `%USERPROFILE%\.local\bin\claude.exe` (the native installer does not add it to PATH).
- Verified on a GitHub-hosted Windows runner by the plugin's CI: the unit tests; the DPAPI round trip; the task registers,
  its action runs with paths containing spaces, Task Scheduler starts it, disable / enable / delete; `claude.exe` is found
  and starts; the production arguments (restricted, no sandbox, settings and schema JSON) parse and the run reaches
  authentication. Not verified: a real Claude run with a token on a colleague's Windows machine; `conhost --headless` on
  an interactive desktop (the runner had none and fell back to PowerShell).

## Human gates

- Low-tier pull requests (docs-only by the repository's policy): the runner adds the queue label itself once the gate
  has judged the head low. Medium / high: the runner asks the author (the person) to sign off; high also needs another
  person's approval. Release-labelled or version-changing pull requests always wait for the project lead.
- The risk gate still needs a real AI review of the head (Copilot or Claude), so agent pull requests wait for it like
  any other.
