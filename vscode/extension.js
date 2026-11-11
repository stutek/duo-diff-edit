// Duo Diff Edit: a diff of the git index (left) against the editor buffer (right) in an auxiliary window.
// The left side (git: URI, ref ~) follows the index: stage and commit refresh it (git fileSystemProvider);
// the right side is the editor's text model, so the user's unsaved text is never touched. The agent proposes
// edits by writing them into the index; the user accepts a block with the gutter's "Revert Block" (→) and
// stages their own text with "Stage Block" (+).
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

const run = (cmd, args) => new Promise((r) => execFile(cmd, args, (err, out) => r(err ? '' : out.trim())));
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

const SUFFIX = ' (stage ↔ buffer)';   // diff title; group() finds the auxiliary window by it
let storage;              // extension global storage: the KWin script
let auxGroup;             // tab group in the auxiliary window
let roots = [];           // this window's workspace folders (mailbox.rootsOf)
const group = () => {
  const all = vscode.window.tabGroups.all;
  if (auxGroup && all.includes(auxGroup)) return auxGroup;
  return (auxGroup = all.find((g) => g.tabs.some((t) => t.label.endsWith(SUFFIX))));   // also after a window reload
};

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
  if (kind === 'saved') {
    await vscode.window.showTextDocument(uri, { preview: false });
    return vscode.commands.executeCommand('workbench.files.action.compareWithSaved', uri);
  }
  const api = await gitApi();
  const root = await api.getRepositoryRoot(uri);
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
  const mailbox = box.location();
  let refused;
  try { refused = box.prepare(mailbox); } catch (e) { refused = String(e); }
  log.info(`version ${ctx.extension.packageJSON.version}, mailbox ${mailbox}${refused ? ` refused: ${refused}` : ''}`);
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
