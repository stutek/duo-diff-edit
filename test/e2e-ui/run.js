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

    // the agent asks for the diff (as a 📖 click does)
    fs.mkdirSync(box, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(box, `${Date.now()}`), `pair ${file}\n`);
    check(await until(() => diffTab(), 20000), 'pair: the diff opens');
    const t = diffTab();
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
    await vscode.commands.executeCommand('workbench.action.files.revert');   // leave no dirty editor behind

    // the provider serves the proposals directory only
    let refused = false;
    try { await vscode.workspace.fs.readFile(vscode.Uri.from({ scheme: 'duo-diff-edit-proposal', path: '/' })); } catch { refused = true; }
    check(refused, 'provider: no file outside the proposals directory');
  } catch (e) {
    check(false, `no exception: ${e && e.stack || e}`);
  }
  say(failed ? `ui: ${failed} failed` : 'ui: all passed');
};
