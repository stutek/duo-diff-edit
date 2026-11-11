// End-to-end test of the two-file diff, run by Visual Studio Code itself (--extensionTestsPath) next to the
// Duo Diff Edit extension installed from the .vsix. It plays the agent (writes the request and the proposal on
// disk) and the user (cursor, copy commands, the built-in Revert Block, saving), and checks what each side of the
// diff then holds. One line per check goes to $DUO_E2E_RESULT; scripts/e2e-vscode.py prints them.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const out = process.env.DUO_E2E_RESULT;
const file = process.env.DUO_E2E_FILE;   // the user's file, in the opened folder
const say = (line) => fs.appendFileSync(out, `${line}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    try { if (await pred()) return true; } catch { /* not yet */ }
  }
  return false;
}
let failed = 0;
function check(ok, what) { say(`${ok ? 'ok    ' : 'FAIL  '}${what}`); if (!ok) failed++; }

const diffTab = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
  .find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.fsPath === file);
const docOf = (uri) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
async function cursorOn(side, line) {   // side: the diff's left (secondary) or right (primary) editor
  const t = diffTab();
  await vscode.commands.executeCommand('vscode.diff', t.input.original, t.input.modified, t.label, { viewColumn: t.group.viewColumn });
  await vscode.commands.executeCommand(side === 'left' ? 'workbench.action.compareEditor.focusSecondarySide' : 'workbench.action.compareEditor.focusPrimarySide');
  const want = side === 'left' ? t.input.original : t.input.modified;
  await until(() => vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString() === want.toString(), 3000);
  const ed = vscode.window.activeTextEditor;
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  say(`note  cursor ${side}: editor ${ed && ed.document.uri}, active tab ${tab && tab.label}`);
  ed.selection = new vscode.Selection(line, 0, line, 0);
  return ed;
}

exports.run = async () => {
  try {
    const box = path.join(process.env.XDG_RUNTIME_DIR, 'duo-diff-edit');
    const proposal = path.join(process.env.XDG_RUNTIME_DIR, 'duo-diff-edit-proposals', file.replace(/^\/+/, ''));
    const start = fs.readFileSync(file, 'utf8');

    // a tab with the diff's title in the main window, as a reload restores one: the request must not open there
    const stale = path.join(path.dirname(file), 'stale.md');
    fs.writeFileSync(stale, 'stale\n');
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(stale), vscode.Uri.file(stale), 'stale.md (proposal ↔ yours)',
      { viewColumn: vscode.ViewColumn.One, preview: false });
    const main = vscode.window.tabGroups.activeTabGroup;

    // the agent asks for the diff (as a 📖 click does)
    fs.mkdirSync(box, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(box, `${Date.now()}`), `pair ${file}\n`);
    check(await until(() => diffTab(), 20000), 'pair: the diff opens');
    const t = diffTab();
    check(t && t.group !== main && vscode.window.tabGroups.all.length > 1,
      'pair: in a window of its own, not in a group that only has a diff with the same kind of title');
    check(t && t.input.original.scheme === 'duo-diff-edit-proposal' && t.input.original.path === t.input.modified.path,
      'pair: left is the proposal of the same file, right is the file');
    check(fs.existsSync(proposal) && fs.readFileSync(proposal, 'utf8') === start, 'pair: a new proposal starts as a copy of the file');
    check(fs.existsSync(proposal) && (fs.statSync(proposal).mode & 0o777) === 0o600, 'pair: the proposal is private (mode 600)');
    check(await until(() => docOf(t.input.original), 5000), 'pair: the left side is open as a document');
    const left = docOf(t.input.original), right = await vscode.workspace.openTextDocument(t.input.modified);

    // the agent writes a proposal: the left side follows without focus or a reload click
    const proposed = start.replace('second line', 'second line, proposed').replace('fourth line', 'fourth line, proposed');
    fs.writeFileSync(proposal, proposed);
    check(await until(() => left.getText() === proposed, 5000), 'left: reloads by itself when the agent writes the proposal');

    // the user takes the first proposal (Copy Block Right, cursor on the right)
    await cursorOn('right', 1);
    await vscode.commands.executeCommand('duoDiffEdit.copyRight');
    check(await until(() => right.getText() === start.replace('second line', 'second line, proposed'), 3000),
      'Copy Block Right: the block at the cursor goes to the right, the other stays');

    // the user writes their own text in the second block and copies it to the left (Meld's push left)
    const edit = new vscode.WorkspaceEdit();
    edit.replace(right.uri, right.lineAt(3).range, 'fourth line, mine');
    await vscode.workspace.applyEdit(edit);
    await cursorOn('right', 3);
    await vscode.commands.executeCommand('duoDiffEdit.copyLeft');
    check(await until(() => left.getText() === right.getText(), 3000), 'Copy Block Left: the right block replaces the proposal');
    await left.save();
    check(await until(() => fs.readFileSync(proposal, 'utf8') === right.getText(), 3000), 'left: saving writes the proposal file');

    // the built-in Revert Block (the gutter arrow →) works on this diff too
    fs.writeFileSync(proposal, right.getText().replace('third line', 'third line, proposed'));
    check(await until(() => left.getText().includes('third line, proposed'), 5000), 'left: reloads again after a save');
    // as the gutter arrow calls it (with the cursor it needs real text focus, which a display without a window
    // manager does not give): the diff's two URIs and the block's ranges, 1-based
    // manager does not give): the diff's two URIs and the block's ranges, 1-based. It does nothing until the diff is
    // computed again after the reload, so it is called until the block arrives.
    const len = (d) => d.lineAt(2).text.length + 1;
    const revert = () => vscode.commands.executeCommand('diffEditor.revert', {
      originalUri: t.input.original, modifiedUri: t.input.modified,
      mapping: { innerChanges: [{ originalRange: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: len(left) },
        modifiedRange: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: len(right) } }] },
    });
    check(await until(async () => { await revert(); return right.getText().includes('third line, proposed'); }, 5000),
      'Revert Block (→): copies the proposal to the right');
    await right.save();
    check(fs.readFileSync(file, 'utf8') === right.getText(), 'right: saving writes the user\'s file');

    // unsaved edits on the left survive the agent writing the proposal
    const e2 = new vscode.WorkspaceEdit();
    e2.insert(left.uri, new vscode.Position(0, 0), 'unsaved ');
    await vscode.workspace.applyEdit(e2);
    fs.writeFileSync(proposal, 'the agent overwrote it\n');
    await wait(2000);
    check(left.isDirty && left.getText().startsWith('unsaved '), 'left: unsaved edits are not replaced by an agent write');
    // leave no dirty editor behind: Revert File in the diff reverts only its right side, so the left on its own
    await vscode.window.showTextDocument(left.uri, { preview: true });
    await vscode.commands.executeCommand('workbench.action.files.revert');
    check(await until(() => !left.isDirty, 3000), 'left: Revert File discards the unsaved edits');

    // the provider serves the proposals directory only
    let refused = false;
    try { await vscode.workspace.fs.readFile(vscode.Uri.from({ scheme: 'duo-diff-edit-proposal', path: '/' })); } catch { refused = true; }
    check(refused, 'provider: no file outside the proposals directory');

    // both sides load what another program writes to disk, without focus; the right side by Visual Studio Code's watcher
    const proposed2 = 'alpha beta gamma delta\nsame\nold one\n', mine2 = 'alpha BETA gamma DELTA\nsame\nnew one\n';
    fs.writeFileSync(proposal, proposed2);
    fs.writeFileSync(file, mine2);
    check(await until(() => left.getText() === proposed2, 5000), 'left: loads the proposal from disk');
    // Visual Studio Code's watcher does that; with no inotify instance left it cannot, and the extension warns
    // (scripts/e2e-vscode.py checks the warning against the watcher's log)
    if (await until(() => right.getText() === mine2, 10000)) say('ok    right: loads the file from disk when another program writes it');
    else {
      say('note  right: not loaded from disk');
      await wait(5000);   // the extension's 1 s poll and 3 s grace
      await vscode.window.showTextDocument(right.uri, { preview: true });
      await vscode.commands.executeCommand('workbench.action.files.revert');   // load it, as focus would
    }
    check(await until(() => right.getText() === mine2, 3000), 'right: holds the file as on disk');

    // word by word (Shift+Alt+↓ / ↑, ← / →): two changed words in one line move one at a time
    const sel = (ed) => [ed.selection.start.line, ed.selection.start.character, ed.selection.end.line, ed.selection.end.character].join(',');
    let ed = await cursorOn('right', 0);
    await vscode.commands.executeCommand('duoDiffEdit.nextWords');
    check(sel(ed) === '0,6,0,10', `Next Changed Words: selects the first changed word on the right (${sel(ed)})`);
    await vscode.commands.executeCommand('duoDiffEdit.copyWordsLeft');
    check(await until(() => left.lineAt(0).text === 'alpha BETA gamma delta', 3000), 'Copy Changed Words Left: only that word goes to the left');
    await vscode.commands.executeCommand('duoDiffEdit.nextWords');
    check(sel(ed) === '0,17,0,22', `Next Changed Words: then the next one in the same line (${sel(ed)})`);
    ed = await cursorOn('left', 0);
    await vscode.commands.executeCommand('duoDiffEdit.nextWords');
    check(sel(ed) === '0,17,0,22', `Next Changed Words: on the left side too (${sel(ed)})`);
    await vscode.commands.executeCommand('duoDiffEdit.copyWordsRight');
    check(await until(() => right.lineAt(0).text === 'alpha BETA gamma delta', 3000), 'Copy Changed Words Right: only that word goes to the right');

    // block by block (Alt+↓ / ↑), round past the last
    await vscode.commands.executeCommand('duoDiffEdit.nextBlock');
    check(ed.selection.active.line === 2, `Next Changed Block: goes to the next block (line ${ed.selection.active.line})`);
    await vscode.commands.executeCommand('duoDiffEdit.previousBlock');
    check(ed.selection.active.line === 2, 'Previous Changed Block: goes round to the last when none is before');
    await vscode.commands.executeCommand('duoDiffEdit.copyRight');
    check(await until(() => right.getText() === left.getText(), 3000), 'Copy Block Right after Next Changed Block: the sides are equal');
    await Promise.all([left.save(), right.save()]);

    // two changed lines one right below the other (a paragraph per line): Alt+→ takes the cursor's line only,
    // and a selection of a whole line (ending at the start of the next) takes that line only
    const whole = new vscode.WorkspaceEdit();
    whole.replace(right.uri, new vscode.Range(0, 0, right.lineCount, 0), 'p one\np two\nend\n');
    await vscode.workspace.applyEdit(whole);
    await right.save();
    fs.writeFileSync(proposal, 'P ONE\nP TWO\nend\n');
    check(await until(() => left.getText() === 'P ONE\nP TWO\nend\n', 5000), 'left: loads the next proposal');
    ed = await cursorOn('right', 1);
    await vscode.commands.executeCommand('duoDiffEdit.copyRight');
    check(await until(() => right.getText() === 'p one\nP TWO\nend\n', 3000), `Copy Block Right: of two changed lines one below the other, only the cursor's (${JSON.stringify(right.getText())})`);
    ed.selection = new vscode.Selection(0, 0, 1, 0);
    await vscode.commands.executeCommand('duoDiffEdit.copyRight');
    check(await until(() => right.getText() === 'P ONE\nP TWO\nend\n', 3000), 'Copy Block Right: a whole-line selection takes that line');
    await right.save();

    // the keys, as Meld's (Visual Studio Code on a display without a window manager has no key focus to press them)
    const keys = Object.fromEntries(vscode.extensions.getExtension('stutek.duo-diff-edit').packageJSON.contributes.keybindings
      .map((k) => [k.key, k.command.replace('duoDiffEdit.', '')]));
    const want = { 'alt+left': 'copyLeft', 'alt+right': 'copyRight', 'alt+up': 'previousBlock', 'alt+down': 'nextBlock',
      'shift+alt+left': 'copyWordsLeft', 'shift+alt+right': 'copyWordsRight', 'shift+alt+up': 'previousWords', 'shift+alt+down': 'nextWords' };
    check(JSON.stringify(keys) === JSON.stringify(want), `keys: ${JSON.stringify(keys)}`);
  } catch (e) {
    check(false, `no exception: ${e && e.stack || e}`);
  }
  say(failed ? `ui: ${failed} failed` : 'ui: all passed');
};
