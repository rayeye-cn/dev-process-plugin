---
name: init
description: Install a Claude-Code-team-style development and review process into the current repository (GitHub or self-managed GitLab; GitHub Copilot or Claude as AI reviewer; Chinese or English). Under construction — not usable before v0.2.
disable-model-invocation: true
argument-hint: "[--lang zh|en]"
---

# dev-process: init

**Status: under construction (milestone M0).** This skill does not install anything yet.

The finished flow (see the repository README):

1. Detect the forge (GitHub / GHES / GitLab), plan or tier, default branch and stack.
2. Ask for language, AI reviewer, trusted authors, code owners, risk paths, runners, queue mode and optional loops.
3. Write `.dev-process/answers.json` and render the process deterministically with `node "${CLAUDE_PLUGIN_ROOT}/tools/render.mjs"`.
4. Verify locally with the vendored `doctor`, then ship it as three PRs/MRs and apply branch protection last.

Until then, tell the user this skill is not ready and point them to the README's roadmap.
