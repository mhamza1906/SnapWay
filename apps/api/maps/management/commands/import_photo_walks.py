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
from maps.services.graph import add_edge, add_node, remove_edge, update_node
from maps.services.underlay import store_underlay_file


class Command(BaseCommand):
    help = "Import numbered photo walks; preserve previously imported drafts and photos."

    def add_arguments(self, parser):
        parser.add_argument("--username", required=True)
        parser.add_argument("--file", required=True)
        parser.add_argument(
            "--upgrade-existing",
            action="store_true",
            help="Expand an earlier source plan, preserving every existing node and photo.",
        )

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
            if not 1 <= walk["points"] <= 30:
                raise CommandError("Each circulation must contain 1–30 photo stops.")
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
            previous = None
            previous_sources = walk.get("previousSources") or [walk.get("previousSource")]
            if options["upgrade_existing"] and any(previous_sources):
                previous = Contribution.objects.filter(
                    author=user,
                    head_revision__geometry__photo_walk_source__in=previous_sources,
                ).first()
            if previous:
                self.expand_walk(user, previous.head_revision_id, walk)
                result.append({"target": str(previous.target_id), "title": previous.target.title})
                continue
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

    def expand_walk(self, user, revision_id, walk):
        """Only add source locations; never move/remove nodes that may have pending photos."""
        revision = Revision.objects.select_for_update().get(pk=revision_id)
        if any(revision.coordinate_frame.get(key) != walk[key] for key in ("width", "height")):
            raise CommandError("Cannot expand a walk into a different source frame.")
        old_nodes = list(revision.nodes.select_for_update())

        def same_position(node, desired):
            return (
                abs(float(node.x) - desired["x"]) < 0.00001
                and abs(float(node.y) - desired["y"]) < 0.00001
            )

        if any(
            not any(same_position(node, desired) for desired in walk["nodes"]) for node in old_nodes
        ):
            raise CommandError("Expanded source must retain every existing node location.")
        nodes = []
        for desired in walk["nodes"]:
            existing = next((node for node in old_nodes if same_position(node, desired)), None)
            if existing:
                node = update_node(
                    revision, node_id=existing.id, label=desired["label"], actor=user
                )
            else:
                node = add_node(
                    revision,
                    actor=user,
                    x=desired["x"],
                    y=desired["y"],
                    label=desired["label"],
                    kind=desired["kind"],
                )
            nodes.append(node)
        if (
            len({node.id for node in nodes}) != len(nodes)
            or sum(node.label.startswith("Point ") for node in nodes) != walk["points"]
        ):
            raise CommandError(
                "Expanded photo stops must have distinct locations and matching counts."
            )
        wanted = {(nodes[edge["from"]].id, nodes[edge["to"]].id) for edge in walk["edges"]}
        old_edges = {(edge.from_node_id, edge.to_node_id): edge for edge in revision.edges.all()}
        for endpoints, edge in old_edges.items():
            if endpoints not in wanted:
                remove_edge(revision, edge_id=edge.id, actor=user)
        for endpoints in wanted - old_edges.keys():
            add_edge(revision, actor=user, from_id=endpoints[0], to_id=endpoints[1])
        revision.geometry = {
            **revision.geometry,
            "photo_walk_source": walk["source"],
            "photo_walk_previous_source": revision.geometry["photo_walk_source"],
        }
        revision.save(update_fields=["geometry"])
