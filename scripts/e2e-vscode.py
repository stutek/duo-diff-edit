#!/usr/bin/env python3
"""End-to-end test of the extension in a real Visual Studio Code on a virtual display (Linux with xvfb-run).

Installs dist/<name>-<version>.vsix into a throwaway extensions and user data directory under .private/tmp/, with its
own mailbox (XDG_RUNTIME_DIR) and no session bus or Wayland display, so it never touches the user's windows, KWin or
mailbox. Checks, from the extension's log (Output → Duo Diff Edit) and the mailbox:
  1. a trusted window opens its own request and takes it; an untracked file enters the index empty;
  2. a stale request (older than 60 s) is dropped, not opened;
  3. an orphan (a repository no window has open) is forwarded: the project's folder opens in a new window, which
     opens the request;
  4. in Restricted Mode (an untrusted folder) the extension does not run and leaves the request alone.

Usage: python3 scripts/e2e-vscode.py [--code PATH] [--keep]   (build the .vsix first: scripts/build-vsix.py)
"""
import argparse
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import time

root = pathlib.Path(__file__).resolve().parent.parent
pkg = json.loads((root / 'vscode' / 'package.json').read_text(encoding='utf-8'))
vsix = root / 'dist' / f"{pkg['name']}-{pkg['version']}.vsix"
ext_id = f"{pkg['publisher']}.{pkg['name']}"

ap = argparse.ArgumentParser()
ap.add_argument('--code', default=os.environ.get('CODE') or shutil.which('code'), help='Visual Studio Code CLI')
ap.add_argument('--keep', action='store_true', help='keep the work directory for inspection')
args = ap.parse_args()
if sys.platform != 'linux' or not shutil.which('xvfb-run'):
    sys.exit('e2e: needs Linux with xvfb-run')
if not args.code or not vsix.exists():
    sys.exit(f'e2e: needs the code CLI (--code) and {vsix.relative_to(root)} (python3 scripts/build-vsix.py)')

work = root / '.private' / 'tmp' / f'e2e-{os.getpid()}'
run_dir, ext_dir = work / 'run', work / 'extensions'
mailbox = run_dir / 'duo-diff-edit'
run_dir.mkdir(parents=True, mode=0o700)
env = {k: v for k, v in os.environ.items() if k not in ('DBUS_SESSION_BUS_ADDRESS', 'WAYLAND_DISPLAY', 'DISPLAY')}
env['XDG_RUNTIME_DIR'] = str(run_dir)
failures = []


def check(ok, what):
    print(('ok    ' if ok else 'FAIL  ') + what, flush=True)
    if not ok:
        failures.append(what)


def wait_for(pred, timeout):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.25)
    return False


def git(cwd, *a):
    return subprocess.run(['git', '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', *a], cwd=cwd,
                          check=True, capture_output=True, text=True).stdout


def repo(name, files):
    d = work / name
    d.mkdir()
    git(d, 'init', '-q')
    for f, text in files.items():
        (d / f).write_text(text, encoding='utf-8')
    git(d, 'add', '.')
    git(d, 'commit', '-qm', 'start')
    return d


def user_dir(name, trust):
    u = work / name
    (u / 'User').mkdir(parents=True)
    (u / 'User' / 'settings.json').write_text(json.dumps({
        'security.workspace.trust.enabled': trust,
        'security.workspace.trust.startupPrompt': 'never',
        'window.restoreWindows': 'none',
        'workbench.startupEditor': 'none',
        'extensions.autoUpdate': False,
        'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
    }), encoding='utf-8')
    return u


def logs(u):   # every window's log of the extension, joined
    return '\n'.join(p.read_text(encoding='utf-8', errors='replace')
                     for p in (u / 'logs').glob(f'*/window*/exthost/{ext_id}/*.log'))


def start(u, folder):
    # --wait keeps the CLI (and so xvfb-run's display) alive while the window is open
    p = subprocess.Popen(['xvfb-run', '-a', '-s', '-screen 0 1920x1080x24', args.code, '--user-data-dir', str(u),
                          '--extensions-dir', str(ext_dir), '--disable-gpu', '--wait', '--new-window', str(folder)],
                         env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return p


def stop(p):
    try:
        os.killpg(p.pid, signal.SIGTERM)   # the session started for this window only
        p.wait(timeout=20)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def request(name, line, age=0.0):
    mailbox.mkdir(mode=0o700, exist_ok=True)
    f = mailbox / name
    f.write_text(line + '\n', encoding='utf-8')
    if age:
        t = time.time() - age
        os.utime(f, (t, t))
    return f


procs = []
try:
    subprocess.run([args.code, '--extensions-dir', str(ext_dir), '--user-data-dir', str(work / 'install'),
                    '--install-extension', str(vsix)], env=env, check=True, capture_output=True)
    proj = repo('proj', {'a.md': 'one\n'})
    other = repo('other', {'c.md': 'three\n'})
    (proj / 'a.md').write_text('one, edited\n', encoding='utf-8')
    (proj / 'new.md').write_text('new\n', encoding='utf-8')

    # trusted window
    u = user_dir('user-trusted', trust=False)
    procs.append(start(u, proj))
    if not wait_for(lambda: 'mailbox ' in logs(u), 90):
        main = '\n'.join(p.read_text(errors='replace') for p in (u / 'logs').glob('*/main.log'))
        if 'EMFILE' in main:
            sys.exit('e2e: Visual Studio Code could not start: no inotify instance left (EMFILE). Raise the limit:\n'
                     '  sudo sysctl -w fs.inotify.max_user_instances=1024')
        sys.exit('e2e: the extension did not activate within 90 s; run with --keep and read the logs')
    check(f'mailbox {mailbox}' in logs(u) and 'refused' not in logs(u), 'the mailbox is the private one under XDG_RUNTIME_DIR')

    f = request('1', f'git {proj / "a.md"}')
    check(wait_for(lambda: f'open git {proj / "a.md"}' in logs(u), 20) and not f.exists(), 'own request: opened and taken')
    f = request('2', f'git {proj / "new.md"}')
    check(wait_for(lambda: f'open git {proj / "new.md"}' in logs(u), 20), 'untracked file: opened')
    check(wait_for(lambda: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' in git(proj, 'ls-files', '-s', 'new.md'), 10),
          'untracked file: in the index as the empty blob')
    f = request('3', f'git {proj / "a.md"}', age=120)
    check(wait_for(lambda: '3: stale' in logs(u), 20) and not f.exists(), 'stale request: dropped')
    check(logs(u).count(f'open git {proj / "a.md"}') == 1, 'stale request: not opened')

    f = request('4', f'git {other / "c.md"}')
    forwarded = wait_for(lambda: f'opening {other}' in logs(u), 20)
    if not forwarded and 'opening' not in logs(u):
        print('note  the window never reported focus on this display; the orphan test needs a focused window')
    check(forwarded, 'orphan: the focused window opens its project folder')
    check(wait_for(lambda: f'open git {other / "c.md"}' in logs(u), 60), "orphan: the project's new window opens it")
    check(wait_for(lambda: not any(mailbox.iterdir()), 10), 'mailbox empty at the end')
    for p in procs:
        stop(p)
    procs.clear()

    # untrusted window: Restricted Mode
    u = user_dir('user-untrusted', trust=True)
    procs.append(start(u, proj))
    f = request('5', f'git {proj / "a.md"}')
    started = wait_for(lambda: any((u / 'logs').glob('*/window*/exthost/exthost.log')), 90)
    time.sleep(15)   # long enough for an activated extension to take it (it polls every 0.5 s)
    check(started and f.exists() and 'mailbox ' not in logs(u), 'Restricted Mode: the extension does not run, the request stays')
finally:
    for p in procs:
        stop(p)
    if args.keep:
        print(f'kept {work}')
    else:
        shutil.rmtree(work, ignore_errors=True)

print(f'e2e: {len(failures)} failed' if failures else 'e2e: all passed')
sys.exit(1 if failures else 0)
