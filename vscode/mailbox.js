// The request mailbox of Duo Diff Edit, without the vscode module, so plain `node --test` covers it.
//
// Location: $XDG_RUNTIME_DIR/duo-diff-edit (Linux: RAM, owned by the user, mode 700), else
// <home>/.cache/duo-diff-edit. Never a shared temp directory: another user could plant requests or symbolic links
// there. On Linux and macOS the extension refuses a mailbox that is a symbolic link or belongs to another user.
//
// A request file holds lines "pair <absolute path>" (the agent's proposal ↔ the file), "git <absolute path>"
// (index ↔ buffer) or "saved <absolute path>" (disk ↔ buffer), each ending in a newline; a file whose last line has
// no newline is still being written. The window whose workspace holds the path takes the request. A request no
// workspace claims (an orphan) is, after ORPHAN_AFTER, taken by the focused window: a "pair" or "saved" request it
// opens itself (no git runs); for a "git" request it renames the file to
// "open-<name>" and opens the repository's folder in a window of its own, where Visual Studio Code's Workspace Trust
// decides, as for any folder, whether git may run. Only the project's window takes an "open-" request. A "git"
// request outside any repository, or in a repository that is the home folder, is refused. Any window deletes a
// request older than STALE_AFTER, so a window reload never replays old clicks.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_REQUEST = 64 * 1024;   // bytes; a request is a few lines
const ORPHAN_AFTER = 1500;       // ms: the project's own window gets the first chance
const STALE_AFTER = 60000;       // ms
const FORWARDED = 'open-';       // name prefix of a request forwarded to a new window of its project
const WIN = process.platform === 'win32';

const base = (env, home) => env.XDG_RUNTIME_DIR || path.join(home, '.cache');
const location = (env = process.env, home = os.homedir()) => path.join(base(env, home), 'duo-diff-edit');

// The agent's proposals for a file live under one private directory, at the file's absolute path (on Windows its
// drive letter, lower case, is the first folder): agent and extension find the proposal of a file without asking
// each other. As a shell line: P="${XDG_RUNTIME_DIR:-$HOME/.cache}/duo-diff-edit-proposals$F" (Git Bash: F=/c/…).
const proposals = (env = process.env, home = os.homedir()) => path.join(base(env, home), 'duo-diff-edit-proposals');
function proposalOf(file, dir, win = WIN) {   // '' for a path that would leave dir (.. segments)
  const p = (win ? path.win32 : path.posix), abs = p.resolve(file);
  const m = win && /^([a-zA-Z]):[\\/]*(.*)$/.exec(abs);
  const rel = m ? `${m[1].toLowerCase()}${p.sep}${m[2]}` : abs.replace(/^[\\/]+/, '');
  const out = p.resolve(dir, rel);
  return out.startsWith(p.resolve(dir) + p.sep) ? out : '';
}

// Creates the mailbox and returns '' when it is safe to use, else the reason it is not.
function prepare(dir, uid = WIN ? -1 : process.getuid()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(dir);
  if (s.isSymbolicLink() || !s.isDirectory()) return `${dir} is not a directory`;
  if (WIN) return '';   // inside the user's profile; POSIX owner and mode do not apply
  if (s.uid !== uid) return `${dir} belongs to another user`;
  if (s.mode & 0o077) fs.chmodSync(dir, 0o700);
  return '';
}

// Lines, age and completeness of a request file, or null for anything but a small regular file (a link, a FIFO).
function readRequest(f, now = Date.now()) {
  try {
    const s = fs.lstatSync(f);
    if (!s.isFile() || s.size > MAX_REQUEST) return null;
    const text = fs.readFileSync(f, 'utf8');
    return { lines: text.split('\n'), age: now - s.mtimeMs, complete: text.endsWith('\n') };
  } catch { return null; }
}

const toPath = (p, win = WIN) => {   // Git Bash writes /c/Users/…; on Windows that is C:/Users/…
  const m = win && /^\/([a-zA-Z])\/(.*)$/.exec(p);
  return path.resolve(m ? `${m[1]}:/${m[2]}` : p);
};
// [kind, absolute path] or null; control characters never reach a path
const parse = (line) => {
  const m = /^(pair|git|saved) ([^\u0000-\u001f\u007f]+)$/.exec(line.trim());
  return m && path.isAbsolute(m[2]) ? [m[1], toPath(m[2])] : null;
};
const fold = (p) => (process.platform === 'linux' ? p : p.toLowerCase());   // Windows and macOS: case-insensitive
const real = (p) => {   // links resolved; for a path that does not exist yet, through its nearest existing parent
  try { return fs.realpathSync.native(p); } catch {
    const up = path.dirname(p);
    return up === p ? p : path.join(real(up), path.basename(p));
  }
};
const inside = (file, roots) => {   // roots: workspace folders, each folded with a trailing separator
  const f = fold(real(file));
  return roots.some((r) => f.startsWith(r));
};
const rootsOf = (folders) => folders.map((d) => fold(real(d).replace(/[\\/]+$/, '') + path.sep));

// The repository root above a file (a .git directory, or a .git file of a worktree or submodule), without running
// git: the folder may not be trusted yet. '' when there is none.
function findRoot(file) {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return '';
  }
}

// What a window does with one request file:
//   { action: 'own', reqs, rest }   take it, open reqs here, write rest (other lines) back
//   { action: 'forward', folder }   take it for the project in folder: rename to "open-<name>", open the folder
//   { action: 'refuse', reason }    take it and say why it cannot be opened
//   { action: 'drop' }              stale or without a request: delete it
//   { action: 'wait' }              still being written, or a young orphan: look again after ORPHAN_AFTER
//   { action: '' }                  leave it to another window
function decide({ name, lines, age, complete = true, roots, focused, home = os.homedir() }) {
  if (age > STALE_AFTER) return { action: 'drop' };
  if (!complete) return { action: 'wait' };
  const reqs = lines.map((l) => [l, parse(l)]).filter(([, r]) => r);
  if (!reqs.length) return { action: 'drop' };
  const split = (take) => ({ reqs: reqs.filter(take).map(([, r]) => r), rest: reqs.filter((x) => !take(x)).map(([l]) => l) });
  if (reqs.some(([, r]) => inside(r[1], roots))) return { action: 'own', ...split(([, r]) => inside(r[1], roots)) };
  if (name.startsWith(FORWARDED)) return { action: '' };
  if (age < ORPHAN_AFTER) return { action: 'wait' };
  if (!focused) return { action: '' };
  const [kind, file] = reqs[0][1];
  if (kind !== 'git') return { action: 'own', ...split(([, r]) => r[0] !== 'git') };   // opening files runs no git
  const root = findRoot(real(file));
  if (!root) return { action: 'refuse', reason: `${file} is not in a git repository` };
  if (fold(real(root)) === fold(real(home))) return { action: 'refuse', reason: `${file} is in the repository of the home folder; open its project folder yourself` };
  return { action: 'forward', folder: root };
}

module.exports = { MAX_REQUEST, ORPHAN_AFTER, STALE_AFTER, FORWARDED, location, proposals, proposalOf, prepare, readRequest, parse, toPath, real, rootsOf, inside, findRoot, decide };
