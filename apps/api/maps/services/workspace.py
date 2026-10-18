"""Server-owned workspace snapshots, submission and publication lifecycle."""

import copy
import hashlib
import json
import math
import uuid
from decimal import Decimal
from xml.sax.saxutils import escape, quoteattr

from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Max, Prefetch
from django.utils import timezone
from django.utils.text import slugify

from maps.models import (
    Asset,
    AuditEvent,
    Building,
    Contribution,
    Edge,
    Floor,
    FloorConnector,
    MapObject,
    MapTarget,
    Membership,
    Node,
    Publication,
    ReferencePhoto,
    Review,
    Revision,
    RevisionArtifact,
    Room,
    SceneRelationship,
)
from maps.services.graph import list_graph
from maps.services.media_store import put_bytes, signed_url


def is_admin(user, target=None):
    if user.is_staff or user.is_superuser:
        return True
    return Membership.objects.filter(
        user=user,
        role=Membership.Role.ADMIN,
        revoked_at__isnull=True,
        **({"target": target} if target else {}),
    ).exists()


def require_admin(user, target=None):
    if not is_admin(user, target):
        raise PermissionDenied("Administrator permission is required for this map.")


def visible_targets(user, admin=False):
    """Maps visible in the developer workspace.

    Peer developers share the full target catalog (no per-user membership filter).
    Administrator-scoped queues still require an admin membership (or staff).
    Draft mutation remains author-locked in graph services.
    """
    rows = MapTarget.objects.select_related("floor__building")
    if not admin:
        return rows
    if user.is_staff or user.is_superuser:
        return rows
    return rows.filter(
        memberships__user=user,
        memberships__revoked_at__isnull=True,
        memberships__role=Membership.Role.ADMIN,
    ).distinct()


def shared_source_revision(target, *, exclude_author=None):
    """Best revision to clone when a developer joins a map without a published base."""
    rows = target.contributions.filter(head_revision__isnull=False).select_related("head_revision")
    if exclude_author is not None:
        rows = rows.exclude(author=exclude_author)
    shared = rows.order_by("-updated_at").first()
    return shared.head_revision if shared else None


def workspace_buildings(user):
    """Developer Explore markers: every visible open floor with building coordinates.

    Yellow markers use buildings that have at least one current publication.
    Red markers are draft-only buildings the caller can already edit.
    Public discovery stays on ``/api/maps/public/buildings/`` (published only).
    """
    targets = (
        visible_targets(user)
        .filter(
            status=MapTarget.Status.OPEN,
            floor__building__latitude__isnull=False,
            floor__building__longitude__isnull=False,
        )
        .select_related("floor__building")
        .prefetch_related(
            Prefetch(
                "publications",
                queryset=Publication.objects.filter(is_current=True, invalidated_at__isnull=True),
                to_attr="current_pubs",
            )
        )
        .order_by("floor__building__name", "floor__sort_order", "id")
    )
    buildings: dict[str, dict] = {}
    for target in targets:
        floor = target.floor
        building = floor.building
        publication = (getattr(target, "current_pubs", None) or [None])[0]
        entry = buildings.setdefault(
            str(building.id),
            {
                "id": str(building.id),
                "name": building.name,
                "place_id": building.google_place_id,
                "address": building.address,
                "latitude": float(building.latitude),
                "longitude": float(building.longitude),
                "published": False,
                "floors": [],
            },
        )
        if publication:
            entry["published"] = True
        entry["floors"].append(
            {
                "target_id": str(target.id),
                "name": floor.name,
                "code": floor.code,
                "publication_id": str(publication.id) if publication else None,
                "sequence": publication.sequence if publication else 0,
                "published": publication is not None,
            }
        )
    return list(buildings.values())


def building_connectors(user, building_id):
    """Stair/lift correspondence across floors of one building (cross-floor routing).

    Caller must already see at least one open floor of the building.
    """
    building = Building.objects.get(pk=building_id)
    visible = visible_targets(user).filter(status=MapTarget.Status.OPEN, floor__building=building)
    if not visible.exists():
        raise PermissionError("This building is not available in your workspace.")
    rows = FloorConnector.objects.filter(building=building).order_by("kind", "code")
    return [
        {
            "id": str(row.id),
            "code": row.code,
            "kind": row.kind,
            "label": row.label,
            "endpoints": row.endpoints,
        }
        for row in rows
    ]


def current_publication(target):
    cached = getattr(target, "current_pubs", None)
    if cached is not None:
        return cached[0] if cached else None
    return target.publications.filter(is_current=True, invalidated_at__isnull=True).first()


def revision_payload(revision):
    if not revision:
        return None
    payload = list_graph(revision)
    artifact = revision.artifacts.filter(kind="svg", state="ready").select_related("asset").first()
    payload.update(
        {
            "geometry": revision.geometry,
            "vector_url": signed_url(artifact.asset.storage_key) if artifact else None,
            "created_at": revision.created_at,
            "frozen": revision.frozen_at is not None,
            "rooms": list(
                revision.rooms.values("id", "number", "name", "purpose", "attributes", "provenance")
            ),
            "reference_photos": list(
                revision.references.values(
                    "id",
                    "stable_id",
                    "asset_id",
                    "node_id",
                    "heading_degrees",
                    "scene_description",
                    "capture_context",
                    "analysis_provenance",
                )
            ),
        }
    )
    return payload


def plan_display_asset(revision):
    """Pick the card/underlay asset: vectorized SVG first, then Image 2.5 SoT.

    Raw user uploads are never preferred once an optimized raster exists. Returns
    ``(asset, kind)`` where kind is ``vector`` | ``optimize`` | ``None``.
    """
    if not revision:
        return None, None
    artifact = revision.artifacts.filter(kind="svg", state="ready").select_related("asset").first()
    if artifact and artifact.asset_id:
        return artifact.asset, "vector"
    source = revision.source_asset
    if source and source.content_type == "image/svg+xml":
        return source, "vector"
    optimized = revision.standardized_asset
    if optimized is not None:
        return optimized, "optimize"
    # After Image 2.5, source_asset is the optimized SoT (often still kind=standardized).
    if source and source.kind == Asset.Kind.STANDARDIZED:
        return source, "optimize"
    if source and source.content_type != "image/svg+xml":
        # Legacy raw photo only when nothing else exists (pre-optimize drafts).
        return source, "source"
    return None, None


def card(target, contribution=None, *, include_preview=True, shared_revision=None):
    """Serialize a map card.

    Preview preference: vectorized SVG, then Image 2.5 optimized raster. List
    endpoints may still omit preview URLs for bandwidth; sorting uses preview_kind.
    ``shared_revision`` surfaces another developer's SoT when the caller has no
    draft and the floor is not yet published.
    """
    publication = current_publication(target)
    if not publication and target.status == "archived":
        publication = target.publications.order_by("-sequence").first()
    revision = (
        contribution.head_revision
        if contribution
        else (publication.revision if publication else shared_revision)
    )
    floor = target.floor
    display, preview_kind = plan_display_asset(revision)
    preview = signed_url(display.storage_key) if include_preview and display else None
    authoring = {}
    if revision and isinstance(revision.geometry, dict):
        authoring = dict(revision.geometry.get("authoring") or {})
    stage = str(authoring.get("stage") or "")
    if not stage and preview_kind == "vector":
        stage = "vectorized"
    # Image 2.5 / demo-vector review stays off the graph editor until that step finishes.
    edit_path = (
        "/map-optimize" if stage in {"image_optimize", "vectorized_demo"} else "/graph-editor"
    )
    return {
        "id": str(contribution.id if contribution else target.id),
        "target_id": str(target.id),
        "contribution_id": str(contribution.id) if contribution else None,
        "revision_id": str(revision.id) if revision else None,
        "title": target.title,
        "building": floor.building.name,
        "floor": floor.name,
        "floor_code": floor.code,
        "status": "archived"
        if target.status == "archived"
        else (contribution.status if contribution else "published"),
        "kind": "update" if contribution and contribution.base_revision_id else "new_map",
        "author": contribution.author.get_username() if contribution else "",
        "updated_at": contribution.updated_at if contribution else target.updated_at,
        "sequence": publication.sequence if publication else None,
        "preview_url": preview,
        "preview_kind": preview_kind,
        "authoring_stage": stage or None,
        "edit_path": edit_path,
        "can_admin": False,
    }


def _clone_rows(model, source, destination, **relations):
    mapping = {}
    for old in model.objects.filter(revision=source):
        old_id = old.pk
        old.pk = uuid.uuid4()
        old.revision = destination
        for field, ids in relations.items():
            setattr(old, field, ids.get(getattr(old, field)))
        old.save(force_insert=True)
        mapping[old_id] = old.pk
    return mapping


def clone_revision(source, contribution, user):
    revision = Revision.objects.create(
        target=contribution.target,
        contribution=contribution,
        created_by=user,
        # Only published ancestry survives the pending-work destruction policy.
        # An unpublished proposal is fully copied, without retaining a foreign
        # key that could pin a discarded submission after its successor publishes.
        parent=source
        if source and source.target.publications.filter(revision=source).exists()
        else None,
        geometry=copy.deepcopy(source.geometry) if source else {},
        coordinate_frame=copy.deepcopy(source.coordinate_frame)
        if source
        else {
            "origin": "top_left",
            "width": 1000,
            "height": 640,
            "units": "plan",
        },
        source_asset=source.source_asset if source else None,
        standardized_asset=source.standardized_asset if source else None,
        north_degrees=source.north_degrees if source else None,
        metres_per_unit=source.metres_per_unit if source else None,
    )
    if source:
        objects = _clone_rows(MapObject, source, revision)
        rooms = _clone_rows(Room, source, revision, map_object_id=objects)
        nodes = _clone_rows(Node, source, revision, room_id=rooms, map_object_id=objects)
        _clone_rows(Edge, source, revision, from_node_id=nodes, to_node_id=nodes)
        photos = _clone_rows(ReferencePhoto, source, revision, node_id=nodes)
        _clone_rows(
            SceneRelationship,
            source,
            revision,
            reference_id=photos,
            room_id=rooms,
            node_id=nodes,
        )
    contribution.head_revision = revision
    contribution.save(update_fields=["head_revision", "updated_at"])
    return revision


@transaction.atomic
def start_edit(user, target_id):
    target = MapTarget.objects.select_for_update().get(pk=target_id)
    if target.status != "open":
        raise ValidationError("Archived maps cannot be edited.")
    published = current_publication(target)
    member = Membership.objects.filter(target=target, user=user).first()
    if member and member.revoked_at:
        raise PermissionDenied("Your access to this map has been revoked.")
    if not member:
        # Developers share the catalog; joining an open floor auto-grants volunteer.
        Membership.objects.create(target=target, user=user, role="volunteer", granted_by=user)
    contribution = target.contributions.filter(author=user, status="draft").first()
    if contribution is None:
        source = published.revision if published else None
        previous = (
            target.contributions.filter(
                author=user,
                status="changes_requested",
            )
            .select_related("head_revision")
            .order_by("-updated_at")
            .first()
        )
        if previous:
            source = previous.head_revision
        elif not source:
            previous = (
                target.contributions.filter(author=user, head_revision__isnull=False)
                .order_by("-updated_at")
                .first()
            )
            if previous:
                source = previous.head_revision
            else:
                # Unpublished shared SoT (e.g. Image 2.5 / vectorize) from a peer.
                source = shared_source_revision(target, exclude_author=user)
        contribution = Contribution.objects.create(
            target=target,
            author=user,
            title=target.title,
            base_revision=published.revision if published else None,
        )
        clone_revision(source, contribution, user)
    return contribution


@transaction.atomic
def create_map(user, data):
    name = str(data.get("building_name", "")).strip()
    code = str(data.get("floor_code", "")).strip()
    if not name or len(name) > 200 or not code or len(code) > 50:
        raise ValidationError("A building name and floor code are required (200 / 50 characters).")
    place_id = str(data.get("place_id") or "")[:300] or None
    created = False
    if data.get("building_id"):
        building = Building.objects.select_for_update().get(pk=data["building_id"])
    elif place_id:
        building, created = Building.objects.get_or_create(
            google_place_id=place_id,
            defaults={
                "name": name,
                "slug": f"{slugify(name)[:150]}-{uuid.uuid4().hex[:10]}",
                "created_by": user,
            },
        )
        building = Building.objects.select_for_update().get(pk=building.pk)
    else:
        created = True
        building = Building.objects.create(
            name=name,
            slug=f"{slugify(name)[:150]}-{uuid.uuid4().hex[:10]}",
            created_by=user,
        )
    if created and data.get("latitude") is not None and data.get("longitude") is not None:
        building.latitude = Decimal(str(data["latitude"])).quantize(Decimal("0.000001"))
        building.longitude = Decimal(str(data["longitude"])).quantize(Decimal("0.000001"))
    if created:
        building.address = str(data.get("address") or "")[:1000]
    building.full_clean()
    building.save()
    if Floor.objects.filter(building=building, code=code).exists():
        raise ValidationError("This floor already exists. Open its map to request an update.")
    floor = Floor.objects.create(
        building=building,
        code=code,
        name=str(data.get("floor_name") or code)[:200],
        sort_order=int(code) if code.lstrip("-").isdigit() and len(code) < 6 else 0,
    )
    target = MapTarget.objects.create(
        floor=floor,
        title=f"{building.name} · {floor.name}"[:200],
        created_by=user,
    )
    Membership.objects.create(
        target=target,
        user=user,
        role="admin" if is_admin(user) else "volunteer",
        granted_by=user,
    )
    contribution = Contribution.objects.create(target=target, author=user, title=target.title)
    clone_revision(None, contribution, user)
    AuditEvent.objects.create(target=target, actor=user, action="map.created")
    return contribution


def editable(user, contribution):
    if contribution.author_id != user.pk:
        raise PermissionDenied("Only the author may modify this editing snapshot.")
    if contribution.target.status != "open" or contribution.status != "draft":
        raise ValidationError("This editing snapshot has ended. Open a new edit from My maps.")


def render_svg(revision):
    graph = list_graph(revision)
    frame = graph["coordinate_frame"]
    width, height = float(frame.get("width", 1000)), float(frame.get("height", 640))
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}">']
    # A display export contains the supplied floor plan plus the actual vector graph.
    # It does not claim to trace a raster underlay into wall geometry.
    if revision.source_asset_id:
        import base64

        from django.core.files.storage import default_storage

        asset = revision.source_asset
        with default_storage.open(asset.storage_key, "rb") as blob:
            encoded = base64.b64encode(blob.read()).decode()
        href = f"data:{asset.content_type};base64,{encoded}"
        parts.append(f'<image width="{width}" height="{height}" href={quoteattr(href)}/>')
    nodes = {row["id"]: row for row in graph["nodes"]}
    for edge in graph["edges"]:
        a, b = nodes[edge["from_node_id"]], nodes[edge["to_node_id"]]
        parts.append(
            f'<path d="M{a["x"]},{a["y"]} L{b["x"]},{b["y"]}" '
            'stroke="#087eb8" stroke-width="3" fill="none"/>'
        )
    for node in nodes.values():
        parts.append(f'<circle cx="{node["x"]}" cy="{node["y"]}" r="5" fill="#087eb8"/>')
        parts.append(
            f'<text x="{node["x"] + 8}" y="{node["y"] - 8}" '
            f'font-size="13">{escape(node["label"])}</text>'
        )
    return "".join(parts) + "</svg>"


def digest_revision(revision):
    payload = {}
    for model in [MapObject, Room, Node, Edge, ReferencePhoto, SceneRelationship]:
        payload[model._meta.model_name] = list(
            model.objects.filter(revision=revision).order_by("id").values()
        )
    payload.update(
        {
            "geometry": revision.geometry,
            "frame": revision.coordinate_frame,
            "source": str(revision.source_asset_id),
            "standardized": str(revision.standardized_asset_id),
            "north": revision.north_degrees,
            "scale": revision.metres_per_unit,
        }
    )
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def publish(user, contribution):
    target = contribution.target
    require_admin(user, target)
    revision = contribution.head_revision
    approval = Review.objects.create(revision=revision, reviewer=user, decision="approved")
    sequence = (target.publications.aggregate(n=Max("sequence"))["n"] or 0) + 1
    target.publications.filter(is_current=True).update(is_current=False)
    Publication.objects.create(
        target=target,
        revision=revision,
        approval=approval,
        published_by=user,
        sequence=sequence,
        is_current=True,
    )
    contribution.status = "merged"
    contribution.save(update_fields=["status", "updated_at"])
    target.save(update_fields=["updated_at"])
    AuditEvent.objects.create(
        target=target,
        actor=user,
        revision=revision,
        action="map.published",
        details={"sequence": sequence, "policy": "last_approved_wins"},
    )


@transaction.atomic
def submit(user, contribution_id):
    hint = Contribution.objects.get(pk=contribution_id)
    target = MapTarget.objects.select_for_update().get(pk=hint.target_id)
    contribution = (
        Contribution.objects.select_for_update(of=("self",))
        .select_related("head_revision")
        .get(pk=hint.pk)
    )
    contribution.target = target
    editable(user, contribution)
    revision = Revision.objects.select_for_update().get(pk=contribution.head_revision_id)
    if not revision.nodes.exists() or not revision.source_asset_id:
        raise ValidationError("Add a floor-plan image and at least one waypoint before submitting.")
    raw = render_svg(revision).encode()
    key = f"publications/{target.id}/{uuid.uuid4().hex}.svg"
    put_bytes(key, raw, "image/svg+xml")
    asset = Asset.objects.create(
        target=target,
        uploaded_by=user,
        kind="svg",
        storage_key=key,
        content_type="image/svg+xml",
        sha256=hashlib.sha256(raw).hexdigest(),
        byte_size=len(raw),
    )
    revision.content_hash = digest_revision(revision)
    revision.frozen_at = timezone.now()
    revision.save(update_fields=["content_hash", "frozen_at"])
    RevisionArtifact.objects.create(
        revision=revision,
        kind="svg",
        state="ready",
        asset=asset,
        input_content_hash=revision.content_hash,
        required=True,
    )
    contribution.status, contribution.submitted_at = "submitted", timezone.now()
    contribution.save(update_fields=["status", "submitted_at", "updated_at"])
    contribution.head_revision = revision
    AuditEvent.objects.create(target=target, actor=user, revision=revision, action="map.submitted")
    if is_admin(user, target):
        publish(user, contribution)
    return contribution


@transaction.atomic
def review(user, contribution_id, decision, feedback=""):
    hint = Contribution.objects.get(pk=contribution_id)
    target = MapTarget.objects.select_for_update().get(pk=hint.target_id)
    require_admin(user, target)
    contribution = (
        Contribution.objects.select_for_update(of=("self",))
        .select_related("head_revision")
        .get(pk=hint.pk)
    )
    contribution.target = target
    if target.status != "open" or contribution.status != "submitted":
        raise ValidationError("This submission is no longer awaiting review.")
    if decision == "approved":
        publish(user, contribution)
    elif decision in {"rejected", "changes_requested"} and str(feedback).strip():
        Review.objects.create(
            revision=contribution.head_revision,
            reviewer=user,
            decision=decision,
            feedback=str(feedback)[:4000],
        )
        contribution.status = decision
        contribution.save(update_fields=["status", "updated_at"])
        AuditEvent.objects.create(
            target=target, actor=user, revision=contribution.head_revision, action=f"map.{decision}"
        )
    else:
        raise ValidationError("Choose a valid decision and provide feedback when declining.")
    return contribution


@transaction.atomic
def import_pipeline(user, contribution_id, data):
    """Import one selected pipeline floor into the author's pinned draft, never publish it."""
    hint = Contribution.objects.get(pk=contribution_id)
    target = MapTarget.objects.select_for_update().get(pk=hint.target_id)
    contribution = Contribution.objects.select_for_update().get(pk=hint.pk)
    contribution.target = target
    editable(user, contribution)
    revision = Revision.objects.select_for_update().get(pk=contribution.head_revision_id)
    building, floor_id = data.get("building", {}), data.get("floor_id")
    floor = next((f for f in building.get("floors", []) if f.get("id") == floor_id), None)
    if not floor:
        raise ValidationError("Select a valid pipeline floor.")
    width, height = float(floor.get("width", 0)), float(floor.get("height", 0))
    if not all(math.isfinite(v) and 0 < v <= 100000 for v in [width, height]):
        raise ValidationError("Invalid pipeline coordinate frame.")
    if revision.nodes.exists():
        raise ValidationError("Import into an empty draft to avoid replacing manual edits.")
    from django.core.files.uploadedfile import SimpleUploadedFile

    from maps.services.underlay import store_underlay_file

    svg = str(data.get("svg", ""))
    store_underlay_file(
        revision,
        uploaded_file=SimpleUploadedFile(
            "pipeline.svg", svg.encode(), content_type="image/svg+xml"
        ),
        actor=user,
    )
    revision.coordinate_frame = {
        "origin": "top_left",
        "width": width,
        "height": height,
        "units": "plan",
    }
    revision.geometry = {"pipeline_floor": floor.get("geometry", {}), "pipeline_floor_id": floor_id}
    revision.save(update_fields=["coordinate_frame", "geometry"])
    nodes = {}
    spaces = floor.get("geometry", {}).get("spaces", [])
    if len(spaces) > 500:
        raise ValidationError("Pipeline room count exceeds the import limit.")
    rooms = {}
    for space in spaces:
        if space.get("kind") in {"corridor", "lobby"}:
            continue
        obj = MapObject.objects.create(revision=revision, kind=str(space.get("kind", "room"))[:30])
        rooms[space["id"]] = Room.objects.create(
            revision=revision,
            map_object=obj,
            name=str(space.get("label", ""))[:200],
            number=str(space.get("label", ""))[:80],
            attributes={"pipeline_space_id": space["id"], "kind": space.get("kind")},
            provenance={"source": "pipeline", "confidence": space.get("confidence")},
        )
    assigned_rooms = set()
    selected = [n for n in building.get("nodes", []) if n.get("floorId") == floor_id]
    if len(selected) > 5000 or len(building.get("edges", [])) > 20000:
        raise ValidationError("Pipeline graph exceeds the import limit.")
    for row in selected:
        point = row.get("position", {})
        x, y = float(point.get("x", -1)), float(point.get("y", -1))
        if not all(math.isfinite(v) for v in [x, y]) or not (0 <= x <= width and 0 <= y <= height):
            raise ValidationError("Pipeline waypoint is outside the coordinate frame.")
        kind = {
            "entrance": "entrance",
            "doorway": "door",
            "stair": "stairs",
            "elevator": "lift",
        }.get(row.get("type"), "checkpoint")
        room = next((rooms[sid] for sid in row.get("spaceIds", []) if sid in rooms), None)
        if row.get("type") == "destination" and room and room.pk not in assigned_rooms:
            kind = "room"
            assigned_rooms.add(room.pk)
        nodes[row["id"]] = Node.objects.create(
            revision=revision,
            x=x,
            y=y,
            label=str(row.get("label", ""))[:200],
            kind=kind,
            room=room,
            map_object=room.map_object if room else None,
        )
    for row in building.get("edges", []):
        if row.get("from") not in nodes or row.get("to") not in nodes:
            continue
        a, b = nodes[row["from"]], nodes[row["to"]]
        if a == b:
            continue
        cost = float(row.get("length", 0))
        if not math.isfinite(cost) or cost < 0:
            raise ValidationError("Pipeline edge costs must be finite and nonnegative.")
        for start, end in [(a, b)] + ([(b, a)] if row.get("direction") == "both" else []):
            Edge.objects.get_or_create(
                revision=revision,
                from_node=start,
                to_node=end,
                defaults={
                    "cost": cost,
                    "restrictions": {
                        "accessible": row.get("accessible", "unknown"),
                        "restricted": bool(row.get("restricted")),
                    },
                    "provenance": {"source": "pipeline", "path": row.get("path", [])},
                },
            )
    contribution.save(update_fields=["updated_at"])
    target.save(update_fields=["updated_at"])
    return contribution
