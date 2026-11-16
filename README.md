---
type: overview
title: Duo Diff Edit
description: Write together with an AI agent in Visual Studio Code, as in Meld; the agent's proposal on the left, your file on the right, blocks copied across either way.
tags: [vscode-extension, claude-code-plugin, diff, meld, ai-pair-writing]
---

# Duo Diff Edit

Write a file together with an AI agent without the agent ever touching your file.

The diff shows **the agent's proposal on the left** and **your file on the right**, as in [Meld](https://meldmerge.org/), and both sides are editable. The agent writes only its proposal, a private copy; the left side updates the moment it does, without a reload prompt. You move blocks across either way:

| To                                                                                    | Mouse                                                                         | Keys (macOS)                           |
|---------------------------------------------------------------------------------------|-------------------------------------------------------------------------------|----------------------------------------|
| take a proposal (left → right)                                                        | **→ Accept suggestion** over the block, gutter arrow →, or **→** in the title | Alt+→ (Ctrl+Alt+→)                     |
| prefer your text: it goes into the proposal, and the agent rethinks it (right → left) | **← Prefer mine** over the block, **←** in the title, or the context menu     | Alt+← (Ctrl+Alt+←)                     |
| go to the next or previous block                                                      | ↑ ↓ in the title                                                              | Alt+↓ Alt+↑ (Ctrl+Alt+↓ ↑)             |
| the same, word by word, inside a line too                                             | Command Palette: *Duo Diff Edit*                                              | Shift+Alt+arrow (Ctrl+Shift+Alt+arrow) |

Visual Studio Code's gutter has only the arrow → (it is the built-in Revert Block, and an extension cannot add a ← there), so ← is the **← Prefer mine** button over the block, the **←** in the title and Alt+←.

For a file in git, **Stage mine** (**+** over the change at the cursor on the right, or the context menu) puts your text of that change into the git index, and **Stage file** (the title) your whole text; the file stays as it is and the proposal is never staged. Neither shows outside git.

The two buttons over the block at the cursor are CodeLenses; the extension turns `diffEditor.codeLens` on, so other extensions' CodeLenses show in diffs too (turn it off in Settings to have neither). The gutter menu's own **Revert Block** is Visual Studio Code's and keeps its name.

When your file is in a git repository, lines that both sides hold alike but the git index does not yet are light blue on the right, each run with a **Stage agreed lines** button over it: it puts just those lines into the index (the file stays as it is), so what you staged is what you and the agent agree on.

The keys are Meld's. A block is every changed block the cursor or selection touches, by the same rule as the built-in arrow, with one difference: changed lines with as many lines on both sides (a paragraph per line, each changed on its own) are a block each, so they move one at a time, where the built-in arrow takes them together. Word by word, it is every changed word or phrase the cursor or selection touches, and going to one selects it, so the next copy takes just that; the same change on the other side is highlighted (a bar where it is only an insertion) and scrolled into view, without taking the focus, until the next move, an edit or the selection leaving the change. Going moves on the side the cursor is on. Undo and Redo work as in one editor, copies included: on the side a copy went to it is one step of that side's Undo; on the side it came from, Ctrl+Z (⌘Z) undoes it once your later edits there are undone, and Ctrl+Shift+Z or Ctrl+Y (⇧⌘Z) brings it back. Nothing reaches your file behind your back: every change on the right is yours to save and commit. The buttons and keys work in any diff of two files, `code --diff a b` too; in that diff they take the place of Visual Studio Code's Move Line (Alt+↑ ↓), Expand and Shrink Selection (Shift+Alt+← →) and Add Cursor Above and Below (Shift+Alt+↑ ↓ on Linux). Ctrl+arrows stay for moving by word and scrolling.

It has two parts:

| Part                              | What it does                                                                                                                                                                                                                                                                                |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Extension for Visual Studio Code  | Opens the proposal ↔ file diff in an auxiliary window on request (a small file in a mailbox directory) or from the Explorer context menu (**Open in Duo Diff Edit**), and adds the ← and → copy commands. The older index ↔ buffer diff stays (**Open in Duo Diff Edit (stage ↔ buffer)**). |
| Plugin for Claude Code (optional) | A skill that teaches the agent the protocol (open the diff, write the proposal, review each time you save), and a band of **📖** buttons above the prompt that opens the diff for every file the last answer mentions.                                                                       |

The skill is plain shell, so any agent that can run commands can follow it.

## Install

1. **Extension:** download `duo-diff-edit-<version>.vsix` from [Releases](https://github.com/stutek/duo-diff-edit/releases) and install it:
   ```bash
   code --install-extension duo-diff-edit-0.2.0.vsix
   ```
2. **Plugin for Claude Code:**
   ```bash
   claude plugin marketplace add stutek/duo-diff-edit
   claude plugin install duo-diff-edit@duo-diff-edit
   ```
3. Reload the Visual Studio Code window (**Developer: Reload Window**).

## Use

Ask the agent, for example: *"Let's polish notes.md together with duo diff edit."* The agent opens the diff and starts proposing. Take what you like, write your own, and save; the agent reviews what you saved and proposes the next round on top of your latest text.

Open the diff yourself with a **📖** button above the Claude Code prompt, or right-click a file in the Explorer: **Open in Duo Diff Edit**.

A **📖** click can also start a skill for the file, on the model and effort that skill sets: choose it in `/config` (*Skill a 📖 click starts*), or ask the agent to set it up. How, and a template for your own skill: [the skill's Configure section](plugin/skills/duo-diff-edit/SKILL.md#configure-what-a--click-starts-skill-model-effort).

### Request protocol

Write a file with any name into `<dir>/duo-diff-edit/`, where `<dir>` is `$XDG_RUNTIME_DIR` if set, otherwise `~/.cache` (on Windows `%USERPROFILE%\.cache`). One request per line, each ending in a newline (a file whose last line has none is still being written):

- `pair <absolute path>`: the agent's proposal ↔ the file. The proposal is `<dir>/duo-diff-edit-proposals/<absolute path>` (on Windows the drive letter, lower case, is the first folder: `…/duo-diff-edit-proposals/c/Users/…`); if it does not exist, it starts as a copy of the file.
- `git <absolute path>`: index ↔ buffer
- `saved <absolute path>`: file on disk ↔ buffer

The window whose workspace holds the path takes the request and deletes it; for `git` the repository must be open in its Source Control. If no window has the project open, the focused window takes a `pair` or `saved` request after 1.5 s; for `git` it opens the repository's folder in a new window, and that window takes it. A request older than 60 s is dropped, so reloading a window never replays old clicks. What the extension did is in **Output → Duo Diff Edit**.

What you do that the files do not tell is a line in `<dir>/duo-diff-edit-events/saves`, so an agent can act on it at once: `<ISO time> SAVE manual left|right <your file>` for a save with Ctrl+S (not those of `files.autoSave`), `<ISO time> ACCEPT <first>-<last> <your file>` and `<ISO time> PREFER <first>-<last> <your file>` for Accept Suggestion and Prefer Mine, and `<ISO time> STAGE <first>-<last> <your file>` for Stage agreed lines, Stage mine and Stage file, with the lines of your file.

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
- In the index mode the left side refreshes when the Visual Studio Code window has focus; the proposal of the two-file mode refreshes within half a second, from a poll of its own.
- Reloading the window closes the diffs it restored (except those with unsaved edits): a restored auxiliary window may no longer show, and a diff opened into it is never seen. Open the diff again, with **📖** or a request; the proposal is kept on disk.
- Your file on the right is Visual Studio Code's own document, reloaded from disk by its file watcher. On Linux that watcher needs an inotify instance; with none left it logs `EMFILE` (in **Output → File Watcher**) and the file reloads only when the window gets focus. The extension then warns once. Raise the limit: `sudo sysctl -w fs.inotify.max_user_instances=1024`, and to keep it, `echo fs.inotify.max_user_instances=1024 | sudo tee /etc/sysctl.d/60-inotify.conf`.
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
