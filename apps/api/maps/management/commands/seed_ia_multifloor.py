"""Seed IA Levels 2–3 from local vector SVGs and wire stair/lift connectors to Level 1.

Usage (repo root, with API env loaded via development settings):

  uv run python apps/api/manage.py seed_ia_multifloor --email yuanerfang0@gmail.com

Reads ignored ``local/test-source/IA-floor-{2,3}-vectorized.svg``. Creates floors on
the same Building as Level 1 target ``a86cda61-…``, uploads underlays, builds a
corridor + POI graph aligned with Level 1 vertical cores, and writes
``FloorConnector`` rows for Stairs A–D / J and north/south lifts.
"""

from __future__ import annotations

import math
import uuid
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from maps.models import (
    Edge,
    Floor,
    FloorConnector,
    MapTarget,
    Node,
    ReferencePhoto,
    Revision,
)
from maps.services.graph import add_edge, add_node
from maps.services.underlay import store_underlay_file
from maps.services.workspace import create_map

LEVEL1_TARGET = uuid.UUID("a86cda61-7b52-43dc-85e1-54a412aba7ef")
ROOT = Path(settings.BASE_DIR).resolve().parents[1]  # apps/api -> repo root
SOURCE = ROOT / "local" / "test-source"

# Shared vertical stable IDs (same shaft across floors).
VERTICAL_STABLE = {
    "stair-a": uuid.UUID("aaaaaaaa-0001-4000-8000-0000000000a1"),
    "stair-b": uuid.UUID("aaaaaaaa-0001-4000-8000-0000000000b1"),
    "stair-c": uuid.UUID("aaaaaaaa-0001-4000-8000-0000000000c1"),
    "stair-d": uuid.UUID("aaaaaaaa-0001-4000-8000-0000000000d1"),
    "stair-j": uuid.UUID("aaaaaaaa-0001-4000-8000-0000000000a5"),
    "lift-south": uuid.UUID("aaaaaaaa-0001-4000-8000-0000000000e2"),
    "lift-north": uuid.UUID("aaaaaaaa-0001-4000-8000-0000000000e3"),
}

# Plan coordinates in Level-1 / Level-2 frame (1536×1024).
L12_VERTICAL = {
    "stair-a": (360.0, 690.0, "Stair A", "stairs"),
    "stair-b": (765.0, 690.0, "Stair B", "stairs"),
    "stair-c": (790.0, 300.0, "Stair C", "stairs"),
    "stair-d": (1252.0, 337.0, "Stair D", "stairs"),
    "stair-j": (798.0, 278.0, "Stair J", "stairs"),
    "lift-south": (780.0, 650.0, "South lift", "lift"),
    "lift-north": (760.0, 300.0, "North lift", "lift"),
}


def _scale_to_frame(x: float, y: float, width: float, height: float) -> tuple[float, float]:
    """Map L1/L2 1536×1024 coordinates into another floor frame."""
    return round(x * width / 1536.0, 3), round(y * height / 1024.0, 3)


def _floor_graph(floor_code: str, width: float, height: float) -> list[dict]:
    """Return node specs {key,label,kind,x,y,stable?} and undirected edge key pairs."""

    def p(x: float, y: float) -> tuple[float, float]:
        return _scale_to_frame(x, y, width, height)

    nodes: list[dict] = []
    for code, (x, y, label, kind) in L12_VERTICAL.items():
        sx, sy = p(x, y)
        nodes.append(
            {
                "key": code,
                "label": label,
                "kind": kind,
                "x": sx,
                "y": sy,
                "stable_id": VERTICAL_STABLE[code],
            }
        )

    # Corridor spine + room approaches (Level 2 / 3 named spaces from source plans).
    if floor_code == "2":
        extras = [
            ("nw-hall", "NW hall", "junction", 520, 300),
            ("n-hall", "North hall", "junction", 850, 310),
            ("ne-hall", "NE hall", "junction", 1180, 340),
            ("w-hall", "West hall", "junction", 480, 520),
            ("c-hall", "Central hall", "junction", 820, 520),
            ("e-hall", "East hall", "junction", 1180, 520),
            ("sw-hall", "SW hall", "junction", 480, 680),
            ("s-hall", "South hall", "junction", 780, 680),
            ("se-hall", "SE hall", "junction", 1150, 620),
            ("corner-shop", "The Corner Shop", "checkpoint", 450, 250),
            ("the-spot", "The Spot", "checkpoint", 700, 250),
            ("mission-control", "Mission Control", "checkpoint", 950, 250),
            ("the-portal", "The Portal", "checkpoint", 1150, 260),
            ("living-room", "The Living Room", "checkpoint", 1320, 300),
            ("the-cloud", "The Cloud", "checkpoint", 420, 620),
            ("the-keystone", "The Keystone", "checkpoint", 650, 480),
            ("the-conveyor", "The Conveyor", "checkpoint", 1300, 520),
            ("the-stage", "The Stage", "checkpoint", 550, 750),
            ("boundary", "Boundary", "checkpoint", 900, 750),
            ("swivel", "Swivel", "checkpoint", 1150, 750),
        ]
        links = [
            ("stair-a", "sw-hall"),
            ("stair-a", "the-cloud"),
            ("stair-a", "the-stage"),
            ("stair-b", "s-hall"),
            ("stair-b", "lift-south"),
            ("lift-south", "s-hall"),
            ("stair-c", "n-hall"),
            ("stair-c", "lift-north"),
            ("stair-c", "stair-j"),
            ("lift-north", "n-hall"),
            ("stair-j", "n-hall"),
            ("stair-d", "ne-hall"),
            ("stair-d", "living-room"),
            ("nw-hall", "n-hall"),
            ("n-hall", "ne-hall"),
            ("nw-hall", "w-hall"),
            ("n-hall", "c-hall"),
            ("ne-hall", "e-hall"),
            ("w-hall", "c-hall"),
            ("c-hall", "e-hall"),
            ("w-hall", "sw-hall"),
            ("c-hall", "s-hall"),
            ("e-hall", "se-hall"),
            ("sw-hall", "s-hall"),
            ("s-hall", "se-hall"),
            ("nw-hall", "corner-shop"),
            ("n-hall", "the-spot"),
            ("n-hall", "mission-control"),
            ("ne-hall", "the-portal"),
            ("ne-hall", "living-room"),
            ("c-hall", "the-keystone"),
            ("e-hall", "the-conveyor"),
            ("se-hall", "the-conveyor"),
            ("sw-hall", "the-cloud"),
            ("s-hall", "the-stage"),
            ("s-hall", "boundary"),
            ("se-hall", "swivel"),
        ]
    else:
        extras = [
            ("nw-hall", "NW hall", "junction", 520, 280),
            ("n-hall", "North hall", "junction", 850, 290),
            ("ne-hall", "NE hall", "junction", 1180, 320),
            ("w-hall", "West hall", "junction", 500, 480),
            ("c-hall", "Central hall", "junction", 820, 500),
            ("e-hall", "East hall", "junction", 1180, 500),
            ("sw-hall", "SW hall", "junction", 500, 650),
            ("s-hall", "South hall", "junction", 780, 650),
            ("se-hall", "SE hall", "junction", 1150, 600),
            ("the-hive", "The Hive", "checkpoint", 450, 230),
            ("muffler", "Muffler", "checkpoint", 700, 230),
            ("nook-shop", "The Nook Shop", "checkpoint", 1200, 250),
            ("the-conveyor", "The Conveyor", "checkpoint", 1300, 520),
            ("void-n", "Central void north", "junction", 900, 420),
            ("void-s", "Central void south", "junction", 900, 560),
        ]
        links = [
            ("stair-a", "sw-hall"),
            ("stair-b", "s-hall"),
            ("stair-b", "lift-south"),
            ("lift-south", "s-hall"),
            ("stair-c", "n-hall"),
            ("stair-c", "lift-north"),
            ("stair-c", "stair-j"),
            ("lift-north", "n-hall"),
            ("stair-j", "n-hall"),
            ("stair-d", "ne-hall"),
            ("nw-hall", "n-hall"),
            ("n-hall", "ne-hall"),
            ("nw-hall", "w-hall"),
            ("n-hall", "c-hall"),
            ("ne-hall", "e-hall"),
            ("w-hall", "c-hall"),
            ("c-hall", "e-hall"),
            ("w-hall", "sw-hall"),
            ("c-hall", "s-hall"),
            ("e-hall", "se-hall"),
            ("sw-hall", "s-hall"),
            ("s-hall", "se-hall"),
            ("nw-hall", "the-hive"),
            ("n-hall", "muffler"),
            ("ne-hall", "nook-shop"),
            ("e-hall", "the-conveyor"),
            ("se-hall", "the-conveyor"),
            ("c-hall", "void-n"),
            ("c-hall", "void-s"),
            ("void-n", "void-s"),
        ]

    for key, label, kind, x, y in extras:
        sx, sy = p(x, y)
        nodes.append({"key": key, "label": label, "kind": kind, "x": sx, "y": sy})
    return nodes, links


class Command(BaseCommand):
    help = "Seed IA Level 2/3 maps from local vector SVGs and FloorConnector rows."

    def add_arguments(self, parser):
        parser.add_argument("--email", required=True, help="Map author email (draft owner)")
        parser.add_argument(
            "--force",
            action="store_true",
            help="Rebuild draft graph/underlay when the floor already exists",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        user = get_user_model().objects.filter(email__iexact=options["email"]).first()
        if user is None:
            raise CommandError(f"No user with email {options['email']!r}")
        try:
            level1 = MapTarget.objects.select_related("floor__building").get(pk=LEVEL1_TARGET)
        except MapTarget.DoesNotExist as exc:
            raise CommandError("Level 1 target a86cda61-… not found.") from exc
        building = level1.floor.building
        if not building.latitude or not building.longitude:
            building.latitude = building.latitude or "43.788195"
            building.longitude = building.longitude or "-79.190593"
            building.save(update_fields=["latitude", "longitude"])

        results = {}
        for code, svg_name, title in [
            ("2", "IA-floor-2-vectorized.svg", "IA - Level 2"),
            ("3", "IA-floor-3-vectorized.svg", "IA - Level 3"),
        ]:
            svg_path = SOURCE / svg_name
            if not svg_path.is_file():
                raise CommandError(f"Missing {svg_path}")
            target, rebuilt = self._ensure_floor(
                user, building, code=code, name=title, force=options["force"]
            )
            revision = (
                target.contributions.filter(author=user, status="draft").first().head_revision
            )
            if rebuilt:
                self._attach_underlay(revision, user, svg_path)
                width = float(revision.coordinate_frame.get("width") or 1536)
                height = float(revision.coordinate_frame.get("height") or 1024)
                self._rebuild_graph(revision, user, code, width, height)
            results[code] = {
                "target_id": str(target.id),
                "revision_id": str(revision.id),
                "nodes": revision.nodes.count(),
                "edges": revision.edges.count(),
                "frame": revision.coordinate_frame,
            }
            self.stdout.write(self.style.SUCCESS(f"Floor {code}: {results[code]}"))

        connectors = self._wire_connectors(building, level1, results, user)
        self.stdout.write(self.style.SUCCESS(f"FloorConnector rows: {connectors}"))

    def _ensure_floor(
        self, user, building, *, code: str, name: str, force: bool
    ) -> tuple[MapTarget, bool]:
        """Return (target, rebuilt) where rebuilt means underlay/graph should be written."""
        existing = (
            Floor.objects.filter(building=building, code=code).select_related("target").first()
        )
        if existing:
            target = existing.target
            draft = target.contributions.filter(author=user, status="draft").first()
            if draft is None:
                from maps.services.workspace import start_edit

                start_edit(user, target.id)
                draft = target.contributions.filter(author=user, status="draft").first()
            if not force and draft.head_revision.nodes.exists():
                self.stdout.write(f"Floor {code} already seeded; use --force to rebuild.")
                return target, False
            if force:
                rev = draft.head_revision
                Edge.objects.filter(revision=rev).delete()
                ReferencePhoto.objects.filter(revision=rev).delete()
                Node.objects.filter(revision=rev).delete()
            return target, True
        contribution = create_map(
            user,
            {
                "building_id": str(building.id),
                "building_name": building.name,
                "floor_code": code,
                "floor_name": name,
                "latitude": float(building.latitude),
                "longitude": float(building.longitude),
                "address": building.address or "",
            },
        )
        return contribution.target, True

    def _attach_underlay(self, revision: Revision, user, svg_path: Path) -> None:
        raw = svg_path.read_bytes()
        uploaded = SimpleUploadedFile(svg_path.name, raw, content_type="image/svg+xml")
        # Replace any prior underlay by uploading again (append-only Asset ok).
        store_underlay_file(revision, uploaded_file=uploaded, actor=user)
        revision.refresh_from_db()

    def _rebuild_graph(
        self, revision: Revision, user, floor_code: str, width: float, height: float
    ):
        Edge.objects.filter(revision=revision).delete()
        Node.objects.filter(revision=revision).delete()
        nodes, links = _floor_graph(floor_code, width, height)
        created: dict[str, Node] = {}
        for spec in nodes:
            node = add_node(
                revision,
                x=spec["x"],
                y=spec["y"],
                label=spec["label"],
                kind=spec["kind"],
                actor=user,
                lock=True,
            )
            if spec.get("stable_id"):
                Node.objects.filter(pk=node.pk).update(stable_id=spec["stable_id"])
                node.stable_id = spec["stable_id"]
            created[spec["key"]] = node
        for a, b in links:
            if a not in created or b not in created:
                continue
            add_edge(revision, from_id=created[a].pk, to_id=created[b].pk, actor=user)
            add_edge(revision, from_id=created[b].pk, to_id=created[a].pk, actor=user)
        # Mark authoring stage as ready for graph editor.
        geometry = dict(revision.geometry or {})
        authoring = dict(geometry.get("authoring") or {})
        authoring.update(
            {
                "stage": "graph_seeded",
                "seed": "seed_ia_multifloor",
                "source_svg": True,
            }
        )
        geometry["authoring"] = authoring
        Revision.objects.filter(pk=revision.pk).update(geometry=geometry)

    def _wire_connectors(self, building, level1: MapTarget, floors: dict, user) -> int:
        # Resolve Level 1 vertical nodes by label heuristics.
        l1_rev = (
            level1.contributions.filter(author=user, status="draft", head_revision__isnull=False)
            .order_by("-updated_at")
            .first()
        )
        if not l1_rev:
            l1_rev = (
                level1.contributions.filter(head_revision__isnull=False)
                .order_by("-updated_at")
                .first()
            )
        if not l1_rev:
            raise CommandError("Level 1 has no draft revision for connector wiring.")
        rev1 = l1_rev.head_revision
        # Align Level 1 stable_ids to shared VERTICAL_STABLE where labels match.
        label_map = {
            "stair-a": "Stair A",
            "stair-b": "Stair B",
            "stair-c": "Stair C",
            "stair-d": "Stair D",
            "stair-j": "Stair J",
            "lift-south": "South lift",
            "lift-north": "North lift",
        }
        l1_nodes: dict[str, Node] = {}
        for code, needle in label_map.items():
            node = rev1.nodes.filter(label__icontains=needle).order_by("label").first()
            created = False
            if node is None:
                # Level 1 draft may omit a shaft (e.g. Stair B / north lift); place it.
                x, y, label, kind = L12_VERTICAL[code]
                node = add_node(rev1, x=x, y=y, label=label, kind=kind, actor=user, lock=True)
                created = True
                self.stdout.write(f"Level 1: created missing vertical node {label!r}")
            if node:
                Node.objects.filter(pk=node.pk).update(stable_id=VERTICAL_STABLE[code])
                node.stable_id = VERTICAL_STABLE[code]
                # Normalize kinds for C/J/lift when formerly door/junction.
                kind = L12_VERTICAL[code][3]
                if node.kind != kind:
                    Node.objects.filter(pk=node.pk).update(kind=kind)
                    node.kind = kind
                if (
                    created
                    and not node.outgoing_edges.exists()
                    and not node.incoming_edges.exists()
                ):
                    # Link to nearest existing junction/hall so the shaft is reachable.
                    nearest = None
                    best = float("inf")
                    nx, ny = float(node.x), float(node.y)
                    for other in rev1.nodes.exclude(pk=node.pk):
                        dx = float(other.x) - nx
                        dy = float(other.y) - ny
                        dist = math.hypot(dx, dy)
                        if dist < best and dist < 220:
                            best = dist
                            nearest = other
                    if nearest is not None:
                        add_edge(rev1, from_id=node.pk, to_id=nearest.pk, actor=user)
                        add_edge(rev1, from_id=nearest.pk, to_id=node.pk, actor=user)
                l1_nodes[code] = node

        count = 0
        for code, (_, _, label, kind) in L12_VERTICAL.items():
            endpoints = []
            if code in l1_nodes:
                n = l1_nodes[code]
                endpoints.append(
                    {
                        "floor_code": "1",
                        "target_id": str(level1.id),
                        "node_id": str(n.id),
                        "node_stable_id": str(n.stable_id),
                        "label": n.label,
                    }
                )
            for floor_code, info in floors.items():
                rev = Revision.objects.get(pk=info["revision_id"])
                node = rev.nodes.filter(stable_id=VERTICAL_STABLE[code]).first()
                if not node:
                    continue
                endpoints.append(
                    {
                        "floor_code": floor_code,
                        "target_id": info["target_id"],
                        "node_id": str(node.id),
                        "node_stable_id": str(node.stable_id),
                        "label": node.label,
                    }
                )
            if len(endpoints) < 2:
                self.stdout.write(self.style.WARNING(f"Skip connector {code}: need ≥2 floors"))
                continue
            FloorConnector.objects.update_or_create(
                building=building,
                code=code,
                defaults={
                    "kind": kind,
                    "label": label,
                    "endpoints": endpoints,
                },
            )
            count += 1
        return count
