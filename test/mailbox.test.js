// Unit tests of vscode/mailbox.js: node --test test/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const box = require('../vscode/mailbox');

const WIN = process.platform === 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'duo-diff-edit-test-'));
const proj = WIN ? 'C:\\work\\proj' : '/work/proj';
const roots = box.rootsOf([proj]);
const at = (...p) => path.join(proj, ...p);

test('location: XDG_RUNTIME_DIR, else <home>/.cache, never the temp directory', () => {
  assert.equal(box.location({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/me'), path.join('/run/user/1000', 'duo-diff-edit'));
  assert.equal(box.location({ TMPDIR: '/tmp' }, '/home/me'), path.join('/home/me', '.cache', 'duo-diff-edit'));
});

test('prepare: creates the mailbox private; refuses a symbolic link and another owner; tightens a loose mode', { skip: WIN && 'POSIX owner and mode' }, () => {
  const d = tmp();
  const box1 = path.join(d, 'a', 'duo-diff-edit');
  assert.equal(box.prepare(box1), '');
  assert.equal(fs.statSync(box1).mode & 0o777, 0o700);

  fs.chmodSync(box1, 0o777);
  assert.equal(box.prepare(box1), '');
  assert.equal(fs.statSync(box1).mode & 0o777, 0o700);

  assert.match(box.prepare(box1, process.getuid() + 1), /another user/);

  const link = path.join(d, 'link');
  fs.symlinkSync(box1, link);
  assert.match(box.prepare(link), /not a directory/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('readRequest: a small regular file only', () => {
  const d = tmp();
  const f = path.join(d, 'r');
  fs.writeFileSync(f, `git ${at('a.md')}\n`);
  const r = box.readRequest(f, fs.statSync(f).mtimeMs + 500);
  assert.deepEqual(r.lines, [`git ${at('a.md')}`, '']);
  assert.equal(r.complete, true);
  assert.ok(Math.abs(r.age - 500) < 1);   // mtimeMs carries fractions of a millisecond
  fs.writeFileSync(f, `git ${at('a')}`);   // a writer halfway
  assert.equal(box.readRequest(f).complete, false);

  fs.writeFileSync(path.join(d, 'big'), 'x'.repeat(box.MAX_REQUEST + 1));
  assert.equal(box.readRequest(path.join(d, 'big')), null);
  assert.equal(box.readRequest(path.join(d, 'missing')), null);
  if (!WIN) {   // creating symbolic links on Windows needs a privilege
    fs.symlinkSync(f, path.join(d, 'link'));
    assert.equal(box.readRequest(path.join(d, 'link')), null);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('parse: absolute paths only, no control characters', () => {
  assert.deepEqual(box.parse(`git ${at('a.md')}\r`), ['git', at('a.md')]);
  assert.deepEqual(box.parse(`saved ${at('b c.md')}`), ['saved', at('b c.md')]);
  assert.deepEqual(box.parse(`pair ${at('b c.md')}`), ['pair', at('b c.md')]);
  assert.equal(box.parse('git a.md'), null);
  assert.equal(box.parse('rm -rf /'), null);
  assert.equal(box.parse(`git ${at('a\u0007.md')}`), null);
  assert.equal(box.parse(''), null);
});

test('proposals: beside the mailbox; a proposal sits at its file\'s absolute path, never outside the directory', () => {
  assert.equal(box.proposals({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/me'), path.join('/run/user/1000', 'duo-diff-edit-proposals'));
  assert.equal(box.proposals({}, '/home/me'), path.join('/home/me', '.cache', 'duo-diff-edit-proposals'));
  const dir = '/run/user/1000/duo-diff-edit-proposals';
  assert.equal(box.proposalOf('/home/me/CV a.md', dir, false), `${dir}/home/me/CV a.md`);   // the shell line: "$P$F"
  assert.equal(box.proposalOf('/home/me/../../etc/x', dir, false), `${dir}/etc/x`);
  assert.equal(box.proposalOf('/', dir, false), '');
  const wdir = 'C:\\Users\\me\\.cache\\duo-diff-edit-proposals';
  assert.equal(box.proposalOf('C:\\Users\\me\\a.md', wdir, true), `${wdir}\\c\\Users\\me\\a.md`);   // Git Bash: "$P/c/Users/me/a.md"
  assert.equal(box.proposalOf('c:/Users/me/a.md', wdir, true), `${wdir}\\c\\Users\\me\\a.md`);
});

test('toPath: Git Bash drive paths on Windows', { skip: !WIN && 'Windows paths' }, () => {
  assert.equal(box.toPath('/c/Users/me/a.md'), 'C:\\Users\\me\\a.md');
});

test('inside: the workspace folder and below, not a sibling with the same prefix', () => {
  assert.ok(box.inside(at('a.md'), roots));
  assert.ok(!box.inside(`${proj}2${path.sep}a.md`, roots));
  if (process.platform !== 'linux') assert.ok(box.inside(at('A.MD').toUpperCase(), roots));
});

test('findRoot: .git directory or file, without running git', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'r', '.git'), { recursive: true });
  fs.mkdirSync(path.join(d, 'r', 'sub'));
  fs.mkdirSync(path.join(d, 'w'));
  fs.writeFileSync(path.join(d, 'w', '.git'), 'gitdir: ../r/.git/worktrees/w\n');
  fs.mkdirSync(path.join(d, 'none'));
  assert.equal(box.findRoot(path.join(d, 'r', 'sub', 'a.md')), path.join(d, 'r'));
  assert.equal(box.findRoot(path.join(d, 'w', 'a.md')), path.join(d, 'w'));
  // a temp directory may sit inside a repository; then the nearest root above is that one, not ''
  const above = box.findRoot(d);
  assert.equal(box.findRoot(path.join(d, 'none', 'a.md')), above);
  fs.rmSync(d, { recursive: true, force: true });
});

test('decide: own, being written, young orphan, leave, drop, rest', () => {
  const own = `git ${at('a.md')}`, other = `git ${path.join(path.dirname(proj), 'other', 'b.md')}`;
  const base = { name: '1', roots, focused: false };
  assert.deepEqual(box.decide({ ...base, lines: [own, ''], age: 0 }), { action: 'own', reqs: [['git', at('a.md')]], rest: [] });
  assert.deepEqual(box.decide({ ...base, lines: [own, other], age: 0 }), { action: 'own', reqs: [['git', at('a.md')]], rest: [other] });
  assert.deepEqual(box.decide({ ...base, lines: [own], age: 0, complete: false }), { action: 'wait' });
  assert.deepEqual(box.decide({ ...base, lines: [''], age: 0, complete: false }), { action: 'wait' });   // created, not yet written
  assert.deepEqual(box.decide({ ...base, lines: [other], age: 100 }), { action: 'wait' });
  assert.deepEqual(box.decide({ ...base, lines: [other], age: 2000 }), { action: '' });   // not focused
  assert.deepEqual(box.decide({ ...base, name: `${box.FORWARDED}1`, focused: true, lines: [other], age: 2000 }), { action: '' });
  assert.deepEqual(box.decide({ ...base, name: `${box.FORWARDED}1`, lines: [own], age: 2000 }).action, 'own');
  assert.deepEqual(box.decide({ ...base, lines: [own], age: box.STALE_AFTER + 1 }), { action: 'drop' });   // a reload never replays old clicks
  assert.deepEqual(box.decide({ ...base, lines: ['hello'], age: 0 }), { action: 'drop' });
});

test('decide: an orphan is forwarded to its repository, opened here when no git runs, else refused', () => {
  const d = fs.realpathSync(tmp());
  fs.mkdirSync(path.join(d, 'repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(d, 'plain'));
  const base = { name: '1', roots, focused: true, age: 2000, home: path.join(d, 'home') };
  const file = path.join(d, 'repo', 'b.md');
  assert.deepEqual(box.decide({ ...base, lines: [`git ${file}`] }), { action: 'forward', folder: path.join(d, 'repo') });
  assert.deepEqual(box.decide({ ...base, roots: [], lines: [`git ${file}`] }), { action: 'forward', folder: path.join(d, 'repo') });   // a window without a folder
  assert.deepEqual(box.decide({ ...base, lines: [`saved ${path.join(d, 'plain', 'c.md')}`, `git ${file}`] }),
    { action: 'own', reqs: [['saved', path.join(d, 'plain', 'c.md')]], rest: [`git ${file}`] });
  assert.deepEqual(box.decide({ ...base, lines: [`pair ${file}`, `saved ${file}`] }),   // a pair opens files only, no git
    { action: 'own', reqs: [['pair', file], ['saved', file]], rest: [] });
  if (box.findRoot(path.join(d, 'plain', 'c.md')) === '') {   // unless the temp directory sits inside a repository
    assert.equal(box.decide({ ...base, lines: [`git ${path.join(d, 'plain', 'c.md')}`] }).action, 'refuse');
  }
  assert.equal(box.decide({ ...base, home: path.join(d, 'repo'), lines: [`git ${file}`] }).action, 'refuse');   // ~ is a repository
  if (!WIN) {   // a link inside the workspace that points out of it is forwarded by its real path
    fs.symlinkSync(path.join(d, 'repo'), path.join(d, 'plain', 'link'));
    assert.deepEqual(box.decide({ ...base, lines: [`git ${path.join(d, 'plain', 'link', 'b.md')}`] }), { action: 'forward', folder: path.join(d, 'repo') });
  }
  fs.rmSync(d, { recursive: true, force: true });
});
