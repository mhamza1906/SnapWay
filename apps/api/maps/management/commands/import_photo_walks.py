"""Import source-authored photo walks into a contributor's own new drafts."""

import base64
import json
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from maps.models import Contribution, Revision
from maps.services.draft import ensure_demo_draft
from maps.services.graph import add_edge, add_node
from maps.services.underlay import store_underlay_file


class Command(BaseCommand):
    help = "Import numbered photo walks; preserve previously imported drafts and photos."

    def add_arguments(self, parser):
        parser.add_argument("--username", required=True)
        parser.add_argument("--file", required=True)

    @transaction.atomic
    def handle(self, *args, **options):
        try:
            user = get_user_model().objects.get(username=options["username"])
            walks = json.loads(Path(options["file"]).read_text())["walks"]
        except (get_user_model().DoesNotExist, KeyError, ValueError, OSError) as error:
            raise CommandError(
                "Provide an existing username and a valid photo-walk export."
            ) from error
        result = []
        for walk in walks:
            existing = (
                Contribution.objects.filter(
                    author=user, head_revision__geometry__photo_walk_source=walk["source"]
                )
                .select_related("target")
                .first()
            )
            if existing:
                result.append({"target": str(existing.target_id), "title": existing.target.title})
                continue
            if not 1 <= walk["points"] <= 12:
                raise CommandError("Each circulation must contain 1–12 photo stops.")
            draft = ensure_demo_draft(user, force_new=True)
            revision = Revision.objects.select_related("target__floor__building").get(
                pk=draft["revision_id"]
            )
            target = revision.target
            target.title = walk["title"]
            target.save(update_fields=["title"])
            floor = target.floor
            floor.name = walk["floor"]
            floor.save(update_fields=["name"])
            floor.building.name = "Sam Ibrahim Building"
            floor.building.save(update_fields=["name"])
            revision.geometry = {"photo_walk_source": walk["source"], "review": "agent-inspected"}
            revision.coordinate_frame = {
                "origin": "top_left",
                "width": walk["width"],
                "height": walk["height"],
                "units": "plan",
            }
            revision.save(update_fields=["geometry", "coordinate_frame"])
            store_underlay_file(
                revision,
                actor=user,
                uploaded_file=SimpleUploadedFile(
                    "floor-plan.png", base64.b64decode(walk["underlay"], validate=True), "image/png"
                ),
            )
            nodes = [
                add_node(
                    revision,
                    actor=user,
                    x=node["x"],
                    y=node["y"],
                    label=node["label"],
                    kind=node["kind"],
                )
                for node in walk["nodes"]
            ]
            if sum(node.label.startswith("Point ") for node in nodes) != walk["points"]:
                raise CommandError("Numbered photo-stop count does not match the export.")
            for edge in walk["edges"]:
                add_edge(
                    revision, actor=user, from_id=nodes[edge["from"]].id, to_id=nodes[edge["to"]].id
                )
            result.append({"target": str(target.id), "title": target.title})
        self.stdout.write(json.dumps({"walks": result}))
