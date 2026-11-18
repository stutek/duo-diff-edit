---
type: todo
title: Duo Diff Edit open points
description: Open bugs and open points of Duo Diff Edit, each with its source, the check made in the code and the proposed fix.
tags: [todo, bugs]
---

# Open points

## Bug: a right-click Stage leaves the blue (agreed, unstaged) lines

Recorded 2026-11-18 11:54:29.813316952. The owner, verbatim: »desni klik in stage še ne odpravi modrega ozadja?« ("right-click and stage still does not remove the blue background?"), then »zakaj ni stage gumba ob mouse hover?« ("why is there no Stage button on mouse hover?"). Pair mode, the JobHunt2026 CV of OTP banka, installed 0.2.4.

**Checked:** no Duo Diff Edit log of any window of the session (`~/.config/Code/logs/20261118T072254/window*/exthost/stutek.duo-diff-edit/`) has a `staged` line, the events file has no `STAGE`, and `git status` shows the file ` M` (nothing in the index). So none of our Stage commands staged anything. The hover buttons are in commit 7857667, not in the installed 0.2.4 (it has no hover provider, only CodeLens rows, shown only with `diffEditor.codeLens`).

**Not known:** which item the owner clicked: git's own "Stage Selected Ranges" (top level of the menu; stages nothing in this diff, see the menu design below) or ours "Duo Diff Edit → Stage Selected Lines (Your Text)", which ends with a status-bar message only, without a log line, when the right side's cursor is on no unstaged change.

**Fix:** (1) log every "nothing to stage" outcome of `stageMine` and `stageAgreed` (`log.info`), so the next report shows which path ran; (2) release 0.2.5 with the hover buttons (blocked: the owner approves push and release). Blocks: nothing else.

## Bug: an inserted blank line merges separate line changes into one block

Recorded 2026-11-17 13:11:39.202949218. Open; nothing in the code is changed yet. Blocks: taking one paragraph of the proposal without the next (the user takes a block and gets two paragraphs, or cannot take one alone).

**Report** (the owner's words, 2026-11-17, verbatim): »zakaj pa šteje v8 in v10 kot en blok?« ("why does it count line 8 and line 10 as one block?").

**Cause, checked in the code:** `blocks()` in `vscode/blocks.js` with the user's file (lines 8, 10, 11 changed, line 9 blank) against a proposal that changes the same lines and also inserts a blank line before line 11. The right side's blank line 9 can pair with the left side's blank line 9 or the inserted one; the tie-break `L[i + 1][j] >= L[i][j + 1]` (removed lines first) pairs it with the inserted one, so left 8–10 against right 8–8 become one block, and left 12 against right 10–11 another. Without the inserted blank line the same texts give three one-line blocks (8, 10, 11). Reproduced with `node -e` on `blocks()`.

**Proposed fix:** among equal-length LCS alignments, prefer pairing identical lines at the nearest position (or prefer the alignment with more, smaller blocks), and add the case to `test/blocks.test.js`. Until then the agent proposes an inserted blank line in a round of its own.

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

**(c) again, and fixed in the code (2026-11-18 10:58:43.523299838; committed, not yet pushed or installed).** Report through jobhunt2026-3f, the owner's words verbatim: »bug report: namig o accept ali reject bloka mi ni všeč, da prestavlja vrstice med mojim delom« ("I do not like that the accept or reject hint of a block moves lines while I work"), 2026-11-18 around 10:50, pair mode, a Markdown file with one line per paragraph, the agent rewriting the proposal while the owner used ACCEPT and PREFER (events from 09:30Z). Fix: no CodeLens at all. Accept suggestion, Prefer mine, Stage mine and Stage agreed lines are links in a hover over the line (`hover` in `vscode/extension.js`), and each takes the hovered line, not the cursor's; `diffEditor.codeLens` is no longer turned on, so other extensions' lens rows do not move the text either. Lost: the buttons are no longer visible without the mouse; the keys, the gutter's ← → and the context menu stay. Checked: `scripts/check.py --e2e` passes on Linux (no lens of ours, hover links on a changed line and none on an alike one, accept from the hover with the cursor elsewhere, both Stage buttons). Not yet: which hint the owner meant (all of them are gone, so the answer changes nothing), and the owner's test in use. Open: the version bump to 0.2.5 in `plugin/.claude-plugin/plugin.json` (auto mode refused to judge the edit), and parts 1-3 of the fix below.

### The skill's part

`plugin/skills/duo-diff-edit/SKILL.md` does not tell the agent to send `pair` again: line 8 says "the left side updates at once", step 1 (line 23) is named "Open the diff", and step 2 (lines 27-32) only writes the proposal. It does not forbid it either, and nothing says that a second `pair` takes the user's focus; the agent sent it "to refresh". A second `pair` after a write is never needed: the poll (line 110 of the extension) reloads the side within half a second.

### Proposed fix

1. **Skill** (`SKILL.md`, steps 1 and 2): say that `pair` is sent once per file, and never after writing a proposal, because the left side reloads on its own within half a second and a request takes the user's focus. Send it again only when the user has closed the diff.
2. **Extension, repeated request** (`openPair` / `showInAux`): when a tab with this pair is already open, do not run `vscode.diff` again and do not raise the window; log it and return. If raising on a repeated 📖 click is wanted, tell the two apart (the click may raise; an agent's request may not), or reveal with `preserveFocus: true`.
3. **Extension, reload of the left side:** first measure what moves (a test in `test/e2e-ui/run.js`: a long file with wrapped paragraphs, the right editor scrolled to the middle with the cursor there; change the proposal on disk above and below the visible part, once with and once without a second `pair`; compare the right editor's `visibleRanges`, selection and the active editor before and after). Then hold the right side's first visible line and cursor through the reload and through the lens refresh, or keep lens rows from changing height above the visible part.
4. Per the rules: a change in behaviour needs `python3 scripts/check.py --e2e` and its test; the README states the platform it was tested on.

## Design: an own context menu in the diff instead of git's and the other extensions'

Recorded 2026-11-17 10:46:39.747151832. Decided 2026-11-17 11:19:58.497582444: the owner asked for an own menu with only the actions that make sense and, verbatim, »naj ne ustavi ampak izvede, da ne bo izgub« ("do not stop, carry it out, so that nothing is lost"); without losses only (c) is possible, built in 0.2.2 as the submenu **Duo Diff Edit**, first in the context menu. Measured besides: an own URI scheme removes 6 items only (those that ask for `resourceScheme == file`: git's two, ChatGPT, npm, Open in Browser's two); Copilot, GitLens, Markdown PDF and the others stay. Remove this item once 0.2.2 is released.

**Request** (the owner's words, 2026-11-17, verbatim): »lahko v najinem editorju odregistrirava GIT in mnoge druge in imava svoj rclick meni?« ("can we unregister git and many others in our editor and have our own right-click menu?")

**Checked:**

- An extension cannot remove or replace another extension's menu items: in `vscode.d.ts` (microsoft/vscode main, 21 506 lines) menus appear only as the declarative `menus` extension point of `package.json`, with no call to change them. Registering git's command again throws `command 'git.stageSelectedRanges' already exists` (measured in Visual Studio Code 1.144).
- The user can hide one title-bar action (Visual Studio Code's `menuService`, `hide.label`: right-click the icon → Hide '…'); it is hidden in that menu everywhere, git's own diff too.

**Options:**

- **(a) The right side through an own URI scheme (FileSystemProvider).** Goes: the items whose `when` asks for `resourceScheme == file`, git's among them. Costs: the file becomes a second document beside its `file:` one (two buffers, unsaved edits in either); whatever works on `file:` only stops on the right side (not each checked: language servers, spell check, Markdown PDF, the Source Control gutter, Timeline, local history); Claude Code gets a `duo:` URI for the selection (how it resolves it is not checked); every save passes through the provider (SECURITY.md). Visual Studio Code's own items (Cut, Copy, Go to …) stay, so it is no own menu either.
- **(b) An own editor (a webview with Monaco).** Goes: every menu but the own. Costs: a rewrite; Monaco is a dependency (the rules: none); loses Visual Studio Code's diff, Undo, search and extensions.
- **(c) Keep Visual Studio Code's menu, put the extension's items first.** Goes: nothing. Costs: the extension's items move to the top group (`navigation`) of the context menu or into a submenu "Duo Diff Edit"; git's items stay below them; the user hides git's title button if wanted.

**Recommendation:** (c). (a) and (b) cost more than one git item that does nothing, and neither gives an own menu. Next step: the owner chooses; for (c) the group in `vscode/package.json` changes, with an e2e check of the menu order.

## Meld's strengths in Duo Diff Edit

Recorded 2026-11-17 12:08:47.405856711. The owner, verbatim: »vedno bolj se nagibam k kustumizaciji Meld orodja, saj ima najlepšo vizualizacijo ujemanja blokov in prenose, omogoča celo 3 way merge« ("I lean more and more towards customising Meld: it shows best which blocks match, and the copies, and even does a 3-way merge"), then »ali pa če ti preneseš funkcionalnost sem« ("or you bring that here"). The measure is no loss: nothing that works in the diff now may stop working. Moving to Meld (3.22.3 is installed, GPL-2+) would lose Claude Code's selected lines, Markdown PDF, cSpell and the SAVE events, and needs a program of its own in Python and GTK; not pursued while the features come here.

- **Done in 0.2.3: ← and → in the gutter beside each block**, on hover, as in Meld (menu `diffEditor/gutter/hunk`, proposed API `contribDiffEditorGutterToolBarMenus`). Measured: with `--enable-proposed-api stutek.duo-diff-edit` the gutter shows Prefer Mine and Accept Suggestion (Visual Studio Code's Revert Block goes under More Actions); without it only Revert Block, the extension runs as before and Visual Studio Code logs two errors about the proposal. The owner turns it on in `~/.vscode/argv.json`. Risk: a proposed API may change with any release; the button over the block, the submenu and the keys stay.
- **Done in 0.2.3: words.** The cursor on a changed word (key, click, right-click) frames the change on both sides, what a copy takes and what it overwrites; after a copy of words the cursor goes on to the next changed word; Accept Suggested Words and Prefer My Words head the submenu. Measured: a right-click on a changed word moves the cursor there (56 ms) and the frame follows while the menu is open (209 ms). A hover with command links was not built: the right-click does it in one place with what exists.
- **Not built: curves between the sides.** No API draws in a diff editor (`vscode.d.ts` has only `TabInputTextDiff`). Visual Studio Code's diff already sets each pair of blocks on the same rows, with filler where a side has none, which is what Meld's curves show. A number or colour per pair on both sides is possible (decorations per editor); not built, as the rows already pair the blocks and more marks crowd the text. Next step: only if the owner misses which block pairs with which.
- **Idea without need: a 3-way merge.** The owner: »sedaj 3-way merge-a ne pogrešam« ("I do not miss a 3-way merge now"). Measured that it is possible: `_open.mergeEditor` (an internal command, as git uses it) opens Visual Studio Code's merge editor with the extension's own base, proposal and the user's text, the result in the user's file as a text editor (`file:`, Markdown, selection events fire, so Claude Code sees the lines). An internal command may change without notice.
