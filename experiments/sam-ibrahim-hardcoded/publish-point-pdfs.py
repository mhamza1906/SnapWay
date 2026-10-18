"""Publish the verified source/point PDFs to existing R2 storage, then update the allowlist.

Use the app's existing Django environment. No bucket-policy or credentials changes.
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original", type=Path, required=True)
    parser.add_argument("--plan-folder", type=Path, required=True)
    args = parser.parse_args()
    inventory = json.loads((Path(__file__).parent / "data/source-manifest.json").read_text())
    original = next(item for item in inventory["sources"] if item["id"] == "sam-ibrahim-review-pdf")
    report = json.loads((args.plan_folder / "pdf-report.json").read_text())
    if report["ceiling"] != 40 or report["walks"] != 11:
        raise ValueError("Unexpected point-plan profile.")
    sources = [
        (
            "sam-ibrahim-review",
            args.original,
            original["sha256"],
            original["pageCount"],
            "Sam Ibrahim indoor navigation review",
        ),
        (
            "sam-ibrahim-points",
            args.plan_folder / report["filename"],
            report["sha256"],
            report["pages"],
            "Sam Ibrahim photo points - 40-stop cap",
        ),
    ]
    payloads = []
    for slug, path, expected_hash, pages, title in sources:
        raw = path.read_bytes()
        if not raw.startswith(b"%PDF-") or hashlib.sha256(raw).hexdigest() != expected_hash:
            raise ValueError(f"PDF content differs from verified report: {slug}")
        payloads.append((slug, path.name, raw, expected_hash, pages, title))
    sys.path.insert(0, str(ROOT / "apps/api"))
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.development")
    import django

    django.setup()
    from django.core.files.storage import default_storage
    from maps.services.media_store import point_photo_storage_ready, put_bytes, read_bytes

    if not point_photo_storage_ready():
        raise RuntimeError("Configured HTTPS Cloudflare R2 storage is required; no local fallback.")
    documents = {}
    for slug, filename, raw, digest, pages, title in payloads:
        key = f"shared/documents/sam-ibrahim/{digest}/{filename}"
        if not default_storage.exists(key):
            saved = put_bytes(key, raw, "application/pdf")
            if saved != key:
                raise RuntimeError("Storage renamed a content-addressed document.")
        fetched = read_bytes(key)
        if len(fetched) != len(raw) or hashlib.sha256(fetched).hexdigest() != digest:
            raise RuntimeError(f"R2 read-back verification failed: {slug}")
        documents[slug] = {
            "title": title,
            "filename": filename,
            "sha256": digest,
            "bytes": len(raw),
            "pages": pages,
            "storage_key": key,
        }
        if slug == "sam-ibrahim-points":
            documents[slug].update(
                ceiling=40, points=report["points"], added=report["added"], walks=11
            )
        print(
            json.dumps({"id": slug, "bytes": len(raw), "sha256": digest, "r2_verified": True}),
            flush=True,
        )
    registry = ROOT / "apps/api/maps/shared_documents.json"
    staging = registry.with_suffix(".json.tmp")
    staging.write_text(json.dumps({"schema_version": 1, "documents": documents}, indent=2) + "\n")
    staging.replace(registry)
    print("Updated shared-document allowlist; file bytes live in R2.", flush=True)


if __name__ == "__main__":
    main()
