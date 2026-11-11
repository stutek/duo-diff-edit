---
type: overview
title: Duo Diff Edit
description: Write together with an AI agent in Visual Studio Code, as in Meld; the agent's proposal on the left, your file on the right, blocks copied across either way.
tags: [vscode-extension, claude-code-plugin, diff, meld, ai-pair-writing]
---

# Duo Diff Edit

Write a file together with an AI agent without the agent ever touching your file.

The diff shows **the agent's proposal on the left** and **your file on the right**, as in [Meld](https://meldmerge.org/), and both sides are editable. The agent writes only its proposal, a private copy; the left side updates the moment it does, without a reload prompt. You move blocks across either way:

| To                                             | Mouse                                   | Keys (macOS)       |
|------------------------------------------------|-----------------------------------------|--------------------|
| take a proposal (left → right)                 | gutter arrow →, or **→** in the title   | Alt+→ (Ctrl+Alt+→) |
| put your text into the proposal (right → left) | **←** in the title, or the context menu | Alt+← (Ctrl+Alt+←) |
| go to the next or previous change              | ↑ ↓ in the title                        | as in any diff     |

A block is every changed block the cursor or selection touches, by the same rule as the built-in arrow. Nothing reaches your file behind your back: every change on the right is yours to save and commit. The ← and → buttons and keys work in any diff of two files, `code --diff a b` too.

It has two parts:

| Part                              | What it does                                                                                                                                                                                                                                                                          |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Extension for Visual Studio Code  | Opens the proposal ↔ file diff in an auxiliary window on request (a small file in a mailbox directory) or from the Explorer context menu (**Open diff (proposal ↔ file)**), and adds the ← and → copy commands. The older index ↔ buffer diff stays (**Open diff (stage ↔ buffer)**). |
| Plugin for Claude Code (optional) | A skill that teaches the agent the protocol (open the diff, write the proposal, review each time you save), and a band of **📖** buttons above the prompt that opens the diff for every file the last answer mentions.                                                                 |

The skill is plain shell, so any agent that can run commands can follow it.

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

Ask the agent, for example: *"Let's polish notes.md together with duo diff edit."* The agent opens the diff and starts proposing. Take what you like, write your own, and save; the agent reviews what you saved and proposes the next round on top of your latest text.

Open the diff yourself with a **📖** button above the Claude Code prompt, or right-click a file in the Explorer: **Open diff (proposal ↔ file)**.

A **📖** click can also start a skill for the file, on the model and effort that skill sets: choose it in `/config` (*Skill a 📖 click starts*), or ask the agent to set it up. How, and a template for your own skill: [the skill's Configure section](plugin/skills/duo-diff-edit/SKILL.md#configure-what-a--click-starts-skill-model-effort).

### Request protocol

Write a file with any name into `<dir>/duo-diff-edit/`, where `<dir>` is `$XDG_RUNTIME_DIR` if set, otherwise `~/.cache` (on Windows `%USERPROFILE%\.cache`). One request per line, each ending in a newline (a file whose last line has none is still being written):

- `pair <absolute path>`: the agent's proposal ↔ the file. The proposal is `<dir>/duo-diff-edit-proposals/<absolute path>` (on Windows the drive letter, lower case, is the first folder: `…/duo-diff-edit-proposals/c/Users/…`); if it does not exist, it starts as a copy of the file.
- `git <absolute path>`: index ↔ buffer
- `saved <absolute path>`: file on disk ↔ buffer

The window whose workspace holds the path takes the request and deletes it; for `git` the repository must be open in its Source Control. If no window has the project open, the focused window takes a `pair` or `saved` request after 1.5 s; for `git` it opens the repository's folder in a new window, and that window takes it. A request older than 60 s is dropped, so reloading a window never replays old clicks. What the extension did is in **Output → Duo Diff Edit**.

What the mailbox trusts and refuses: [SECURITY.md](SECURITY.md).

## Platforms

| Platform                      | Status                                                                                                                                                                             |
|-------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Linux, KDE Plasma 6 (Wayland) | Index mode used daily; the two-file mode passes the end-to-end test (Visual Studio Code 1.144 on xvfb), first daily use pending. The auxiliary window goes to the largest monitor. |
| Linux, other desktops         | Should work; the auxiliary window opens where Visual Studio Code places it. The end-to-end test runs on a plain X11 display.                                                       |
| Windows                       | Written for (drive paths, Git Bash paths). Unit and plugin tests run in CI; not tested in use: reports welcome.                                                                    |
| macOS                         | Written for (case-insensitive paths; Ctrl+Alt+← and → instead of Alt). Unit and plugin tests run in CI; not tested in use: reports welcome.                                        |

## Limitations

- The **📖** band appears in Claude Code inside Visual Studio Code. Decorating the file links inside the answer itself is not possible yet: [anthropics/claude-code#107335](https://github.com/anthropics/claude-code/issues/107335).
- In the index mode the left side refreshes when the Visual Studio Code window has focus; the proposal of the two-file mode refreshes within half a second.
- Visual Studio Code does not give extensions its diff, so ← and → find the block with a line diff of their own (honouring `diffEditor.ignoreTrimWhitespace`). For an ordinary text it marks the same blocks; where a long run of changed lines could be split two ways, the block may differ from the one drawn. The gutter arrow → is Visual Studio Code's own.
- A gutter button for ← next to the built-in → would need a proposed API that a released extension cannot use.
- A **📖** button shows the file name, and for a file of another project that project's folder name (`📖 notes.md (Other)`); the full path on hover is not possible yet, as Claude Code's band in Visual Studio Code has no tooltip.

## Build and test from source

Needs Node.js, Python 3 and the Claude Code CLI; no npm packages.

```bash
python3 scripts/check.py         # every check: versions, syntax, unit tests, build, plugin validate and test
python3 scripts/check.py --e2e   # also the extension in a real Visual Studio Code on a virtual display (Linux, xvfb-run);
                                 # CODE=<path to code> picks the Visual Studio Code, e.g. one unpacked from a .tar.gz
python3 scripts/build-vsix.py    # only the package: dist/duo-diff-edit-<version>.vsix and its .sha256
```

GitHub Actions runs the checks on Linux, macOS and Windows for every push, and the end-to-end test on Linux ([ci.yml](.github/workflows/ci.yml)). A tag `v<version>` publishes the release ([release.yml](.github/workflows/release.yml)).

## Trademarks

Visual Studio Code is a trademark of Microsoft Corporation. Claude and Claude Code are trademarks of Anthropic, PBC. Git is a trademark of the Software Freedom Conservancy. This project is not affiliated with or endorsed by any of them.

## License

[MIT](LICENSE)
