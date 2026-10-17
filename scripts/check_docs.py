"""Check the migrated initial documents against the committed SHA-256 inventory."""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    manifest = json.loads((ROOT / "docs" / "initial-manifest.json").read_text(encoding="utf-8"))
    for relative, expected in manifest["files"].items():
        document = ROOT / "docs" / "initial" / relative
        actual = hashlib.sha256(document.read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(
                f"Initial document changed: {relative}. "
                "Preserve originals; add current docs separately."
            )
    print(f"Verified {len(manifest['files'])} initial documents against the migration inventory.")


if __name__ == "__main__":
    main()
