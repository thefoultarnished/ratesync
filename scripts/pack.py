"""Builds the Chrome Web Store zip from only the files the extension references.

Nothing is transformed — this just zips the runtime files, so tests/, docs/, scripts/,
node_modules/ and source images can never ship by accident.

    python scripts/pack.py        ->  ratesync-v<version>.zip in the repo root
"""
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEVER_SHIP = ("tests/", "docs/", "scripts/", "node_modules/", ".claude/")


def referenced_files():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    files = {"manifest.json", manifest["background"]["service_worker"]}
    for script in manifest.get("content_scripts", []):
        files.update(script.get("js", []))
        files.update(script.get("css", []))
    files.update(manifest.get("icons", {}).values())
    action = manifest.get("action", {})
    files.update(action.get("default_icon", {}).values())

    popup = action.get("default_popup")
    if popup:
        files.add(popup)
        html = (ROOT / popup).read_text(encoding="utf-8")
        # Local scripts/stylesheets only; external links (https:) are not packaged.
        for ref in re.findall(r'(?:src|href)=["\']([^"\'#?]+)["\']', html):
            if not re.match(r"^[a-z]+:", ref):
                files.add(ref)
    return sorted(files), manifest["version"]


def main():
    files, version = referenced_files()
    missing = [f for f in files if not (ROOT / f).is_file()]
    if missing:
        sys.exit(f"Missing files referenced by the extension: {missing}")
    leaked = [f for f in files if f.startswith(NEVER_SHIP)]
    if leaked:
        sys.exit(f"Refusing to package dev-only files: {leaked}")

    out = ROOT / f"ratesync-v{version}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.write(ROOT / f, f)  # forward-slash names, which the Web Store requires
    print(f"{out.name}: {len(files)} files")
    for f in files:
        print(f"  {f}")


if __name__ == "__main__":
    main()
