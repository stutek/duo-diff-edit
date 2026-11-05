#!/usr/bin/env python3
"""Build dist/duo-diff-edit-<version>.vsix from vscode/ without Node.js tooling (a .vsix is a zip with a manifest).

Usage: python3 scripts/build-vsix.py
Install: code --install-extension dist/duo-diff-edit-<version>.vsix
"""
import json
import pathlib
import zipfile
from xml.sax.saxutils import escape

root = pathlib.Path(__file__).resolve().parent.parent
src = root / 'vscode'
pkg = json.loads((src / 'package.json').read_text(encoding='utf-8'))
out = root / 'dist' / f"{pkg['name']}-{pkg['version']}.vsix"
out.parent.mkdir(exist_ok=True)

manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="{pkg['name']}" Version="{pkg['version']}" Publisher="{pkg['publisher']}"/>
<DisplayName>{escape(pkg['displayName'])}</DisplayName>
<Description xml:space="preserve">{escape(pkg['description'])}</Description>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{pkg['engines']['vscode']}"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>'''
content_types = '''<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/>
<Default Extension=".md" ContentType="text/markdown"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>'''

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('extension.vsixmanifest', manifest)
    z.writestr('[Content_Types].xml', content_types)
    for f in sorted(src.iterdir()):
        z.write(f, f'extension/{f.name}')
    z.write(root / 'LICENSE', 'extension/LICENSE.md')
print(out)
