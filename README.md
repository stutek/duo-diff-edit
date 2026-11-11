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

A **📖** click can also start a skill for the file, on the model and effort that skill sets: choose it in `/config` (*Skill a 📖 click starts*), or ask the agent to set it up. How, and a template for your own skill: [the skill's Configure section](plugin/skills/duo-diff-edit/SKILL.md#configure-what-a--click-starts-skill-model-effort).

### Request protocol

Write a file with any name into `<dir>/duo-diff-edit/`, where `<dir>` is `$XDG_RUNTIME_DIR` if set, otherwise `~/.cache` (on Windows `%USERPROFILE%\.cache`). One request per line, each ending in a newline (a file whose last line has none is still being written):

- `git <absolute path>`: index ↔ buffer
- `saved <absolute path>`: file on disk ↔ buffer

The window whose workspace holds the path takes the request and deletes it; the repository must be open in its Source Control. If no window has the project open, the focused window opens the repository's folder in a new window after 1.5 s, and that window takes it (a `saved` request opens in the focused window). A request older than 60 s is dropped, so reloading a window never replays old clicks. What the extension did is in **Output → Duo Diff Edit**.

What the mailbox trusts and refuses: [SECURITY.md](SECURITY.md).

## Platforms

| Platform                      | Status                                                                                          |
|-------------------------------|-------------------------------------------------------------------------------------------------|
| Linux, KDE Plasma 6 (Wayland) | Used daily. The auxiliary window goes to the largest monitor; raising it on each click is written for, not yet confirmed. |
| Linux, other desktops         | Should work; the auxiliary window opens where Visual Studio Code places it. Not tested.                                   |
| Windows                       | Written for (drive paths, Git Bash paths). Unit and plugin tests run in CI; not tested in use: reports welcome.           |
| macOS                         | Written for (case-insensitive paths). Unit and plugin tests run in CI; not tested in use: reports welcome.                |

## Limitations

- The **📖** band appears in Claude Code inside Visual Studio Code. Decorating the file links inside the answer itself is not possible yet: [anthropics/claude-code#107335](https://github.com/anthropics/claude-code/issues/107335).
- The left side refreshes when the Visual Studio Code window has focus.
- A **📖** button shows the file name, and for a file of another project that project's folder name (`📖 notes.md (Other)`); the full path on hover is not possible yet, as Claude Code's band in Visual Studio Code has no tooltip.

## Build and test from source

Needs Node.js, Python 3 and the Claude Code CLI; no npm packages.

```bash
python3 scripts/check.py         # every check: versions, syntax, unit tests, build, plugin validate and test
python3 scripts/check.py --e2e   # also the extension in a real Visual Studio Code on a virtual display (Linux, xvfb-run)
python3 scripts/build-vsix.py    # only the package: dist/duo-diff-edit-<version>.vsix and its .sha256
```

GitHub Actions runs the checks on Linux, macOS and Windows for every push, and the end-to-end test on Linux ([ci.yml](.github/workflows/ci.yml)). A tag `v<version>` publishes the release ([release.yml](.github/workflows/release.yml)).

## Trademarks

Visual Studio Code is a trademark of Microsoft Corporation. Claude and Claude Code are trademarks of Anthropic, PBC. Git is a trademark of the Software Freedom Conservancy. This project is not affiliated with or endorsed by any of them.

## License

[MIT](LICENSE)
