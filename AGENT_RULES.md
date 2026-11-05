---
type: guidelines
title: Duo Diff Edit agent rules
description: Rules for AI agents working on this repository: layout, checks before a commit, versioning, publishing.
tags: [agent-rules, workflow]
---

# Agent rules

Binding on every AI agent working on this repository. `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` only point here.

* **Layout:** `vscode/` the extension for Visual Studio Code (plain JavaScript, no build step, no dependencies); `plugin/` the Claude Code plugin (mod `hooks/register.tsx`, skill `skills/duo-diff-edit/SKILL.md`); `.claude-plugin/marketplace.json` makes the repository a plugin marketplace; `scripts/build-vsix.py` packages the extension.
* **No dependencies:** keep the extension free of npm packages and build tools; the request protocol (README) and the skill stay plain shell and git.
* **Three platforms:** Linux, macOS and Windows. Paths go through `path`; no `/dev/null`, no Linux-only commands outside the optional KDE placement. State in the README which platform a change was tested on.
* **Checks before a commit:** `node --check vscode/extension.js`, `python3 scripts/build-vsix.py`, `claude plugin validate .`, `claude plugin test plugin`. A change in the extension's behaviour is tested in a real Visual Studio Code instance (on a virtual display, with a separate `--user-data-dir` and `--extensions-dir`).
* **Versioning:** one version for both parts: `vscode/package.json` and `plugin/.claude-plugin/plugin.json` change together. A release is a git tag `v<version>` with the `.vsix` attached (`gh release create`).
* **Publishing:** the repository is public; the owner approves every push and release.
* **Language:** English in code, comments and documents.
