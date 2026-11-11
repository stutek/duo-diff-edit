#!/usr/bin/env python3
"""Every check before a commit, on Linux, macOS and Windows: python3 scripts/check.py [--e2e] [--tag vX.Y.Z]

1. one version: vscode/package.json, plugin/.claude-plugin/plugin.json (and the tag, when given)
2. syntax: node --check on the extension's JavaScript
3. unit tests: node --test (the request mailbox)
4. build: scripts/build-vsix.py, and the package holds exactly the expected files
5. plugin: claude plugin validate . and claude plugin test plugin (CLAUDE names the claude CLI, else PATH)
6. with --e2e: scripts/e2e-vscode.py, the extension in a real Visual Studio Code on a virtual display (Linux)
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument('--e2e', action='store_true', help='also run the end-to-end test in Visual Studio Code (Linux)')
ap.add_argument('--tag', help='a release tag that must match the version, e.g. v0.1.0')
args = ap.parse_args()


def step(name, cmd):
    print(f'== {name}: {" ".join(map(str, cmd))}', flush=True)
    if subprocess.run(cmd, cwd=root).returncode:
        sys.exit(f'check failed: {name}')


ext = json.loads((root / 'vscode' / 'package.json').read_text(encoding='utf-8'))
plugin = json.loads((root / 'plugin' / '.claude-plugin' / 'plugin.json').read_text(encoding='utf-8'))
print(f"== version: extension {ext['version']}, plugin {plugin['version']}{f', tag {args.tag}' if args.tag else ''}")
if ext['version'] != plugin['version'] or (args.tag and args.tag != f"v{ext['version']}"):
    sys.exit('check failed: version (vscode/package.json and plugin/.claude-plugin/plugin.json change together)')

node = shutil.which('node') or sys.exit('check failed: node is not on PATH')
for f in sorted((root / 'vscode').glob('*.js')):
    step(f'syntax {f.name}', [node, '--check', f])
step('unit tests', [node, '--test', *sorted((root / 'test').glob('*.test.js'))])

step('build', [sys.executable, root / 'scripts' / 'build-vsix.py'])
vsix = root / 'dist' / f"{ext['name']}-{ext['version']}.vsix"
names = sorted(zipfile.ZipFile(vsix).namelist())
expected = sorted(['extension.vsixmanifest', '[Content_Types].xml', 'extension/LICENSE.md', 'extension/blocks.js',
                   'extension/extension.js', 'extension/mailbox.js', 'extension/package.json'])
print(f'== package: {names}')
if names != expected:
    sys.exit(f'check failed: package contents, expected {expected}')

claude = os.environ.get('CLAUDE') or shutil.which('claude')
if not claude:
    sys.exit('check failed: no claude CLI (set CLAUDE to its path)')
step('plugin validate', [claude, 'plugin', 'validate', '.'])
step('plugin test', [claude, 'plugin', 'test', 'plugin'])

if args.e2e:
    step('end-to-end', [sys.executable, root / 'scripts' / 'e2e-vscode.py'])
print('all checks passed')
