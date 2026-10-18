"""Verify immutable Figma audit evidence, including the original analyzer source."""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    folder = ROOT / "docs/audits/assets/2026-10-17-figma-vectorization"
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    for entry in manifest["files"]:
        path = folder / entry["name"]
        data = path.read_bytes()
        if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise SystemExit(f"Archived audit evidence changed: {entry['name']}")
    print(f"Verified {len(manifest['files'])} immutable audit artifacts.")


if __name__ == "__main__":
    main()
