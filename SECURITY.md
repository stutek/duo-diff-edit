---
type: policy
title: Security
description: What Duo Diff Edit trusts, what it refuses, and how to report a vulnerability privately.
tags: [security, threat-model]
---

# Security

## Report a vulnerability

Report it privately on GitHub: **Security → Report a vulnerability** in [stutek/duo-diff-edit](https://github.com/stutek/duo-diff-edit/security). Please do not open a public issue for it.

## What is trusted

The extension acts on request files in a mailbox directory, so **whoever can write to the mailbox can make Visual Studio Code open files and stage untracked files as empty**. The mailbox is therefore private to the user:

- **Location:** `$XDG_RUNTIME_DIR/duo-diff-edit` (Linux: RAM, owned by the user, mode 700), otherwise `~/.cache/duo-diff-edit`. Never a shared temp directory such as `/tmp`, where another user could plant requests or symbolic links.
- **Linux and macOS:** the extension refuses a mailbox that is a symbolic link or belongs to another user, and tightens a mailbox others can read or write to mode 700.
- **Requests:** only small regular files are read (no symbolic links, FIFOs or devices; at most 64 KiB). Only lines `pair <absolute path>`, `git <absolute path>` or `saved <absolute path>` count, and paths with control characters are refused. git and the other helpers run through `execFile`, never through a shell; a helper gets 3 s.
- **Proposals:** the agent's proposal for a file is a copy in `$XDG_RUNTIME_DIR/duo-diff-edit-proposals` (otherwise `~/.cache/duo-diff-edit-proposals`), at the file's absolute path below it, refused and checked as the mailbox is. A new proposal is created with mode 600 and never overwrites an existing one. The left side of the diff is served from that directory only (its own URI scheme); a path that would leave it is refused. Whoever can write there can change what you see on the left, never your file: a block reaches your file only when you copy it across and save.

Processes of the same user are trusted, as they are for any editor.

## Workspace Trust

A repository's configuration can make git run programs (`core.fsmonitor`, among others). Duo Diff Edit therefore runs git only where Visual Studio Code's [Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust) allows it:

- The extension does not run in Restricted Mode (an untrusted folder).
- It runs git only in a repository that Visual Studio Code's git extension already has open in Source Control, so that extension's own rules apply (`git.openRepositoryInParentFolders`, closed repositories stay closed). A nested or parent repository that Source Control has not opened is refused with a message. git is the one the git extension found (`git.path`), not one in the current directory.
- A `git` request for a file outside every open workspace is not handled in the window that happens to have focus. That window opens the repository's folder (its real path, links resolved) in a new window, and Workspace Trust decides there, as for any folder you open. A request outside any repository, or in a repository that is the home folder, is refused instead of opening a folder. A `pair` or `saved` request runs no git and opens in the focused window.
- The extension finds a repository root without running git, and runs git with `core.fsmonitor` turned off.
- **Untracked files:** opening the diff for an untracked, not ignored file adds it to the index as a new, empty file, so you can write it together. The extension says so in a notice with the command to undo it (`git rm --cached`). After that, `git commit -a` would include the file: check what a 📖 button opens before you commit everything.

- **Testing Restricted Mode:** Visual Studio Code 1.144 keeps trusted folders in storage shared by every user data directory (`~/.vscode-shared`), so a folder below one you trust is trusted in a test profile too. The end-to-end test therefore puts its untrusted project in `$XDG_RUNTIME_DIR`.

## The plugin for Claude Code

The **📖** band only writes request files (`pair <absolute path>`). It offers buttons only for files that exist and are named in the agent's last answer, and refuses paths with control characters. It shows a notice when no Visual Studio Code window takes a request within 3 s, or when the project's new window does not take a forwarded request within 30 s.

## Releases

Releases are built by GitHub Actions from the tag ([release.yml](.github/workflows/release.yml)) after every check passed, with a read-only token; a separate job, which installs nothing, publishes them. The `.vsix` has a `.sha256` next to it. The build is reproducible: `python3 scripts/build-vsix.py` on the tag gives the same bytes on Linux. Third-party actions are pinned by commit, and the Claude Code CLI used for the checks is pinned by version.
