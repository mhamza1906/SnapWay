"""Export only the chosen contributor's upload-direction snapshot for the point PDF."""

import argparse
import json
import os
import re
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", required=True)
    parser.add_argument("--walks", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "apps/api"))
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.development")
    import django

    django.setup()
    from django.db import connection, transaction
    from maps.models import Contribution

    if connection.vendor == "sqlite":
        with connection.cursor() as cursor:
            cursor.execute("PRAGMA query_only=ON")
    elif connection.vendor == "postgresql":
        with connection.cursor() as cursor:
            cursor.execute("SET default_transaction_read_only=on")
    else:
        raise RuntimeError("Read-only snapshot is not configured for this database.")
    sources = {walk["source"] for walk in json.loads(args.walks.read_text())["walks"]}
    progress = {}
    with transaction.atomic():
        for contribution in Contribution.objects.filter(
            author__username=args.username,
            head_revision__geometry__photo_walk_source__in=sources,
        ).select_related("head_revision"):
            revision = contribution.head_revision
            labels = dict(revision.nodes.values_list("id", "label"))
            directions = {}
            for photo in revision.references.all():
                match = re.fullmatch(r"Point (\d+)", labels.get(photo.node_id, ""))
                direction = photo.capture_context.get("direction")
                if match and direction in ("front", "right", "back", "left"):
                    directions.setdefault(match[1], set()).add(direction)
            progress[revision.geometry["photo_walk_source"]] = {
                key: sorted(value) for key, value in directions.items()
            }
    if progress.keys() != sources:
        raise ValueError("Every planned walk must exist in the chosen contributor's saved drafts.")
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "progress.json").write_text(json.dumps(progress, indent=2))
    print(
        json.dumps(
            {
                "walks": len(progress),
                "uploaded_directions": sum(
                    len(d) for walk in progress.values() for d in walk.values()
                ),
            }
        )
    )


if __name__ == "__main__":
    main()
