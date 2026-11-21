# Installing dev-process for a team

中文：[install.zh.md](install.zh.md)

## Who needs the plugin

Only the people who set up or maintain the process in a repository: they run `/dev-process:init`, `/dev-process:doctor`
and `/dev-process:upgrade`. A repository that has the process does not need the plugin to run it: the engine is copied
into `.dev-process/engine`, and everyone else only follows the rules in `CLAUDE.md` and the PR / MR template.

## Before you install

- Claude Code, Node 24 or later, git.
- Read access to `rayeye-cn/dev-process-plugin` (a private repository).
- Git credentials that work **without a prompt**. Claude Code runs `git` with prompts turned off and has no token of its
  own. Either:
  - SSH: a GitHub key loaded in `ssh-agent` (no passphrase prompt) and `github.com` in `known_hosts`; or
  - HTTPS: `gh auth login`, then `gh auth setup-git`. Set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` to skip the SSH attempt.

  Check: `git ls-remote https://github.com/rayeye-cn/dev-process-plugin` (or the `git@github.com:` form) must print refs
  without asking for anything.
- For the setup itself: on GitHub, `gh` logged in as a repository admin; on GitLab, a token of a Maintainer or Owner
  (the skills explain how to pass it without putting it in the conversation).

## Install

In Claude Code:

```
/plugin marketplace add rayeye-cn/dev-process-plugin
/plugin install dev-process@dev-process-plugin
```

or from a shell:

```
claude plugin marketplace add rayeye-cn/dev-process-plugin
claude plugin install dev-process@dev-process-plugin
```

Start a new session (or run `/reload-plugins`). Then, in the repository to set up: `/dev-process:init`.

To stay on one release, add the marketplace at its tag: `rayeye-cn/dev-process-plugin#dev-process--v1.0.0`.

## Updates

Auto-update is **off** for this marketplace by default. Either turn it on (`/plugin` → Marketplaces →
`dev-process-plugin` → auto-update; background updates need the same prompt-free credentials), or update by hand:

```
claude plugin marketplace update dev-process-plugin
claude plugin update dev-process@dev-process-plugin
```

then restart Claude Code. A new plugin version does not change any repository by itself: run `/dev-process:upgrade` in
each repository to re-render its files with the new version (it shows the plan and opens a PR / MR).

## Optional: register the marketplace in a repository

So that everyone who opens a repository in Claude Code gets the marketplace, run once in that repository and commit
the `.claude/settings.json` it writes:

```
claude plugin marketplace add rayeye-cn/dev-process-plugin --scope project
```

The result looks like this (`autoUpdate` is optional):

```json
{
  "extraKnownMarketplaces": {
    "dev-process-plugin": {
      "source": { "source": "github", "repo": "rayeye-cn/dev-process-plugin" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "dev-process@dev-process-plugin": true }
}
```

This registers the marketplace only after a person trusts that folder, and it does not install the plugin: each person
still runs `claude plugin install dev-process@dev-process-plugin --scope project` (or `--scope user` once for all
repositories). Changes to `.claude/**` are high-risk paths in the installed process, so this commit needs the author's
sign-off and one more approval.

## Releasing a new version (plugin maintainers)

`plugin.json` sets `version`, so **installed users only receive commits that change it**. For each release:

1. Bump `version` in `.claude-plugin/plugin.json` (not in `marketplace.json`: the entry must not carry its own version)
   and add a `CHANGELOG.md` entry.
2. `npm test` and `npm run validate`; commit, push, wait for the plugin's CI.
3. `claude plugin tag --push` (creates and pushes `dev-process--v<version>`).

## Troubleshooting

- The marketplace or install fails to clone: the git check above fails, or the SSH key asks for a passphrase. Fix the
  credentials; `/plugin` → Errors shows the last error.
- "already at the latest version" after a push: the push did not bump `version`.
- "Plugin "dev-process" is on in project settings but isn't installed here": run the `install` command with
  `--scope project`.
