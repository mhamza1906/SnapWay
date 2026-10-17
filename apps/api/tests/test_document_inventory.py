"""Document renames/approved updates must not weaken hash or provenance checks."""

import hashlib
import json

import pytest

from scripts.check_docs import verify


def test_recorded_rename_and_baseline_update_preserve_integrity(tmp_path):
    docs = tmp_path / "docs"
    (docs / "initial/archive").mkdir(parents=True)
    current = b"approved upstream content"
    original = hashlib.sha256(b"original snapshot").hexdigest()
    (docs / "initial/archive/new.md").write_bytes(current)
    (docs / "initial-manifest.json").write_text(json.dumps({"files": {"old.md": original}}))
    update = {
        "original_sha256": original,
        "path": "archive/new.md",
        "sha256": hashlib.sha256(current).hexdigest(),
        "upstream_commit": "upstream-fixture",
    }
    (docs / "initial-approved-updates.json").write_text(json.dumps({"updates": {"old.md": update}}))
    assert verify(tmp_path) == 1
    (docs / "initial/archive/new.md").write_bytes(b"unexpected edit")
    with pytest.raises(SystemExit, match="Initial document changed"):
        verify(tmp_path)


def test_unknown_document_update_is_rejected(tmp_path):
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "initial-manifest.json").write_text(json.dumps({"files": {}}))
    (docs / "initial-approved-updates.json").write_text(json.dumps({"updates": {"extra": {}}}))
    with pytest.raises(SystemExit, match="Unknown initial document"):
        verify(tmp_path)
