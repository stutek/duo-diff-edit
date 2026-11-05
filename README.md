---
type: overview
title: Duo Diff Edit
description: Write together with an AI agent through the git index; the agent proposes edits into the index, you accept them block by block in an index ↔ buffer diff in Visual Studio Code.
tags: [vscode-extension, claude-code-plugin, git, diff, ai-pair-writing]
---

# Duo Diff Edit

Write a file together with an AI agent without the agent ever touching your editor buffer.

The diff shows the **git index (stage) on the left** and **your editor buffer on the right**. The agent writes its proposals into the index, so they appear on the left as you type on the right. You accept a proposal with the built-in gutter arrow **→ Revert Block** (copies the block into your buffer) and stage your own text with **+ Stage Block**. Nothing is overwritten behind your back, and every accepted change is yours to save and commit.

It has two parts:

| Part                                    | What it does                                                                                                                                                                                                                                           |
|-----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Extension for Visual Studio Code        | Opens the index ↔ buffer diff in an auxiliary window on request (a small file in a mailbox directory) or from the Explorer context menu (**Open diff (stage ↔ buffer)**). The left side follows stage and commit.                                       |
| Plugin for Claude Code (optional)       | A skill that teaches the agent the protocol (open the diff, propose into the index without overwriting your staged work, review each time you stage), and a band of **📖** buttons above the prompt that opens the diff for every file the last answer mentions. |

The skill is plain shell and git, so any agent that can run commands can follow it.

## Install

1. **Extension:** download `duo-diff-edit-<version>.vsix` from [Releases](https://github.com/stutek/duo-diff-edit/releases) and install it:
   ```bash
   code --install-extension duo-diff-edit-0.1.0.vsix
   ```
2. **Plugin for Claude Code:**
   ```bash
   claude plugin marketplace add stutek/duo-diff-edit
   claude plugin install duo-diff-edit@duo-diff-edit
   ```
3. Reload the Visual Studio Code window (**Developer: Reload Window**).

## Use

Ask the agent, for example: *"Let's polish notes.md together with duo diff edit."* The agent opens the diff and starts proposing. Stage a part you are happy with (+); the agent reviews what you staged and proposes the next round.

Open the diff yourself with a **📖** button above the Claude Code prompt, or right-click a file in the Explorer: **Open diff (stage ↔ buffer)**.

### Request protocol

Write a file with any name into `<dir>/duo-diff-edit/`, where `<dir>` is `$XDG_RUNTIME_DIR` if set, otherwise the OS temp directory (`$TMPDIR` on macOS, `%TEMP%` on Windows, `/tmp`). One request per line:

- `git <absolute path>`: index ↔ buffer
- `saved <absolute path>`: file on disk ↔ buffer

The window whose workspace holds the path takes the request and deletes it. A request no open workspace claims is taken after 1.5 s by the focused window.

## Platforms

| Platform                      | Status                                                                                          |
|-------------------------------|-------------------------------------------------------------------------------------------------|
| Linux, KDE Plasma 6 (Wayland) | Used daily. The auxiliary window goes to the largest monitor and comes to the front on each click. |
| Linux, other desktops         | Should work; the auxiliary window opens where Visual Studio Code places it. Not tested.         |
| Windows                       | Written for (drive paths, Git Bash paths, `%TEMP%` mailbox). Not tested yet: reports welcome.   |
| macOS                         | Written for (case-insensitive paths, `$TMPDIR` mailbox). Not tested yet: reports welcome.       |

## Limitations

- The **📖** band appears in Claude Code inside Visual Studio Code. Decorating the file links inside the answer itself is not possible yet: [anthropics/claude-code#107335](https://github.com/anthropics/claude-code/issues/107335).
- The left side refreshes when the Visual Studio Code window has focus.

## Build from source

```bash
python3 scripts/build-vsix.py   # writes dist/duo-diff-edit-<version>.vsix
claude plugin validate . && claude plugin test plugin
```

## Trademarks

Visual Studio Code is a trademark of Microsoft Corporation. Claude and Claude Code are trademarks of Anthropic, PBC. Git is a trademark of the Software Freedom Conservancy. This project is not affiliated with or endorsed by any of them.

## License

[MIT](LICENSE)
