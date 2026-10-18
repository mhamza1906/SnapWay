"""Check the migrated initial documents against the committed SHA-256 inventory."""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    count = verify(ROOT)
    print(f"Verified {count} initial documents against the recorded migration/update inventory.")


def verify(root):
    manifest = json.loads((root / "docs" / "initial-manifest.json").read_text(encoding="utf-8"))
    updates_path = root / "docs/initial-approved-updates.json"
    updates = (
        json.loads(updates_path.read_text(encoding="utf-8"))["updates"]
        if updates_path.exists()
        else {}
    )
    if updates.keys() - manifest["files"].keys():
        raise SystemExit("Unknown initial document in approved-update inventory")
    for relative, expected in manifest["files"].items():
        update = updates.get(relative)
        current_path = relative
        if update:
            if update["original_sha256"] != expected or not update.get("upstream_commit"):
                raise SystemExit(f"Invalid initial-document provenance: {relative}")
            current_path, expected = update["path"], update["sha256"]
        document = root / "docs" / "initial" / current_path
        if not document.resolve().is_relative_to((root / "docs/initial").resolve()):
            raise SystemExit("Initial-document path escapes the preserved directory")
        if not document.is_file():
            raise SystemExit(f"Missing initial document: {current_path}")
        actual = hashlib.sha256(document.read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(
                f"Initial document changed: {relative}. "
                "Preserve originals; add current docs separately."
            )
    return len(manifest["files"])


if __name__ == "__main__":
    main()
