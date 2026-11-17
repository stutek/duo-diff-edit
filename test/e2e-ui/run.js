// End-to-end test of the two-file diff, run by Visual Studio Code itself (--extensionTestsPath) next to the
// Duo Diff Edit extension installed from the .vsix. It plays the agent (writes the request and the proposal on
// disk) and the user (cursor, copy commands, the built-in Revert Block, saving), and checks what each side of the
// diff then holds. One line per check goes to $DUO_E2E_RESULT; scripts/e2e-vscode.py prints them.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
    const saves = path.join(process.env.XDG_RUNTIME_DIR, 'duo-diff-edit-events', 'saves');
    check(await until(() => / SAVE manual left /.test(fs.readFileSync(saves, 'utf8')) && fs.readFileSync(saves, 'utf8').trimEnd().endsWith(` left ${file}`), 3000),
      'events: a save by the user (not files.autoSave) on the left is one line, with the user\'s file');

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
    const api = vscode.extensions.getExtension('stutek.duo-diff-edit').exports;
    const m = api && api.mirrored();
    check(m && m.uri === left.uri.toString() && m.range.join(',') === '0,6,0,10',
      `Next Changed Words: the same word is also shown on the left (${m && m.range})`);
    check(vscode.window.activeTextEditor === ed && sel(ed) === '0,6,0,10', 'Next Changed Words: the focus and selection stay on the right');
    check(m && m.mine && m.mine.join(',') === '0,6,0,10', `Next Changed Words: framed on the right too, both what a copy takes and what it overwrites (${m && m.mine})`);
    ed.selection = new vscode.Selection(1, 0, 1, 0);
    check(await until(() => !api.mirrored(), 2000), 'Next Changed Words: the left shows nothing once the selection leaves the word');
    // the cursor put on a changed word by a click or a key (a right-click puts it there too): framed on both sides
    ed.selection = new vscode.Selection(0, 8, 0, 8);
    await vscode.commands.executeCommand('cursorLeft');
    const f = await until(() => api.mirrored(), 2000) && api.mirrored();
    check(f && f.range.join(',') === '0,6,0,10' && f.mine.join(',') === '0,6,0,10',
      `cursor on a changed word: the change is framed on both sides (${f && f.range} / ${f && f.mine})`);
    ed.selection = new vscode.Selection(0, 6, 0, 10);
    await vscode.commands.executeCommand('duoDiffEdit.copyWordsLeft');
    check(await until(() => left.lineAt(0).text === 'alpha BETA gamma delta', 3000), 'Copy Changed Words Left: only that word goes to the left');
    check(await until(() => sel(ed) === '0,17,0,22', 2000), `Copy Changed Words: the cursor goes on to the next changed word (${sel(ed)})`);
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
    check(vscode.workspace.getConfiguration('diffEditor').get('codeLens') === true, 'lenses: on in diffs by default (configurationDefaults)');
    let titles = [];
    await until(async () => {
      const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', right.uri);
      titles = (ls || []).filter((l) => l.command && l.range.start.line === 1).map((l) => l.command.title);
      return titles.some((x) => x.includes('Accept suggestion')) && titles.some((x) => x.includes('Prefer mine'));
    }, 3000);
    check(titles.some((x) => x.includes('Accept suggestion')) && titles.some((x) => x.includes('Prefer mine')),
      `lenses: Accept suggestion and Prefer mine over the block at the cursor (${JSON.stringify(titles)})`);
    await vscode.commands.executeCommand('duoDiffEdit.copyRight');
    check(await until(() => right.getText() === 'p one\nP TWO\nend\n', 3000), `Copy Block Right: of two changed lines one below the other, only the cursor's (${JSON.stringify(right.getText())})`);
    check(fs.readFileSync(saves, 'utf8').includes(` ACCEPT 2-2 ${file}\n`), 'events: Accept Suggestion is a line with the lines of the user\'s file');
    ed.selection = new vscode.Selection(0, 0, 1, 0);
    await vscode.commands.executeCommand('duoDiffEdit.copyRight');
    check(await until(() => right.getText() === 'P ONE\nP TWO\nend\n', 3000), 'Copy Block Right: a whole-line selection takes that line');
    await right.save();

    // Undo on the side a copy came from undoes the copy on the other side (as in Meld)
    const mineEnd = new vscode.WorkspaceEdit();
    mineEnd.replace(right.uri, right.lineAt(2).range, 'END');
    await vscode.workspace.applyEdit(mineEnd);
    ed = await cursorOn('right', 2);
    await vscode.commands.executeCommand('duoDiffEdit.copyLeft');
    check(await until(() => left.lineAt(2).text === 'END', 3000), 'Copy Block Left: before the undo');
    check(fs.readFileSync(saves, 'utf8').includes(` PREFER 3-3 ${file}\n`), 'events: Prefer Mine is a line, so the agent rethinks the block');
    ed = await cursorOn('right', 2);
    await vscode.commands.executeCommand('duoDiffEdit.undo');
    check(await until(() => left.lineAt(2).text === 'end', 3000) && right.lineAt(2).text === 'END',
      `Undo on the right: undoes the copy on the left, keeps the right (${JSON.stringify([left.lineAt(2).text, right.lineAt(2).text])})`);
    await vscode.commands.executeCommand('duoDiffEdit.redo');
    check(await until(() => left.lineAt(2).text === 'END', 3000), 'Redo on the right: the copy is back on the left');
    // the user types on the right after the copy: the first Undo takes the typing, the second the copy
    const typed = new vscode.WorkspaceEdit();
    typed.insert(right.uri, new vscode.Position(0, 0), 'x');
    await vscode.workspace.applyEdit(typed);
    await vscode.commands.executeCommand('duoDiffEdit.undo');
    check(await until(() => right.lineAt(0).text === 'P ONE', 3000) && left.lineAt(2).text === 'END', 'Undo on the right: first its own typing');
    await vscode.commands.executeCommand('duoDiffEdit.undo');
    check(await until(() => left.lineAt(2).text === 'end', 3000) && right.lineAt(2).text === 'END', 'Undo on the right: then the copy, as in one editor');
    await right.save();

    // agreed, unstaged lines: alike on both sides, not yet in the git index; Stage puts only those into the index
    const repoDir = path.dirname(file), gitc = (...a) => execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8' });
    const setRight = async (text) => {
      const e = new vscode.WorkspaceEdit();
      e.replace(right.uri, new vscode.Range(0, 0, right.lineCount, 0), text);
      await vscode.workspace.applyEdit(e);
      await right.save();
    };
    await setRight('one\ntwo\nthree\n');
    fs.writeFileSync(proposal, 'one\ntwo\nthree\n');
    await until(() => left.getText() === 'one\ntwo\nthree\n', 5000);
    gitc('add', 'cv.md');
    await setRight('one\nTWO\nTHREE\n');
    fs.writeFileSync(proposal, 'one\nTWO\nthree\n');
    check(await until(() => left.getText() === 'one\nTWO\nthree\n', 5000), 'agreed: the left loads the proposal with the same second line');
    await cursorOn('right', 0);
    let stages = [];
    await until(async () => {
      const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', right.uri);
      stages = (ls || []).filter((l) => l.command && l.command.command === 'duoDiffEdit.stageAgreed');
      return stages.length > 0;
    }, 10000);
    check(stages.length === 1 && stages[0].range.start.line === 1,
      `agreed: one Stage button, over the line alike on both sides and not in the index (${JSON.stringify(stages.map((l) => l.range.start.line))})`);
    if (stages.length) await vscode.commands.executeCommand(stages[0].command.command, ...stages[0].command.arguments);
    check(await until(() => gitc('show', ':cv.md') === 'one\nTWO\nthree\n', 5000),
      `Stage: only the agreed line enters the index, not the one the sides differ in (${JSON.stringify(gitc('show', ':cv.md'))})`);
    check(fs.readFileSync(saves, 'utf8').includes(` STAGE 2-2 ${file}\n`), 'events: Stage is a line too');
    check(fs.readFileSync(file, 'utf8') === 'one\nTWO\nTHREE\n', 'Stage: the file on disk stays as it is');

    // Stage Mine: your text where the sides differ too (the proposal has 'three', you have 'THREE'); never the proposal's
    const edIdx = await cursorOn('right', 2);
    let mine = [];
    await until(async () => {
      const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', right.uri);
      mine = (ls || []).filter((l) => l.command && l.command.command === 'duoDiffEdit.stageMine');
      return mine.length > 0;
    }, 10000);
    check(mine.length === 1 && mine[0].range.start.line === 2, `Stage mine: one button over your change at the cursor (${JSON.stringify(mine.map((l) => l.range.start.line))})`);
    check(edIdx && edIdx.document === right, 'Stage mine: the cursor is on your file');
    await vscode.commands.executeCommand('duoDiffEdit.stageMine');
    check(await until(() => gitc('show', ':cv.md') === 'one\nTWO\nTHREE\n', 5000),
      `Stage mine: your text enters the index, not the proposal (${JSON.stringify(gitc('show', ':cv.md'))})`);
    check(fs.readFileSync(proposal, 'utf8') === 'one\nTWO\nthree\n', 'Stage mine: the proposal is untouched');
    // Stage Selected Lines (the same command, from the title or the context menu): every change the selection
    // touches, and only those; git's own Stage Selected Ranges stages nothing in this diff
    await setRight('ONE\nTWO\nTHREE\nfour\n');
    const edSel = await cursorOn('right', 0);
    const menus = vscode.extensions.getExtension('stutek.duo-diff-edit').packageJSON.contributes.menus;
    const own = (menus['duoDiffEdit.menu'] || []).map((x) => x.command.replace('duoDiffEdit.', ''));
    check(!menus['editor/title'].some((x) => ['duoDiffEdit.copyLeft', 'duoDiffEdit.copyRight'].includes(x.command)),
      'menus: no copy buttons in the title, far from the text; they are over the block, in the context menu and on the keys');
    check(menus['editor/title'].some((x) => x.command === 'duoDiffEdit.stageMine') &&
      menus['editor/context'].some((x) => x.submenu === 'duoDiffEdit.menu' && x.group.startsWith('navigation')) &&
      ['copyRight', 'copyLeft', 'copyWordsRight', 'copyWordsLeft', 'nextBlock', 'previousBlock', 'nextWords', 'previousWords',
        'stageMine', 'stageAgreed', 'stageFile'].every((c) => own.includes(c)) && own.slice(0, 2).join() === 'copyWordsRight,copyWordsLeft',
      `menus: Stage Selected Lines in the title; the context menu opens with the submenu Duo Diff Edit, which holds every command of the diff (${JSON.stringify(own)})`);
    if (edSel) edSel.selection = new vscode.Selection(0, 0, 1, 3);   // ONE and the staged TWO; not four
    await vscode.commands.executeCommand('duoDiffEdit.stageMine');
    check(await until(() => gitc('show', ':cv.md') === 'ONE\nTWO\nTHREE\n', 5000),
      `Stage Selected Lines: the change the selection touches enters the index, the one below it does not (${JSON.stringify(gitc('show', ':cv.md'))})`);
    // Stage File: every change of your file at once
    await cursorOn('right', 0);
    await vscode.commands.executeCommand('duoDiffEdit.stageFile');
    check(await until(() => gitc('show', ':cv.md') === 'ONE\nTWO\nTHREE\nfour\n', 5000),
      `Stage file: the whole of your text enters the index (${JSON.stringify(gitc('show', ':cv.md'))})`);
    // Stage Agreed Lines from the submenu: a menu passes (uri, context), not lines, so every agreed line is staged
    await setRight('one\nTWO\nTHREE\nfour\nfive\n');   // the first line differs from the proposal, the added last agrees
    fs.writeFileSync(proposal, 'ONE\nTWO\nTHREE\nfour\nfive\n');
    await until(() => left.getText() === 'ONE\nTWO\nTHREE\nfour\nfive\n', 5000);
    await cursorOn('right', 0);
    await new Promise((r) => setTimeout(r, 1000));   // the agreed runs follow both sides a moment after a change
    await vscode.commands.executeCommand('duoDiffEdit.stageAgreed', right.uri, {});
    check(await until(() => gitc('show', ':cv.md') === 'ONE\nTWO\nTHREE\nfour\nfive\n', 5000),
      `Stage Agreed Lines from a menu: the agreed line enters the index, the one the sides differ in does not (${JSON.stringify(gitc('show', ':cv.md'))})`);

    // a block with no lines on one side (lines deleted there): Next Changed Block stops at it, and both copies work
    for (const [name, mineText, propText, side, took, gave, other] of [
      ['deleted on the right', 'a\nb\nc\nd\nE\n', 'a\nb\nX\nc\nd\ne\n', 'right', 'a\nb\nX\nc\nd\nE\n', 'a\nb\nc\nd\ne\n', 'left'],
      ['deleted on the left', 'a\nb\nY\nc\nd\nE\n', 'a\nb\nc\nd\ne\n', 'left', 'a\nb\nc\nd\nE\n', 'a\nb\nY\nc\nd\ne\n', 'right']]) {
      await setRight(mineText);
      fs.writeFileSync(proposal, propText);
      check(await until(() => left.getText() === propText, 5000), `${name}: the left loads the proposal`);
      let e = await cursorOn(side, 0);
      await vscode.commands.executeCommand('duoDiffEdit.nextBlock');
      check(e && e.selection.active.line === 2, `${name}: Next Changed Block stops at the empty place, line 3 on the ${side} (${e && e.selection.active.line + 1})`);
      await vscode.commands.executeCommand('duoDiffEdit.copyRight');
      check(await until(() => right.getText() === took, 3000), `${name}: → from there makes that block of the right as the left (${JSON.stringify(right.getText())})`);
      await setRight(mineText);
      // the cursor already on the line below the gap (a click there, or left there by a copy): the gap is still ahead
      e = await cursorOn(side, 2);
      await vscode.commands.executeCommand('duoDiffEdit.nextBlock');
      const g = api.mirrored();
      check(e && e.selection.active.line === 2 && g && g.uri === (other === 'left' ? left : right).uri.toString() && g.range.join(',') === '2,0,2,1',
        `${name}: from the line below the gap, Next Changed Block goes to the gap and frames the ${other} side's line (${e && e.selection.active.line + 1}, ${g && g.range})`);
      await vscode.commands.executeCommand('duoDiffEdit.copyLeft');
      check(await until(() => left.getText() === gave, 3000), `${name}: ← from there makes that block of the left as the right (${JSON.stringify(left.getText())})`);
      const back = new vscode.WorkspaceEdit();   // the left as the proposal again
      back.replace(left.uri, new vscode.Range(0, 0, left.lineCount, 0), propText);
      await vscode.workspace.applyEdit(back);
      await left.save();
      check(await until(() => left.getText() === propText && !left.isDirty, 3000), `${name}: the left is the proposal again`);
      e = await cursorOn(side, 2);
      await vscode.commands.executeCommand('duoDiffEdit.nextBlock');
      await vscode.commands.executeCommand('duoDiffEdit.nextBlock');
      check(e && e.selection.active.line === 4, `${name}: a second Next Changed Block goes on past the gap, to line 5 (${e && e.selection.active.line + 1})`);
    }

    // ← and → in the diff's gutter (a proposed API, shown where the user enables it): the hovered block, not the cursor's
    await setRight('a\nB\nc\nD\ne\n');
    fs.writeFileSync(proposal, 'a\nb\nc\nd\ne\n');
    await until(() => left.getText() === 'a\nb\nc\nd\ne\n', 5000);
    await cursorOn('right', 1);
    const hunk = (line) => ({ mapping: { original: { startLineNumber: line, endLineNumberExclusive: line + 1 },
      modified: { startLineNumber: line, endLineNumberExclusive: line + 1 } }, originalUri: left.uri, modifiedUri: right.uri });
    check(menus['diffEditor/gutter/hunk'].map((x) => x.command).join() === 'duoDiffEdit.copyLeft,duoDiffEdit.copyRight',
      'gutter: ← and → over each block of the diff');
    await vscode.commands.executeCommand('duoDiffEdit.copyRight', hunk(4));
    check(await until(() => right.getText() === 'a\nB\nc\nd\ne\n', 3000), `gutter →: the block under the mouse (line 4) comes to the right, not the cursor's (${JSON.stringify(right.getText())})`);
    await vscode.commands.executeCommand('duoDiffEdit.copyLeft', hunk(2));
    check(await until(() => left.getText() === 'a\nB\nc\nd\ne\n', 3000), `gutter ←: the block under the mouse (line 2) goes to the left (${JSON.stringify(left.getText())})`);
    await vscode.commands.executeCommand('workbench.action.files.revert');

    // the keys, as Meld's (Visual Studio Code on a display without a window manager has no key focus to press them)
    const keys = Object.fromEntries(vscode.extensions.getExtension('stutek.duo-diff-edit').packageJSON.contributes.keybindings
      .map((k) => [k.key, k.command.replace('duoDiffEdit.', '')]));
    const want = { 'alt+left': 'copyLeft', 'alt+right': 'copyRight', 'ctrl+z': 'undo', 'ctrl+shift+z': 'redo', 'ctrl+y': 'redo', 'alt+up': 'previousBlock', 'alt+down': 'nextBlock',
      'shift+alt+left': 'copyWordsLeft', 'shift+alt+right': 'copyWordsRight', 'shift+alt+up': 'previousWords', 'shift+alt+down': 'nextWords' };
    check(JSON.stringify(keys) === JSON.stringify(want), `keys: ${JSON.stringify(keys)}`);
  } catch (e) {
    check(false, `no exception: ${e && e.stack || e}`);
  }
  say(failed ? `ui: ${failed} failed` : 'ui: all passed');
};
