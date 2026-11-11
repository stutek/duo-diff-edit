---
type: guidelines
title: Duo Diff Edit agent rules
description: Rules for AI agents working on this repository: layout, checks before a commit, versioning, publishing.
tags: [agent-rules, workflow]
---

# Agent rules

Binding on every AI agent working on this repository. `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` only point here.

* **Layout:** `vscode/` the extension for Visual Studio Code (plain JavaScript, no build step, no dependencies); `plugin/` the Claude Code plugin (mod `hooks/register.tsx`, skill `skills/duo-diff-edit/SKILL.md`); `.claude-plugin/marketplace.json` makes the repository a plugin marketplace; `test/` unit tests; `scripts/` build, checks and the end-to-end test; `.github/workflows/` CI and release.
* **No dependencies:** keep the extension free of npm packages and build tools; the request protocol (README) and the skill stay plain shell and git.
* **Three platforms:** Linux, macOS and Windows. Paths go through `path`; no `/dev/null`, no Linux-only commands outside the optional KDE placement. State in the README which platform a change was tested on.
* **Checks before a commit:** `python3 scripts/check.py` (`CLAUDE=<path>` when `claude` is not on PATH); a change in the extension's behaviour also `--e2e` (real Visual Studio Code on a virtual display, own user data, extensions and mailbox). A new behaviour gets its test in `test/`, `plugin/hooks/*.test.tsx` or `scripts/e2e-vscode.py`.
* **Security:** [SECURITY.md](SECURITY.md) is the threat model; a change that touches the mailbox, git calls or Workspace Trust keeps it true.
* **Versioning:** one version for both parts: `vscode/package.json` and `plugin/.claude-plugin/plugin.json` change together. A release is a pushed git tag `v<version>`; GitHub Actions attaches the `.vsix` and its `.sha256`.
* **Publishing:** the repository is public; the owner approves every push and release.
* **Language:** English in code, comments and documents.
