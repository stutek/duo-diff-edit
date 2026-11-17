// Duo Diff Edit: the agent's proposal (left) against the user's file (right) in an auxiliary window, as in Meld.
// Both sides are editable. The left side is served by a file system provider of its own (Proposals), which polls
// the proposal on disk, so the side reloads the moment the agent writes it, without an inotify watch. A block moves
// across with the built-in gutter arrow (→, Revert Block) or with Copy Block Left / Copy Block Right (editor title,
// context menu, Alt+← / Alt+→ as in Meld; blocks.js finds the block at the cursor); Alt+↑ / Alt+↓ go to the previous
// or next block. With Shift the same keys work word by word, inside a line too.
//
// The older mode, a diff of the git index (left, git: URI, ref ~) against the editor buffer, stays for "git"
// requests and the Explorer menu: the agent proposes into the index, the user stages with "Stage Block" (+).
//
// Requests arrive in a mailbox directory (mailbox.js: where it is, who takes which request, what is refused).
//
// Window placement on the physically largest monitor and raising an existing window are done with a KWin script
// (KDE Plasma 6); elsewhere the auxiliary window opens where VS Code places it.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const box = require('./mailbox');
const { blocks, touched, replacement, words, touchedWords, wordReplacement, apply } = require('./blocks');

// a helper that hangs (qdbus6 without a session bus waits for one) must not stall opening the diff
const run = (cmd, args) => new Promise((r) => execFile(cmd, args, { timeout: 3000 }, (err, out) => r(err ? '' : out.trim())));
const SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');   // older JS engines end a string at them
const literal = (v) => JSON.stringify(v).replace(SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
let log;                 // Output → Duo Diff Edit
const KWIN = `
const chat = workspace.activeWindow;
const raise = (w) => { w.minimized = false; workspace.activeWindow = w; };
if (TITLE) {   // existing auxiliary window: bring it to the front (on Wayland VS Code cannot raise its own window)
  const w = workspace.windowList().find((w) => w.resourceClass == 'code_code' && w.caption.includes(TITLE) && w.caption.includes(WORKSPACE));
  if (w) raise(w);
}
workspace.windowAdded.connect((w) => {   // new auxiliary window: largest screen other than the chat's, maximized, raised
  if (!chat || w.resourceClass != 'code_code') return;
  const here = chat.output.name, target = workspace.screens.find((s) => s.name == (OUTPUTS.find((n) => n != here) || here));
  if (target) workspace.sendClientToScreen(w, target);
  w.setMaximize(true, true);
  raise(w);
});`;
async function kwin(dir, title = '') {   // KWin script for 4 s: place a new window, raise the window with the title; no-op without KDE
  if (process.platform !== 'linux' || !process.env.DBUS_SESSION_BUS_ADDRESS) return;   // KWin is reached over the session bus
  const j = await run('kscreen-doctor', ['-j']);
  if (!j) return;
  let outputs;
  try {
    const diag = (o) => o.sizeMM.width ** 2 + o.sizeMM.height ** 2;
    outputs = JSON.parse(j).outputs.filter((o) => o.enabled).sort((a, b) => diag(b) - diag(a)).map((o) => o.name);
  } catch (e) { return void log.warn(`kscreen-doctor: ${e}`); }
  const name = `duo-diff-edit-${process.pid}-${Date.now()}`, f = path.join(dir, `${name}.js`);   // one file per call: calls overlap
  fs.mkdirSync(dir, { recursive: true });
  const ws = ` - ${vscode.workspace.name} - `;   // window title: "<tab> - <workspace> - Visual Studio Code"
  fs.writeFileSync(f, `const OUTPUTS = ${literal(outputs)}; const TITLE = ${literal(title)}; const WORKSPACE = ${literal(ws)};${KWIN}`, { mode: 0o600 });
  const id = await run('qdbus6', ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.loadScript', f, name]);
  if (!id) return void fs.rmSync(f, { force: true });
  await run('qdbus6', ['org.kde.KWin', `/Scripting/Script${id}`, 'org.kde.kwin.Script.run']);
  log.info(`KWin script ${name}${title ? ` raises "${title}"` : ' places the new window'}`);
  setTimeout(async () => {
    await run('qdbus6', ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.unloadScript', name]);
    fs.rmSync(f, { force: true });
  }, 4000);
}

const gitApi = async () => {
  const git = vscode.extensions.getExtension('vscode.git');
  return (git.isActive ? git.exports : await git.activate()).getAPI(1);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SUFFIX = ' (stage ↔ buffer)';   // diff titles; group() finds the auxiliary window by them
const PAIR = ' (proposal ↔ yours)';
let storage;              // extension global storage: the KWin script
let auxGroup;             // tab group in the auxiliary window this extension host opened
let roots = [];           // this window's workspace folders (mailbox.rootsOf)
// Only a window opened in this run counts: after a reload, a group with one of these diffs may be a restored
// window that no longer shows, or the main window, and a diff opened there is never seen.
const group = () => (auxGroup && vscode.window.tabGroups.all.includes(auxGroup) ? auxGroup : undefined);
const isOurDiff = (t) => t.label.endsWith(SUFFIX) || t.label.endsWith(PAIR);
// At start, the diffs a reload restored are closed (unless they hold unsaved edits), so their window does not
// linger next to the one the next request opens.
const closeRestored = () => {
  const stale = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => isOurDiff(t) && !t.isDirty);
  if (stale.length) vscode.window.tabGroups.close(stale).then(() => log.info(`closed ${stale.length} diff(s) restored from before the reload`), (e) => log.warn(`closing restored diffs: ${e}`));
};

// The left side of a pair: the proposal on disk (mailbox.proposalOf), under a scheme of its own whose URI path is
// the user's file. Only files under the proposals directory are served. fs.watchFile polls (no inotify instance,
// which a full fs.inotify.max_user_instances would deny); on a change Visual Studio Code reloads the side unless it
// has unsaved edits, and saving with a newer file on disk shows its usual conflict choice.
const SCHEME = 'duo-diff-edit-proposal';
class Proposals {
  constructor(dir) {
    this.dir = dir;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.emitter.event;
    this.polled = new Map();
  }
  disk(uri) {
    const f = box.proposalOf(uri.fsPath, this.dir);
    if (!f) throw vscode.FileSystemError.NoPermissions(uri);
    return f;
  }
  poll(uri) {
    const key = uri.toString();
    if (this.polled.has(key)) return;
    const f = this.disk(uri);
    const on = (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    };
    fs.watchFile(f, { interval: 500 }, on);
    this.polled.set(key, () => fs.unwatchFile(f, on));
  }
  io(uri, fn) {
    try { return fn(this.disk(uri)); } catch (e) {
      if (e && e.code === 'ENOENT') throw vscode.FileSystemError.FileNotFound(uri);
      throw e;
    }
  }
  watch(uri) { this.poll(uri); return new vscode.Disposable(() => {}); }   // polling stops with the extension
  stat(uri) {
    return this.io(uri, (f) => {
      const s = fs.statSync(f);
      return { type: vscode.FileType.File, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
    });
  }
  readFile(uri) { this.poll(uri); return this.io(uri, (f) => fs.readFileSync(f)); }
  writeFile(uri, content) { this.io(uri, (f) => fs.writeFileSync(f, content, { mode: 0o600 })); }
  readDirectory() { return []; }
  createDirectory(uri) { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri) { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(uri) { throw vscode.FileSystemError.NoPermissions(uri); }
  dispose() { for (const stop of this.polled.values()) stop(); this.polled.clear(); }
}
let proposals;            // Proposals, or undefined when its directory is not safe to use
let proposalsRefused = '';

async function openPair(file) {   // a proposal that does not exist yet starts as a copy of the file: no difference
  if (!proposals) throw new Error(`the proposals directory is not safe to use: ${proposalsRefused}`);
  const disk = box.proposalOf(file, proposals.dir);
  if (!disk) throw new Error(`${file}: no place for its proposal`);
  if (!fs.existsSync(disk)) {
    fs.mkdirSync(path.dirname(disk), { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, disk, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(disk, 0o600);
    log.info(`${file}: no proposal yet, it starts as a copy of the file`);
  }
  const left = vscode.Uri.file(file).with({ scheme: SCHEME });
  return showInAux([[left, vscode.Uri.file(file), `${path.basename(file)}${PAIR}`]]);
}

// The right side is Visual Studio Code's own file:// document, which its file watcher reloads when another program
// writes the file. That watcher needs an inotify instance on Linux; with none left (fs.inotify.max_user_instances)
// it fails, and the side keeps the old text until the window gets focus. This polls the file and says so, once.
// Every diff of two files that shows is watched (watchRights runs on each change of tabs), until it no longer shows.
const rights = new Map();   // file → stop polling
const watchRights = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
  .filter((t) => twoFiles(t.input) && t.input.modified.scheme === 'file').forEach((t) => watchRight(t.input.modified.fsPath));
let warnedWatcher = false;
function watchRight(file) {
  if (rights.has(file)) return;
  const uri = vscode.Uri.file(file).toString();
  const shown = () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => twoFiles(t.input) && t.input.modified.toString() === uri));
  let timer;
  const on = (cur, prev) => {
    if (!shown()) { fs.unwatchFile(file, on); rights.delete(file); return; }
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
    clearTimeout(timer);
    timer = setTimeout(() => {   // time for the watcher to have reloaded it
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
      let disk;
      try { disk = fs.readFileSync(file, 'utf8'); } catch { return; }
      if (!doc || doc.isDirty || doc.getText() === disk.replace(/^﻿/, '')) return;
      log.warn(`${file}: changed on disk, but Visual Studio Code did not load it (its file watcher may have no inotify instance left)`);
      if (warnedWatcher) return;
      warnedWatcher = true;
      vscode.window.showWarningMessage(`Duo Diff Edit: ${path.basename(file)} changed on disk, and Visual Studio Code has not loaded it: its file watcher is not working. Click into the window to load it.${process.platform === 'linux' ? ' The usual cause is no inotify instance left; raise the limit: sudo sysctl -w fs.inotify.max_user_instances=1024' : ''}`);
    }, 3000);
  };
  fs.watchFile(file, { interval: 1000 }, on);
  rights.set(file, () => { clearTimeout(timer); fs.unwatchFile(file, on); });
}

// Copy Block Left / Right: the blocks the cursor or selection touches (the rule of Revert Block, blocks.touched),
// from the other side, in the active diff of two editable documents.
const editable = (u) => u.scheme === 'file' || u.scheme === SCHEME;
const twoFiles = (i) => i instanceof vscode.TabInputTextDiff && editable(i.original) && editable(i.modified);
const eolOf = (d) => (d.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
// The diff of two files whose side the editor shows: active tabs of every group first, because the diff's
// auxiliary window need not hold the active tab group.
function diffOf(ed) {
  if (!ed) return undefined;
  const key = ed.document.uri.toString(), groups = vscode.window.tabGroups.all;
  const t = [...groups.map((g) => g.activeTab), ...groups.flatMap((g) => g.tabs)]
    .find((x) => x && twoFiles(x.input) && (x.input.original.toString() === key || x.input.modified.toString() === key));
  return t && t.input;
}
// The diff at the cursor: its editor, the side the cursor is on ('a' left, 'b' right), both documents, their lines
// and the changed blocks (or, with byWord, the changes word by word); undefined, with a message, when there is none.
async function atCursor(what, byWord, at) {   // at: an editor of the diff with the block selected (the gutter's ← →)
  const ed = at || vscode.window.activeTextEditor, input = diffOf(ed);
  const key = ed && ed.document.uri.toString();
  const side = !input ? '' : key === input.original.toString() ? 'a' : 'b';
  if (!side) {
    log.info(`${what}: no diff of two files at the cursor (editor ${key || 'none'})`);
    return void vscode.window.showInformationMessage('Duo Diff Edit: put the cursor into a diff of two files.');
  }
  const [a, b] = await Promise.all([vscode.workspace.openTextDocument(input.original), vscode.workspace.openTextDocument(input.modified)]);
  const A = a.getText().split(eolOf(a)), B = b.getText().split(eolOf(b));
  const trim = vscode.workspace.getConfiguration('diffEditor').get('ignoreTrimWhitespace', true);
  const list = blocks(A, B, trim);
  if (!list) return void vscode.window.showWarningMessage('Duo Diff Edit: the files differ in too many lines to find the block.');
  return { ed, side, a, b, A, B, list: byWord ? words(A, B, list, trim) : list };
}
const pos = (p) => new vscode.Position(p[0], p[1]);
// The ← and → of the diff's gutter (menu diffEditor/gutter/hunk, a proposed API: shown only where the user enables
// it) pass the hovered block: { mapping: { original, modified: { startLineNumber, endLineNumberExclusive } },
// originalUri, modifiedUri }. Its lines are selected on a side that has them, so copy takes that block, not the cursor's.
function gutterBlock(g) {
  const m = g && g.mapping, side = m && (m.modified.endLineNumberExclusive > m.modified.startLineNumber ? 'modified' : 'original');
  const u = side && g[`${side}Uri`];
  const uri = u instanceof vscode.Uri ? u.toString() : u && u.scheme ? vscode.Uri.from(u).toString() : '';
  const ed = uri && vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri && diffOf(e));
  if (!ed) return undefined;
  const r = m[side], last = Math.max(r.startLineNumber, r.endLineNumberExclusive - 1) - 1;
  ed.selection = new vscode.Selection(r.startLineNumber - 1, 0, last, 0);
  return ed;
}

// The events file (mailbox.events): what the user did that the disk does not tell
let eventsFile;
function emit(what, file) {
  if (!eventsFile) return;
  try {
    if (fs.existsSync(eventsFile) && fs.statSync(eventsFile).size > 1e6) fs.truncateSync(eventsFile);   // a day of events is a few kB
    fs.appendFileSync(eventsFile, box.eventLine(new Date(), what, file), { mode: 0o600 });
  } catch (err) { log.warn(`events: ${err}`); }
}

// The two buttons over the block the cursor is on, in the editor that has the cursor; on the right side also a
// Stage button over each run of agreed, unstaged lines (refreshAgreed)
const lensChanged = new vscode.EventEmitter();
function lenses(doc) {
  const s = doc.uri.scheme === 'file' && agreedOf.get(doc.uri.fsPath);
  const stage = s ? s.runs.map(([f, l]) => new vscode.CodeLens(new vscode.Range(f, 0, f, 0), {
    title: `$(check) Stage agreed line${l > f ? 's' : ''}`, command: 'duoDiffEdit.stageAgreed', arguments: [doc.uri.fsPath, [f, l]],
    tooltip: 'Both sides hold these lines alike; put them into the git index (the file stays as it is)',
  })) : [];
  return [...stage, ...cursorLenses(doc)];
}
function cursorLenses(doc) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document !== doc) return [];
  const input = diffOf(ed);
  if (!input) return [];
  const side = doc.uri.toString() === input.original.toString() ? 'a' : 'b';
  const other = vscode.workspace.textDocuments.find((d) => d.uri.toString() === (side === 'a' ? input.modified : input.original).toString());
  if (!other) return [];
  const [A, B] = side === 'a' ? [doc, other] : [other, doc];
  const list = blocks(A.getText().split(eolOf(A)), B.getText().split(eolOf(B)), vscode.workspace.getConfiguration('diffEditor').get('ignoreTrimWhitespace', true));
  const line = ed.selection.active.line;
  // + Stage mine: your text of the change (index → your file) the cursor is on, not only where the two sides differ
  const g = side === 'b' && agreedOf.get(doc.uri.fsPath);
  const stage = (g ? touched(blocks(g.I, doc.getText().split(eolOf(doc)), false) || [], 'b', line, line) : []).map((k) => {
    const at = Math.min(k.b[0], doc.lineCount - 1);
    return new vscode.CodeLens(new vscode.Range(at, 0, at, 0), { title: '$(add) Stage mine', command: 'duoDiffEdit.stageMine',
      tooltip: 'Put your text of this change into the git index (the file stays as it is)' });
  });
  return [...stage, ...(list ? touched(list, side, line, line) : [])].flatMap((k) => {
    if (k instanceof vscode.CodeLens) return [k];
    const at = new vscode.Range(Math.min(k[side][0], doc.lineCount - 1), 0, Math.min(k[side][0], doc.lineCount - 1), 0);
    return [new vscode.CodeLens(at, { title: '→ Accept suggestion (Alt+→)', command: 'duoDiffEdit.copyRight', tooltip: 'Take the proposal\'s block into your file' }),
      new vscode.CodeLens(at, { title: '← Prefer mine (Alt+←)', command: 'duoDiffEdit.copyLeft', tooltip: 'Put your block into the proposal: the agent prepares a new suggestion or says why its own is better' })];
  });
}
// a selection of whole lines (Shift+↓) ends at the start of the next line, which it does not hold
const lastLine = (s) => (s.end.line > s.start.line && s.end.character === 0 ? s.end.line - 1 : s.end.line);

// Copy Block / Copy Words Left and Right: the blocks or changes the cursor or selection touches (the rule of
// Revert Block, blocks.touched; for words blocks.touchedWords), from the other side.
async function copy(targetSide, byWord, at) {
  const c = await atCursor('copy', byWord, at);
  if (!c) return;
  const { ed, side, a, b, A, B, list } = c;
  const hits = list.filter((k) => ed.selections.some((s) => (byWord
    ? touchedWords([k], side, [s.start.line, s.start.character], [s.end.line, s.end.character]).length > 0
    : touched(list, side, s.start.line, lastLine(s)).includes(k))));
  if (!hits.length) return void vscode.window.setStatusBarMessage(`Duo Diff Edit: no ${byWord ? 'changed word' : 'changed block'} at the cursor`, 3000);
  const [target, T, S] = targetSide === 'a' ? [a, A, B] : [b, B, A];
  const edit = new vscode.WorkspaceEdit();
  for (const k of hits) {
    const r = (byWord ? wordReplacement : replacement)(T, S, k, targetSide, eolOf(target));
    edit.replace(target.uri, new vscode.Range(pos(r.from), pos(r.to)), r.text);
  }
  if (!(await vscode.workspace.applyEdit(edit))) return void vscode.window.showWarningMessage('Duo Diff Edit: that side cannot be edited.');
  const lines = hits.map((k) => (byWord ? [k.b[0][0], k.b[1][0]] : [k.b[0], Math.max(k.b[0], k.b[1] - 1)]));   // of the user's file
  emit(`${targetSide === 'b' ? 'ACCEPT' : 'PREFER'} ${Math.min(...lines.map((l) => l[0])) + 1}-${Math.max(...lines.map((l) => l[1])) + 1}`, b.uri.fsPath);
  copies.push({ source: ed.document.uri.toString(), sourceText: ed.document.getText(), target: target.uri.toString(), after: target.getText() });
  if (copies.length > 50) copies.shift();
  undone.length = 0;
  log.info(`copied ${hits.length} ${byWord ? 'change(s)' : 'block(s)'} to the ${targetSide === 'a' ? 'left' : 'right'}: ${target.uri.fsPath}`);
  if (byWord) await go(1, true);   // on to the next changed word, as the keys go word by word
}

// Undo and Redo as in a single editor, copies included. On the side a copy went to, the copy is an edit like any
// other (one step of that side's Undo). On the side it came from, Undo (Ctrl+Z) undoes it once this side is back
// where it was at the copy (its own later edits undone first) and the other side is as the copy left it; Redo
// (Ctrl+Shift+Z, Ctrl+Y) brings it back the same way. Otherwise both are the editor's own.
const copies = [];   // copies made, latest last: { source, sourceText, target, after: the target's text after it }
const undone = [];   // copies undone from their source side, latest last: { source, sourceText, target, before }
const textOf = (uri) => { const d = vscode.workspace.textDocuments.find((x) => x.uri.toString() === uri); return d && d.getText(); };
async function onOtherSide(input, targetUri, cmd) {
  const toLeft = targetUri === input.original.toString();
  const focus = (left) => vscode.commands.executeCommand(`workbench.action.compareEditor.focus${left ? 'Secondary' : 'Primary'}Side`);
  await focus(toLeft);
  await vscode.commands.executeCommand(cmd);
  await focus(!toLeft);
  log.info(`${cmd} of a copy to the ${toLeft ? 'left' : 'right'}`);
}
async function undo() {
  const ed = vscode.window.activeTextEditor, input = diffOf(ed), top = copies[copies.length - 1];
  if (!input || !top || top.source !== ed.document.uri.toString() || top.sourceText !== ed.document.getText()
    || textOf(top.target) !== top.after) return vscode.commands.executeCommand('undo');
  copies.pop();
  await onOtherSide(input, top.target, 'undo');
  undone.push({ source: top.source, sourceText: top.sourceText, target: top.target, before: textOf(top.target) });
}
async function redo() {
  const ed = vscode.window.activeTextEditor, input = diffOf(ed), top = undone[undone.length - 1];
  if (!input || !top || top.source !== ed.document.uri.toString() || top.sourceText !== ed.document.getText()
    || textOf(top.target) !== top.before) return vscode.commands.executeCommand('redo');
  undone.pop();
  await onOtherSide(input, top.target, 'redo');
  copies.push({ source: top.source, sourceText: top.sourceText, target: top.target, after: textOf(top.target) });
}

// Next / Previous Block and Change (as Meld's Alt+↓ / Alt+↑): on the side the cursor is on, so the copy keys that
// follow act there. A block's start is its first line; a change word by word is selected, so the copy picks it.
// Past the last one it goes round to the first, as the diff's own Next Change does.
async function go(dir, byWord) {
  const c = await atCursor('go', byWord);
  clearMirror();
  if (!c || !c.list.length) return c && vscode.window.setStatusBarMessage('Duo Diff Edit: no difference', 3000);
  const { ed, side, list } = c;
  const ranges = list.map((k) => (byWord ? k[side] : [[k[side][0], 0], [k[side][0], 0]]))
    .map(([p, q]) => new vscode.Range(ed.document.validatePosition(pos(p)), ed.document.validatePosition(pos(q))));
  const at = ed.selection.active;
  const i = dir > 0 ? ranges.findIndex((x) => (byWord ? x.start.isAfter(at) : x.start.line > at.line))
    : ranges.map((x) => (byWord ? x.start.isBefore(ed.selection.start) : x.start.line < at.line)).lastIndexOf(true);
  const n = i >= 0 ? i : dir > 0 ? 0 : ranges.length - 1;
  const r = ranges[n];
  ed.selection = new vscode.Selection(r.start, r.end);
  ed.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  if (byWord) mirror(c, list[n], r);
}

// The change the cursor went to, also on the other side of the diff (the same pairing as Copy Changed Words: the
// word diff's range on that side): a decoration, not a selection, so the focus, the selection there and Copy stay
// as they are; the other editor scrolls to it. It goes at the next move, at an edit of either side, or when the
// selection leaves the change. A change that is only an insertion there shows as a bar at the place it would go.
const MIRROR = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  border: '1px solid', borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
});
const MIRROR_POINT = vscode.window.createTextEditorDecorationType({
  before: { contentText: '', width: '3px', height: '1.2em', backgroundColor: new vscode.ThemeColor('editorCursor.foreground'), margin: '0 -1px 0 0' },
});
let shown;   // { source, target, range, mine } while a change is shown on both sides
const frame = (e, r) => { e.setDecorations(MIRROR, r && !r.isEmpty ? [r] : []); e.setDecorations(MIRROR_POINT, r && r.isEmpty ? [r] : []); };
function clearMirror() {
  if (!shown) return;
  frame(shown.target);
  frame(shown.source);
  shown = undefined;
}
// Both sides of the change are framed alike: a copy either way replaces one of them with the other (→ the right
// side's, ← the left side's), so what a copy overwrites is in view before it.
function mirror({ ed, side, a, b }, w, mine) {
  const other = side === 'a' ? b : a;
  const target = vscode.window.visibleTextEditors.find((t) => t.document.uri.toString() === other.uri.toString());
  if (!target) return;
  const [p, q] = w[side === 'a' ? 'b' : 'a'].map((x) => other.validatePosition(pos(x)));
  const range = new vscode.Range(p, q);
  if (shown && shown.source !== ed) frame(shown.source);
  frame(target, range);
  frame(ed, mine);
  target.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  shown = { source: ed, target, range, mine };
  log.info(`go: shows ${other.uri.path} ${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`);
}
const mirrored = () => shown && { uri: shown.target.document.uri.toString(), range: [shown.range.start.line, shown.range.start.character, shown.range.end.line, shown.range.end.character],
  mine: [shown.mine.start.line, shown.mine.start.character, shown.mine.end.line, shown.mine.end.character] };
// The cursor on a changed word, put there by a click, a right-click or a key: that change is framed on both sides
let wordTimer;
function frameAtCursor(ed) {
  clearTimeout(wordTimer);
  wordTimer = setTimeout(async () => {
    if (ed !== vscode.window.activeTextEditor || !diffOf(ed)) return;
    const c = await atCursor('frame', true, ed);
    if (!c) return;
    const s = ed.selection, n = c.list.findIndex((w) => touchedWords([w], c.side, [s.start.line, s.start.character], [s.end.line, s.end.character]).length > 0);
    if (n < 0) return;
    const [p, q] = c.list[n][c.side].map((x) => ed.document.validatePosition(pos(x)));
    const mine = new vscode.Range(p, q);
    if (!(shown && shown.source === ed && shown.mine.isEqual(mine))) mirror(c, c.list[n], mine);
  }, 150);
}

async function newWindow() {   // empty auxiliary window; its group is the last one (main window first, then auxiliary)
  const n = vscode.window.tabGroups.all.length;
  await vscode.commands.executeCommand('workbench.action.newEmptyEditorWindow');
  for (let i = 0; i < 20 && vscode.window.tabGroups.all.length <= n; i++) await wait(100);
  const all = vscode.window.tabGroups.all;
  return all.length > n ? all.reduce((a, b) => (b.viewColumn > a.viewColumn ? b : a)) : undefined;
}

async function showInAux(diffs) {   // diffs: [[left, right, title], …]; every diff gets focus (window and tab)
  let g = group();
  if (!g) { await kwin(storage); g = auxGroup = await newWindow(); }   // KWin watches before the window appears; never in the main window
  for (const [left, right, title] of diffs) {
    await vscode.commands.executeCommand('vscode.diff', left, right, title,
      { preview: false, preserveFocus: false, ...(g && { viewColumn: g.viewColumn }) });
  }
  await wait(300);   // the window title follows the active tab
  await kwin(storage, diffs[diffs.length - 1][2]);
}

// git as the git extension found it (not a git.exe in the current directory on Windows), in a repository that
// extension has open, so its own rules (Workspace Trust, git.openRepositoryInParentFolders) already let git run there.
const git = (bin, cwd, args, input) => new Promise((r) => {
  const c = execFile(bin, ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], (err, out) => r({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(out).trim() }));
  if (input !== undefined) c.stdin.end(input);
});
async function addToIndex(bin, root, f) {   // an untracked file enters the index empty: all its content shows as new
  const rel = path.relative(root, f).split(path.sep).join('/');
  if ((await git(bin, root, ['ls-files', '--error-unmatch', '--', rel])).code !== 1) return false;   // 1: untracked
  if ((await git(bin, root, ['check-ignore', '-q', '--', rel])).code !== 1) return false;   // 1: not ignored
  const empty = await git(bin, root, ['hash-object', '-w', '--stdin'], '');
  if (empty.code) return false;
  return (await git(bin, root, ['update-index', '--add', '--cacheinfo', `100644,${empty.out},${rel}`])).code === 0;
}

// Agreed, not staged: lines of the right side that both sides hold alike but the git index does not yet, light
// blue, each run with a Stage button that puts just those lines into the index (the file on disk stays as it is).
// Only for a file in a repository the git extension has open; nothing outside git.
const AGREED = vscode.window.createTextEditorDecorationType({
  isWholeLine: true, backgroundColor: 'rgba(80, 160, 255, 0.16)', overviewRulerColor: 'rgba(80, 160, 255, 0.6)',
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});
const indexOf = (bin, root, rel) => new Promise((r) => execFile(bin, ['-c', 'core.fsmonitor=false', '-C', root, 'show', `:${rel}`],
  { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, out) => r(err ? '' : out)));   // not in the index: empty
const agreedOf = new Map();   // the user's file → { runs: [[first, last]], root, rel, bin, index, hunks }
async function agreed(input) {   // the runs of agreed, unstaged lines of one diff of two files, and what staging needs
  const file = input.modified.fsPath, api = await gitApi();
  const repo = api.getRepository(input.modified);
  if (!repo) return undefined;
  const root = repo.rootUri.fsPath, rel = path.relative(root, box.real(file)).split(path.sep).join('/'), bin = api.git.path;
  const [a, b] = await Promise.all([vscode.workspace.openTextDocument(input.original), vscode.workspace.openTextDocument(input.modified)]);
  const A = a.getText().split(eolOf(a)), B = b.getText().split(eolOf(b));
  const index = await indexOf(bin, root, rel), I = index.split(/\r?\n/);
  const pairs = blocks(A, B, vscode.workspace.getConfiguration('diffEditor').get('ignoreTrimWhitespace', true));
  const hunks = blocks(I, B, false);
  if (!pairs || !hunks) return undefined;
  // a hunk (index → right) is agreed when no line of it on the right is in a block of the pair; a removal (lines
  // the right no longer has) when its place is in none
  const inPair = (line) => pairs.some((k) => (k.b[0] < k.b[1] ? k.b[0] <= line && line < k.b[1] : k.b[0] === line));
  const lines = (k) => Array.from({ length: k.b[1] - k.b[0] }, (_, i) => k.b[0] + i);
  const ok = hunks.filter((k) => (k.b[0] < k.b[1] ? !lines(k).some(inPair) : !inPair(k.b[0])));
  // runs are what shows (lines the right has); removals are staged with Stage All Agreed
  const runs = ok.filter((k) => k.b[0] < k.b[1]).map((k) => [k.b[0], k.b[1] - 1, k]);
  return { runs, ok, hunks, root, rel, bin, index, I, B, eol: index.includes('\r\n') ? '\r\n' : '\n' };
}
const diffOfFile = (file) => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
  .find((x) => twoFiles(x.input) && x.input.modified.scheme === 'file' && x.input.modified.fsPath === file);
async function stageAgreed(file, lines) {   // the agreed hunks on these lines of the right side (all, without lines)
  const t = diffOfFile(file);
  const s = t && await agreed(t.input);
  if (!s) return void vscode.window.showInformationMessage('Duo Diff Edit: nothing to stage here (the file is not in a repository Source Control has open).');
  const pick = lines ? s.runs.filter(([f, l]) => f <= lines[1] && lines[0] <= l).map(([, , k]) => k) : s.ok;
  if (!pick.length) return void vscode.window.setStatusBarMessage('Duo Diff Edit: no agreed, unstaged lines here', 3000);
  return intoIndex(file, s, pick);
}
// Stage Mine: your text, agreed or not, into the git index: the changes (index → your file) the cursor or selection
// touches, or with whole every change, the whole file. Only the right side is read: the proposal is never staged.
async function stageMine(file, whole) {
  const t = diffOfFile(file);
  const s = t && await agreed(t.input);
  if (!s) return void vscode.window.showInformationMessage('Duo Diff Edit: nothing to stage here (the file is not in a repository Source Control has open).');
  let pick = s.hunks;
  if (!whole) {
    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === t.input.modified.toString());
    pick = ed ? s.hunks.filter((k) => ed.selections.some((x) => touched(s.hunks, 'b', x.start.line, lastLine(x)).includes(k))) : [];
  }
  if (!pick.length) return void vscode.window.setStatusBarMessage(`Duo Diff Edit: nothing unstaged ${whole ? 'in the file' : 'at the cursor in your file (the right side)'}`, 3000);
  return intoIndex(file, s, pick);
}
async function intoIndex(file, s, pick) {   // these hunks (index → your file) applied to the index text
  const next = apply(s.index, pick.map((k) => replacement(s.I, s.B, k, 'a', s.eol)), s.eol);
  const mode = ((await git(s.bin, s.root, ['ls-files', '-s', '--', s.rel])).out.split(' ')[0]) || '100644';
  const blob = await git(s.bin, s.root, ['hash-object', '-w', '--stdin'], next);
  if (blob.code || (await git(s.bin, s.root, ['update-index', '--add', '--cacheinfo', `${mode},${blob.out},${s.rel}`])).code) {
    return void vscode.window.showWarningMessage('Duo Diff Edit: git did not stage the lines.');
  }
  log.info(`staged ${pick.length} hunk(s) of ${file}`);
  emit(`STAGE ${Math.min(...pick.map((k) => k.b[0])) + 1}-${Math.max(...pick.map((k) => Math.max(k.b[0], k.b[1] - 1))) + 1}`, file);
  refreshAgreed();
}
let agreedTimer;
function refreshAgreed() {   // the decorations and Stage lenses of every visible diff of two files, a moment after a change
  clearTimeout(agreedTimer);
  agreedTimer = setTimeout(async () => {
    for (const ed of vscode.window.visibleTextEditors) {
      const input = diffOf(ed);
      if (!input || ed.document.uri.toString() !== input.modified.toString() || input.modified.scheme !== 'file') continue;
      let s;
      try { s = await agreed(input); } catch (e) { log.warn(`agreed: ${e}`); }
      agreedOf.set(input.modified.fsPath, s);
      ed.setDecorations(AGREED, s ? s.runs.map(([f, l]) => new vscode.Range(f, 0, l, 0)) : []);
    }
    const act = diffOf(vscode.window.activeTextEditor) || (vscode.window.tabGroups.activeTabGroup.activeTab || {}).input;
    const f = act && act.modified && act.modified.scheme === 'file' && act.modified.fsPath;
    vscode.commands.executeCommand('setContext', 'duoDiffEdit.inGit', !!(f && agreedOf.get(f)));   // Stage buttons only for a file in git
    lensChanged.fire();
  }, 300);
}
async function handle([kind, file]) {   // a parsed request: a file in this window's workspace, or an orphan "saved"
  const uri = vscode.Uri.file(file);
  log.info(`open ${kind} ${file}`);
  if (kind === 'pair') return openPair(file);
  if (kind === 'saved') {
    await vscode.window.showTextDocument(uri, { preview: false });
    return vscode.commands.executeCommand('workbench.files.action.compareWithSaved', uri);
  }
  const api = await gitApi();
  // the file's folder: for a repository git has not opened yet, it runs git rev-parse with this as the working
  // directory, and a file there fails with ENOTDIR. A Uri comes back (Visual Studio Code 1.144), a string in older ones.
  const found = await api.getRepositoryRoot(vscode.Uri.file(path.dirname(file)));
  const root = found && (typeof found === 'string' ? found : found.fsPath);
  let repo = root && api.getRepository(vscode.Uri.file(root));
  for (let i = 0; !repo && root && box.inside(path.join(root, '.git'), roots) && i < 20; i++) {   // a window just opened: git is still scanning
    await wait(250);
    repo = api.getRepository(vscode.Uri.file(root));
  }
  // no await on notifications: their promise resolves only when they are closed, which would stall the loop
  if (!repo) {
    const why = root ? `its repository ${root} is not open in Source Control` : 'it is not in a git repository';
    log.warn(`${file}: ${why}`);
    return void vscode.window.showWarningMessage(`Duo Diff Edit: cannot open ${path.basename(file)}: ${why}.`);
  }
  const top = repo.rootUri.fsPath, f = box.real(file);   // git reports the real path; a link would not match it
  if (await addToIndex(api.git.path, top, f)) {
    log.info(`${file}: untracked, added to the index as empty`);
    vscode.window.showInformationMessage(`Duo Diff Edit: ${path.basename(file)} is now in the git index as a new, empty file. Undo: git rm --cached -- "${path.relative(top, f)}"`);
  }
  await repo.status();   // ref ~ reads the index only for files in "Staged Changes", otherwise HEAD
  return showInAux([[api.toGitUri(uri, '~'), uri, `${path.basename(file)}${SUFFIX}`]]);
}

exports.activate = (ctx) => {
  ctx.subscriptions.push(MIRROR, MIRROR_POINT, vscode.window.onDidChangeTextEditorSelection((e) => {   // the selection left the change
    if (shown && e.textEditor === shown.source && !shown.mine.contains(e.selections[0])) clearMirror();
    if (e.kind !== undefined && diffOf(e.textEditor)) frameAtCursor(e.textEditor);   // a click or a key, not an extension
  }), vscode.workspace.onDidChangeTextDocument((e) => {
    if (shown && e.contentChanges.length && (e.document === shown.source.document || e.document === shown.target.document)) clearMirror();
  }));
  storage = ctx.globalStorageUri.fsPath;
  log = vscode.window.createOutputChannel('Duo Diff Edit', { log: true });
  ctx.subscriptions.push(log);
  closeRestored();
  // no await: the notification's promise resolves only when it is closed
  const fail = (e) => { log.error(String(e)); vscode.window.showErrorMessage(`Duo Diff Edit: ${e}`); };
  const setRoots = () => { roots = box.rootsOf((vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)); };
  setRoots();
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(setRoots));
  ctx.subscriptions.push(vscode.commands.registerCommand('duoDiffEdit.open', (uri) => {   // Explorer: a file of this workspace
    if (uri instanceof vscode.Uri && uri.scheme === 'file' && box.inside(uri.fsPath, roots)) return handle(['git', uri.fsPath]).catch(fail);
  }));
  ctx.subscriptions.push(vscode.commands.registerCommand('duoDiffEdit.openPair', (uri) => {   // Explorer: the proposal ↔ the file
    if (uri instanceof vscode.Uri && uri.scheme === 'file') return handle(['pair', uri.fsPath]).catch(fail);
  }));
  for (const [id, fn] of [['copyLeft', (g) => copy('a', false, gutterBlock(g))], ['copyRight', (g) => copy('b', false, gutterBlock(g))],
    ['copyWordsLeft', () => copy('a', true)], ['copyWordsRight', () => copy('b', true)],
    ['nextBlock', () => go(1, false)], ['previousBlock', () => go(-1, false)],
    ['nextWords', () => go(1, true)], ['previousWords', () => go(-1, true)], ['undo', undo], ['redo', redo]]) {
    ctx.subscriptions.push(vscode.commands.registerCommand(`duoDiffEdit.${id}`, (g) => fn(g).catch(fail)));
  }
  const setKey = () => {   // shows the copy buttons and keys only in a diff of two editable files
    const t = vscode.window.tabGroups.activeTabGroup.activeTab;
    vscode.commands.executeCommand('setContext', 'duoDiffEdit.twoFiles', (!!t && twoFiles(t.input)) || !!diffOf(vscode.window.activeTextEditor));
    watchRights();
    refreshAgreed();
  };
  setKey();
  ctx.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(setKey), vscode.window.tabGroups.onDidChangeTabGroups(setKey),
    vscode.window.onDidChangeActiveTextEditor(setKey));

  const dir = box.proposals();
  try { proposalsRefused = box.prepare(dir); } catch (e) { proposalsRefused = String(e); }
  if (!proposalsRefused) {
    proposals = new Proposals(dir);
    ctx.subscriptions.push(proposals, vscode.workspace.registerFileSystemProvider(SCHEME, proposals, { isCaseSensitive: process.platform === 'linux' }));
  }
  // A save with Ctrl+S on either side of a diff of two files is one line in the events file (mailbox.events): the
  // agent's review starts from it, as files.autoSave saves on its own too and the disk alone cannot tell them apart.
  const eventsDir = box.events();
  let eventsRefused;
  try { eventsRefused = box.prepare(eventsDir); } catch (e) { eventsRefused = String(e); }
  if (!eventsRefused) {
    eventsFile = path.join(eventsDir, 'saves');
    ctx.subscriptions.push(vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.reason !== vscode.TextDocumentSaveReason.Manual) return;
      const key = e.document.uri.toString();
      const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
        .find((x) => twoFiles(x.input) && (x.input.original.toString() === key || x.input.modified.toString() === key));
      if (t) emit(`SAVE manual ${t.input.original.toString() === key ? 'left' : 'right'}`, t.input.modified.fsPath);
    }));
  }
  // Accept Suggestion and Prefer Mine over the block at the cursor (a CodeLens: the diff's own gutter menu takes no
  // extension's buttons without a proposed API); diffEditor.codeLens is on by default (package.json)
  let lensTimer;
  const relens = () => { clearTimeout(lensTimer); lensTimer = setTimeout(() => lensChanged.fire(), 150); };
  ctx.subscriptions.push(lensChanged, vscode.window.onDidChangeTextEditorSelection(relens), vscode.window.onDidChangeActiveTextEditor(relens),
    vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: SCHEME }], { onDidChangeCodeLenses: lensChanged.event, provideCodeLenses: lenses }));
  // agreed, unstaged lines follow both sides, the visible editors and the index (the git extension's state)
  ctx.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => { if ([...agreedOf.keys()].includes(e.document.uri.fsPath) || e.document.uri.scheme === SCHEME) refreshAgreed(); }),
    vscode.window.onDidChangeVisibleTextEditors(refreshAgreed), AGREED,
    vscode.commands.registerCommand('duoDiffEdit.stageMine', () => {
      const f = (diffOf(vscode.window.activeTextEditor) || {}).modified?.fsPath;
      return f ? stageMine(f, false).catch(fail) : undefined;
    }),
    vscode.commands.registerCommand('duoDiffEdit.stageFile', () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      const f = ((t && twoFiles(t.input) && t.input) || diffOf(vscode.window.activeTextEditor) || {}).modified?.fsPath;
      return f ? stageMine(f, true).catch(fail) : undefined;
    }),
    vscode.commands.registerCommand('duoDiffEdit.stageAgreed', (file, lines) => {   // from a menu: (uri, context), all agreed lines
      const f = typeof file === 'string' ? file : (diffOf(vscode.window.activeTextEditor) || {}).modified?.fsPath;
      return f ? stageAgreed(f, Array.isArray(lines) ? lines : undefined).catch(fail) : undefined;
    }));
  gitApi().then((api) => {
    const watch = (r) => ctx.subscriptions.push(r.state.onDidChange(refreshAgreed));
    api.repositories.forEach(watch);
    ctx.subscriptions.push(api.onDidOpenRepository(watch));
  }, () => {});
  const mailbox = box.location();
  let refused;
  try { refused = box.prepare(mailbox); } catch (e) { refused = String(e); }
  log.info(`version ${ctx.extension.packageJSON.version}, trusted ${vscode.workspace.isTrusted}, mailbox ${mailbox}${refused ? ` refused: ${refused}` : ''}, proposals ${dir}${proposalsRefused ? ` refused: ${proposalsRefused}` : ''}, events ${eventsDir}${eventsRefused ? ` refused: ${eventsRefused}` : ''}`);
  if (refused) return void fail(`the request mailbox is not safe to use: ${refused}`);
  const ours = (name) => path.join(mailbox, `.${process.pid}-${name}`);
  const tidy = (names) => {   // a claimed file a crashed window left behind
    for (const n of names.filter((x) => x.startsWith('.'))) {
      const f = path.join(mailbox, n);
      try { if (Date.now() - fs.lstatSync(f).mtimeMs > box.STALE_AFTER) fs.rmSync(f, { force: true }); } catch { /* gone */ }
    }
  };
  let busy = false, again = false;
  const read = async () => {
    if (busy) { again = true; return; }   // a request that arrives meanwhile is read right after
    busy = true;
    let young = false;
    try {
      const names = fs.readdirSync(mailbox).sort();
      tidy(names);
      for (const name of names.filter((n) => !n.startsWith('.'))) {
        const f = path.join(mailbox, name), req = box.readRequest(f);
        if (!req) continue;
        const d = box.decide({ name, ...req, roots, focused: vscode.window.state.focused });
        if (d.action === 'wait') young = true;
        if (!['own', 'forward', 'refuse', 'drop'].includes(d.action)) continue;
        const taken = ours(name);
        try { fs.renameSync(f, taken); } catch { continue; }   // another window took it
        if (d.action === 'forward') {   // the project's own window takes it once it has started
          const to = path.join(mailbox, `${box.FORWARDED}${name}`), now = new Date();
          try { fs.utimesSync(taken, now, now); fs.renameSync(taken, to); } catch (e) { log.warn(`${name}: ${e}`); continue; }   // its age counts from now
          log.info(`${name}: no window has its project open; opening ${d.folder}`);
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(d.folder), { forceNewWindow: true });
          continue;
        }
        fs.rmSync(taken, { force: true });
        if (d.action === 'drop') { log.info(`${name}: stale or without a request, dropped`); continue; }
        if (d.action === 'refuse') {
          log.warn(`${name}: ${d.reason}`);
          vscode.window.showWarningMessage(`Duo Diff Edit: ${d.reason}.`);
          continue;
        }
        if (d.rest.length) {   // lines for other projects go back into the mailbox
          const base = name.startsWith(box.FORWARDED) ? name.slice(box.FORWARDED.length) : name;
          try {
            fs.writeFileSync(path.join(mailbox, `${base}-${process.pid}-${Date.now()}`), `${d.rest.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
          } catch (e) { log.warn(`${name}: could not return ${d.rest.length} line(s) for other projects: ${e}`); }
        }
        for (const r of d.reqs) {   // 20 s limit: a hanging request does not stop the loop
          await Promise.race([handle(r).catch(fail), wait(20000)]);
        }
      }
    } catch (e) { fail(e); } finally { busy = false; }
    if (again) { again = false; return read(); }
    if (young) setTimeout(read, box.ORPHAN_AFTER);
  };
  fs.watchFile(mailbox, { interval: 500 }, read);
  ctx.subscriptions.push({ dispose: () => fs.unwatchFile(mailbox) }, { dispose: () => { for (const stop of rights.values()) stop(); rights.clear(); } });
  read();
  return { mirrored };   // for test/e2e-ui: what is shown on the other side of the diff
};
