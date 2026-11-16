---
type: todo
title: Duo Diff Edit open points
description: Open bugs and open points of Duo Diff Edit, each with its source, the check made in the code and the proposed fix.
tags: [todo, bugs]
---

# Open points

## Bug: the user's view moves when the agent edits the left side

Recorded 2026-11-16 10:44:42.629834988. Open; nothing in the code is changed yet. Blocks: reading and editing the right side while the agent proposes (the user loses their place and misses what the agent asked meanwhile).

**Report** (the owner's words, 2026-11-16, verbatim): »bug report, ko agent ureja levo stran, se meni okno ne sme prestavljati« ("bug report: when the agent edits the left side, my window must not move"). Earlier in the same session, about the same effect: »predvidevaj, da nisem videl vprašanja, ker se tekst premika« ("assume I did not see the question, because the text moves").

**Expected:** when the agent changes the left side, the user's scroll position, cursor and focus stay as they are.

**Actual:** after the agent's write the view in the diff window moved, and the user lost the place they were reading.

**Steps to reproduce** (observed on Linux, KDE Plasma; not yet repeated in a test):

1. Two-file mode (`pair`): the agent's proposal on the left, the user's file on the right. The file is a long Markdown document, 95 lines, each paragraph one long line, word wrap on.
2. The user reads and edits the right side, scrolled away from the top.
3. The agent, in one step: writes the proposal as the skill says (`cp "$F" "$P.new"`, edit, `mv "$P.new" "$P"`), and right after it writes a second request `pair <absolute path>` into the mailbox "to refresh the diff", although the diff is already open.
4. The view moves.

### What the code does (checked in `vscode/extension.js`, not yet measured in a running editor)

**Guess (a): a second `pair` for a diff that is already open reveals the editor again and resets focus or view. Confirmed for focus; the scroll position is not settled by the code.**

- `handle` (line 428) passes every `pair` request to `openPair` (lines 137-149), which always ends in `showInAux` (line 148). Nothing checks whether a tab with this diff is already open.
- `showInAux` (lines 338-347) runs `vscode.diff` with `preserveFocus: false` (lines 342-343) and then `kwin(storage, title)` (line 346), which on KDE raises the auxiliary window (KWin script, lines 29-33 and 41-57). Its own comment says so: "every diff gets focus (window and tab)". So a repeated `pair` always takes keyboard focus into the diff editor, makes that tab the active one and raises its window, whatever the user was doing, in another window too.
- Whether `vscode.diff` on an input that is already open also resets the scroll position or the cursor is Visual Studio Code's behaviour, not this extension's; it needs a measurement (see the test below).
- A side effect of the same path: after a window reload `group()` (line 77) no longer knows the auxiliary window, so a repeated `pair` opens a second window (`newWindow`, line 340).

**Guess (b): replacing the proposal with `mv` (a new inode) reloads the left side and that moves the view. The inode plays no part; the reload is real, and nothing in the extension holds the view through it.**

- The left side is polled by path with `fs.watchFile(f, { interval: 500 }, …)` (line 110); a change of `mtimeMs` or `size` fires one `FileChangeType.Changed` (line 108). A new inode makes no difference to a poll by path, and `cp` to `$P.new` touches nothing that is watched. Visual Studio Code then reloads the left document (unless it has unsaved edits).
- The extension never reads or restores a scroll position: the only `revealRange` is in `go` (line 327, Alt+↑/↓), and `visibleRanges` is used nowhere. Through a reload the view is left to the diff editor. Both sides scroll together and the diff editor aligns them with filler space, so when wrapped lines above the visible part change height on the left, or blocks appear or disappear there, the right side's text can shift on screen although its own content has not changed. This is the likely cause of the movement when no second `pair` is sent; it is not yet measured.

**Found in addition (c): the CodeLens rows change on every write of the proposal.** `onDidChangeTextDocument` for the left side calls `refreshAgreed` (line 518), which after 300 ms fires `lensChanged` (line 422), and the lenses are computed anew (`lenses`, lines 229-236; `cursorLenses`, lines 237-253). A "Stage agreed lines" lens stands over each run of agreed lines on the right, and "Accept suggestion" / "Prefer mine" over the block at the cursor. A new proposal changes which lines agree and whether the cursor is on a block, so lens rows appear and disappear above and inside the visible part; each is a row of height. Whether Visual Studio Code keeps the view steady when lens rows change is not checked.

### The skill's part

`plugin/skills/duo-diff-edit/SKILL.md` does not tell the agent to send `pair` again: line 8 says "the left side updates at once", step 1 (line 23) is named "Open the diff", and step 2 (lines 27-32) only writes the proposal. It does not forbid it either, and nothing says that a second `pair` takes the user's focus; the agent sent it "to refresh". A second `pair` after a write is never needed: the poll (line 110 of the extension) reloads the side within half a second.

### Proposed fix

1. **Skill** (`SKILL.md`, steps 1 and 2): say that `pair` is sent once per file, and never after writing a proposal, because the left side reloads on its own within half a second and a request takes the user's focus. Send it again only when the user has closed the diff.
2. **Extension, repeated request** (`openPair` / `showInAux`): when a tab with this pair is already open, do not run `vscode.diff` again and do not raise the window; log it and return. If raising on a repeated 📖 click is wanted, tell the two apart (the click may raise; an agent's request may not), or reveal with `preserveFocus: true`.
3. **Extension, reload of the left side:** first measure what moves (a test in `test/e2e-ui/run.js`: a long file with wrapped paragraphs, the right editor scrolled to the middle with the cursor there; change the proposal on disk above and below the visible part, once with and once without a second `pair`; compare the right editor's `visibleRanges`, selection and the active editor before and after). Then hold the right side's first visible line and cursor through the reload and through the lens refresh, or keep lens rows from changing height above the visible part.
4. Per the rules: a change in behaviour needs `python3 scripts/check.py --e2e` and its test; the README states the platform it was tested on.
