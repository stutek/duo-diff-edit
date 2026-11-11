// Duo Diff Edit: the agent's proposal (left) against the user's file (right) in an auxiliary window, as in Meld.
// Both sides are editable. The left side is served by a file system provider of its own (Proposals), which polls
// the proposal on disk, so the side reloads the moment the agent writes it, without an inotify watch. A block moves
// across with the built-in gutter arrow (→, Revert Block) or with Copy Block Left / Copy Block Right (editor title,
// context menu, Alt+← / Alt+→ as in Meld; blocks.js finds the block at the cursor).
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
const { blocks, touched, replacement } = require('./blocks');

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
let auxGroup;             // tab group in the auxiliary window
let roots = [];           // this window's workspace folders (mailbox.rootsOf)
const group = () => {
  const all = vscode.window.tabGroups.all;
  if (auxGroup && all.includes(auxGroup)) return auxGroup;
  return (auxGroup = all.find((g) => g.tabs.some((t) => t.label.endsWith(SUFFIX) || t.label.endsWith(PAIR))));   // also after a reload
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
async function copyBlock(targetSide) {
  const ed = vscode.window.activeTextEditor, input = diffOf(ed);
  const key = ed && ed.document.uri.toString();
  const side = !input ? '' : key === input.original.toString() ? 'a' : 'b';
  if (!side) {
    log.info(`copy: no diff of two files at the cursor (editor ${key || 'none'})`);
    return void vscode.window.showInformationMessage('Duo Diff Edit: put the cursor into a diff of two files.');
  }
  const [a, b] = await Promise.all([vscode.workspace.openTextDocument(input.original), vscode.workspace.openTextDocument(input.modified)]);
  const A = a.getText().split(eolOf(a)), B = b.getText().split(eolOf(b));
  const list = blocks(A, B, vscode.workspace.getConfiguration('diffEditor').get('ignoreTrimWhitespace', true));
  if (!list) return void vscode.window.showWarningMessage('Duo Diff Edit: the files differ in too many lines to find the block.');
  const hits = list.filter((k) => ed.selections.some((s) => touched([k], side, s.start.line, s.end.line).length));
  if (!hits.length) return void vscode.window.setStatusBarMessage('Duo Diff Edit: no changed block at the cursor', 3000);
  const [target, T, S] = targetSide === 'a' ? [a, A, B] : [b, B, A];
  const edit = new vscode.WorkspaceEdit();
  for (const k of hits) {
    const r = replacement(T, S, k, targetSide, eolOf(target));
    edit.replace(target.uri, new vscode.Range(r.from[0], r.from[1], r.to[0], r.to[1]), r.text);
  }
  if (!(await vscode.workspace.applyEdit(edit))) return void vscode.window.showWarningMessage('Duo Diff Edit: that side cannot be edited.');
  log.info(`copied ${hits.length} block(s) to the ${targetSide === 'a' ? 'left' : 'right'}: ${target.uri.fsPath}`);
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
  storage = ctx.globalStorageUri.fsPath;
  log = vscode.window.createOutputChannel('Duo Diff Edit', { log: true });
  ctx.subscriptions.push(log);
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
  ctx.subscriptions.push(vscode.commands.registerCommand('duoDiffEdit.copyLeft', () => copyBlock('a').catch(fail)));
  ctx.subscriptions.push(vscode.commands.registerCommand('duoDiffEdit.copyRight', () => copyBlock('b').catch(fail)));
  const setKey = () => {   // shows the copy buttons and keys only in a diff of two editable files
    const t = vscode.window.tabGroups.activeTabGroup.activeTab;
    vscode.commands.executeCommand('setContext', 'duoDiffEdit.twoFiles', (!!t && twoFiles(t.input)) || !!diffOf(vscode.window.activeTextEditor));
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
  const mailbox = box.location();
  let refused;
  try { refused = box.prepare(mailbox); } catch (e) { refused = String(e); }
  log.info(`version ${ctx.extension.packageJSON.version}, trusted ${vscode.workspace.isTrusted}, mailbox ${mailbox}${refused ? ` refused: ${refused}` : ''}, proposals ${dir}${proposalsRefused ? ` refused: ${proposalsRefused}` : ''}`);
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
  ctx.subscriptions.push({ dispose: () => fs.unwatchFile(mailbox) });
  read();
};
