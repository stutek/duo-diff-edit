#!/usr/bin/env python3
"""The CI jobs that run on Linux, locally, in a container like GitHub's ubuntu-latest runner: python3 scripts/ci-local.py [REV]

The pre-push hook (.githooks/pre-push) runs it for every commit that goes out. It checks the commit REV (default HEAD),
not the working tree: git archive REV goes into a fresh container of scripts/ci.Dockerfile (Ubuntu 24.04, the Node.js
major and the Claude Code version that .github/workflows/ci.yml names), which runs, with CI=true, the job check
(python3 scripts/check.py) and the job e2e (the Visual Studio Code that ci.yml downloads, build-vsix.py, e2e-vscode.py).
The end-to-end test needs that container: this machine's display and Visual Studio Code keep the main window focused
where a runner's do not. Needs Docker (rootless is fine). Python is Ubuntu's 3.12, where CI sets up 3.13; the macOS and
Windows jobs run on GitHub only.
"""
import pathlib
import re
import shutil
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
rev = sys.argv[1] if len(sys.argv) > 1 else 'HEAD'
ci = (root / '.github' / 'workflows' / 'ci.yml').read_text(encoding='utf-8')


def pinned(pattern, what):
    m = re.search(pattern, ci)
    return m.group(1) if m else sys.exit(f'ci-local: {what} not found in .github/workflows/ci.yml')


node = pinned(r'node-version:\s*(\d+)', 'node-version')
claude = pinned(r'@anthropic-ai/claude-code@([\w.-]+)', 'the Claude Code version')
vscode_url = pinned(r'(https://update\.code\.visualstudio\.com/\S+)', 'the Visual Studio Code download')
if not shutil.which('docker'):
    sys.exit('ci-local: needs Docker; skip once with git push --no-verify')
sha = subprocess.run(['git', 'rev-parse', '--short', f'{rev}^{{commit}}'], cwd=root, capture_output=True, text=True)
if sha.returncode:
    sys.exit(f'ci-local: {rev} is no commit')

image = f'duo-diff-edit-ci:node{node}-claude{claude}'
print(f'== ci-local: {rev} ({sha.stdout.strip()}) in {image} (the first build takes a few minutes)', flush=True)
with open(root / 'scripts' / 'ci.Dockerfile', 'rb') as dockerfile:   # no build context: the image copies nothing
    if subprocess.run(['docker', 'build', '--pull', '-q', '-t', image, '--build-arg', f'NODE={node}',
                       '--build-arg', f'CLAUDE_CODE={claude}', '-'], stdin=dockerfile, stdout=subprocess.DEVNULL).returncode:
        sys.exit('ci-local: docker build failed')

# the two Linux jobs of ci.yml, in its order; Chromium needs more shared memory than Docker's default 64 MB
jobs = f'''set -e
mkdir src && tar -x -C src && cd src
echo "== job check"
python3 scripts/check.py
echo "== job e2e"
mkdir ../vscode && curl -fsSL {vscode_url} | tar -xz -C ../vscode --strip-components=1
python3 scripts/build-vsix.py
python3 scripts/e2e-vscode.py --code ../vscode/bin/code
'''
archive = subprocess.Popen(['git', 'archive', rev], cwd=root, stdout=subprocess.PIPE)
run = subprocess.run(['docker', 'run', '--rm', '-i', '--shm-size=2g', '-e', 'CI=true', image, 'sh', '-c', jobs],
                     stdin=archive.stdout)
archive.stdout.close()
if archive.wait() or run.returncode:
    sys.exit(f'ci-local: failed on {rev}; fix it before the push (skip once with git push --no-verify)')
print(f'== ci-local: the Linux jobs of CI passed on {rev}')
