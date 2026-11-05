// Duo Diff Edit: a diff of the git index (left) against the editor buffer (right) in an auxiliary window.
// The left side (git: URI, ref ~) follows the index: stage and commit refresh it (git fileSystemProvider);
// the right side is the editor's text model, so the user's unsaved text is never touched. The agent proposes
// edits by writing them into the index; the user accepts a block with the gutter's "Revert Block" (→) and
// stages their own text with "Stage Block" (+).
//
// Requests: a file with lines "git <absolute path>" (index ↔ buffer) or "saved <absolute path>" (disk ↔ buffer)
// in the mailbox <XDG_RUNTIME_DIR or OS temp dir>/duo-diff-edit/. A window takes the requests for paths inside its
// workspace; a request no open workspace claims is taken after 1.5 s by the focused window, which opens the
// repository itself. Claiming is a rename, so exactly one window handles each request. fs.watchFile polls the
// directory's mtime (no inotify needed). A vscode:// URI with a window id is not reliable for routing: VS Code
// matches `window:${id}` without a boundary (urlIpc.ts), so "1" also matches window 10.
//
// Window placement on the physically largest monitor and raising an existing window are done with a KWin script
// (KDE Plasma 6); elsewhere the auxiliary window opens where VS Code places it.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const run = (cmd, args) => new Promise((r) => execFile(cmd, args, (err, out) => r(err ? '' : out.trim())));
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
  const diag = (o) => o.sizeMM.width ** 2 + o.sizeMM.height ** 2;
  const outputs = JSON.parse(j).outputs.filter((o) => o.enabled).sort((a, b) => diag(b) - diag(a)).map((o) => o.name);
  const f = path.join(dir, 'kwin.js'), name = `duo-diff-edit-${process.pid}-${Date.now()}`;
  fs.mkdirSync(dir, { recursive: true });
  const ws = ` - ${vscode.workspace.name} - `;   // window title: "<tab> - <workspace> - Visual Studio Code"
  fs.writeFileSync(f, `const OUTPUTS = ${JSON.stringify(outputs)}; const TITLE = ${JSON.stringify(title)}; const WORKSPACE = ${JSON.stringify(ws)};${KWIN}`);
  const id = await run('qdbus6', ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.loadScript', f, name]);
  if (!id) return;
  await run('qdbus6', ['org.kde.KWin', `/Scripting/Script${id}`, 'org.kde.kwin.Script.run']);
  setTimeout(() => run('qdbus6', ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.unloadScript', name]), 4000);
}

const gitApi = async () => {
  const git = vscode.extensions.getExtension('vscode.git');
  return (git.isActive ? git.exports : await git.activate()).getAPI(1);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SUFFIX = ' (stage ↔ buffer)';   // diff title; group() finds the auxiliary window by it
let storage;              // extension global storage: the KWin script
let auxGroup;             // tab group in the auxiliary window
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

const git = (cwd, args, input) => new Promise((r) => {
  const c = execFile('git', ['-C', cwd, ...args], (err, out) => r(err ? null : out.trim()));
  if (input !== undefined) c.stdin.end(input);
});
async function addToIndex(f) {   // an untracked file enters the index empty: the left side is readable, all content is new
  const root = await git(path.dirname(f), ['rev-parse', '--show-toplevel']);
  if (!root || (await git(root, ['ls-files', '--error-unmatch', '--', f])) !== null) return;
  if ((await git(root, ['check-ignore', '-q', '--', f])) !== null) return;   // ignored files stay out of the index
  const empty = await git(root, ['hash-object', '-w', '--stdin'], '');
  await git(root, ['update-index', '--add', '--cacheinfo', `100644,${empty},${path.relative(root, f).split(path.sep).join('/')}`]);
}

const WIN = process.platform === 'win32';
const toPath = (p) => {   // Git Bash writes /c/Users/…; on Windows that is C:/Users/…
  const m = WIN && /^\/([a-zA-Z])\/(.*)$/.exec(p);
  return path.resolve(m ? `${m[1]}:/${m[2]}` : p);
};
const parse = (line) => {
  const m = /^(git|saved) (.+)$/.exec(line.trim());
  return m && path.isAbsolute(m[2]) ? [m[1], toPath(m[2])] : null;
};
const fold = (p) => (process.platform === 'linux' ? p : p.toLowerCase());   // Windows and macOS: case-insensitive paths

async function handle(line) {   // "git <absolute path>" or "saved <absolute path>"
  const req = parse(line);
  if (!req) return;
  const [kind, file] = req, uri = vscode.Uri.file(file);
  if (kind === 'saved') {
    await vscode.window.showTextDocument(uri, { preview: false });
    return vscode.commands.executeCommand('workbench.files.action.compareWithSaved', uri);
  }
  await addToIndex(file);
  const api = await gitApi();
  const root = await api.getRepositoryRoot(uri);
  const repo = root && (api.getRepository(root) || await api.openRepository(root));   // also another project's repository
  // no await: the notification's promise resolves only when it is closed, which would stall the loop
  if (!repo) return void vscode.window.showWarningMessage(`Duo Diff Edit: ${file} is not in a git repository`);
  await repo.status();   // ref ~ reads the index only for files in "Staged Changes", otherwise HEAD
  return showInAux([[api.toGitUri(uri, '~'), uri, `${path.basename(file)}${SUFFIX}`]]);
}

exports.activate = (ctx) => {
  storage = ctx.globalStorageUri.fsPath;
  ctx.subscriptions.push(vscode.commands.registerCommand('duoDiffEdit.open', async (uri) => {
    if (uri && uri.scheme === 'file') return handle(`git ${uri.fsPath}`);
  }));
  const roots = (vscode.workspace.workspaceFolders || []).map((f) => fold(f.uri.fsPath + path.sep));
  if (!roots.length) return;
  const mailbox = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'duo-diff-edit');
  // own request: a path inside this workspace; an orphan (no window has the project open) is taken after 1.5 s by
  // the focused window, which is where the user clicked; after 60 s an orphan is stale and nobody takes it
  const mine = (line) => { const r = parse(line); return r && roots.some((d) => fold(r[1]).startsWith(d)); };
  const ORPHAN = [1500, 60000];
  fs.mkdirSync(mailbox, { recursive: true, mode: 0o700 });
  let busy = false;
  const read = async () => {
    if (busy) return;
    busy = true;
    let young = false;
    try {
      for (const name of fs.readdirSync(mailbox).filter((n) => !n.startsWith('.')).sort()) {
        const f = path.join(mailbox, name), taken = path.join(mailbox, `.${process.pid}-${name}`);
        let lines, age;
        try { lines = fs.readFileSync(f, 'utf8').split('\n'); age = Date.now() - fs.statSync(f).mtimeMs; } catch { continue; }
        let own = lines.filter(mine);
        if (!own.length) {   // another window's request or an orphan
          if (age < ORPHAN[0]) { young = true; continue; }
          if (age > ORPHAN[1] || !vscode.window.state.focused) continue;
          own = lines.filter(parse);
          if (!own.length) continue;
        }
        try { fs.renameSync(f, taken); } catch { continue; }   // another window took it
        fs.unlinkSync(taken);
        for (const line of own) {   // 20 s limit: a hanging request does not stop the loop
          await Promise.race([handle(line).catch((e) => void vscode.window.showErrorMessage(`Duo Diff Edit: ${e}`)), wait(20000)]);
        }
      }
    } finally { busy = false; }
    if (young) setTimeout(read, ORPHAN[0]);
  };
  fs.watchFile(mailbox, { interval: 500 }, read);
  ctx.subscriptions.push({ dispose: () => fs.unwatchFile(mailbox) });
  read();
};
