#!/usr/bin/env python3
"""Build dist/duo-diff-edit-<version>.vsix from vscode/ without Node.js tooling (a .vsix is a zip with a manifest).

Only the files in FILES are packaged, so a stray file in vscode/ never ships. The build is reproducible: the same
sources give the same bytes (fixed timestamps and modes), so anyone can check a release against the tag with
sha256. Writes the .vsix and its .sha256 next to it.

Usage: python3 scripts/build-vsix.py
Install: code --install-extension dist/duo-diff-edit-<version>.vsix
"""
import hashlib
import json
import pathlib
import zipfile
from xml.sax.saxutils import escape, quoteattr

FILES = ['extension.js', 'mailbox.js', 'package.json']
DATE = (1980, 1, 1, 0, 0, 0)   # the earliest a zip can store

root = pathlib.Path(__file__).resolve().parent.parent
src = root / 'vscode'
pkg = json.loads((src / 'package.json').read_text(encoding='utf-8'))
out = root / 'dist' / f"{pkg['name']}-{pkg['version']}.vsix"
out.parent.mkdir(exist_ok=True)

extra = sorted(f.name for f in src.iterdir() if f.name not in FILES)
if extra:
    raise SystemExit(f'vscode/ holds files the build does not package: {extra}; add them to FILES or move them')

manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id={quoteattr(pkg['name'])} Version={quoteattr(pkg['version'])} Publisher={quoteattr(pkg['publisher'])}/>
<DisplayName>{escape(pkg['displayName'])}</DisplayName>
<Description xml:space="preserve">{escape(pkg['description'])}</Description>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value={quoteattr(pkg['engines']['vscode'])}/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>'''
content_types = '''<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/>
<Default Extension=".md" ContentType="text/markdown"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>'''


def add(z, name, data):
    info = zipfile.ZipInfo(name, DATE)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    z.writestr(info, data)


with zipfile.ZipFile(out, 'w') as z:
    add(z, 'extension.vsixmanifest', manifest.encode())
    add(z, '[Content_Types].xml', content_types.encode())
    for name in FILES:
        add(z, f'extension/{name}', (src / name).read_bytes())
    add(z, 'extension/LICENSE.md', (root / 'LICENSE').read_bytes())

digest = hashlib.sha256(out.read_bytes()).hexdigest()
out.with_name(out.name + '.sha256').write_text(f'{digest}  {out.name}\n', encoding='utf-8')
print(out)
