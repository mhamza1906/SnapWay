"""Map authoring snapshots and reviewed publication metadata.

Geometry lives only in Revision.geometry; relational objects provide addressable
identities and graph/search/reference associations, not a second wall geometry.
"""

import uuid

from django.conf import settings
from django.core.validators import RegexValidator
from django.db import models
from django.db.models import F, Q


class Record(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True


def enum_check(field, values, name):
    return models.CheckConstraint(condition=Q(**{f"{field}__in": values}), name=name)


def scope_key(scope, name):
    """Candidate key for PostgreSQL composite foreign keys in the integrity migration."""
    return models.UniqueConstraint(fields=["id", scope], name=name)


class Building(Record):
    name = models.CharField(max_length=200)
    slug = models.SlugField(max_length=200, unique=True)
    address = models.TextField(blank=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(Q(latitude__isnull=True, longitude__isnull=True))
                | Q(
                    latitude__isnull=False,
                    longitude__isnull=False,
                    latitude__range=(-90, 90),
                    longitude__range=(-180, 180),
                ),
                name="building_coordinate_pair",
            ),
        ]


class Floor(Record):
    building = models.ForeignKey(Building, on_delete=models.PROTECT, related_name="floors")
    code = models.CharField(max_length=50)
    name = models.CharField(max_length=200)
    sort_order = models.IntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["building", "code"], name="floor_code_uq")]


class MapTarget(Record):
    class Status(models.TextChoices):
        OPEN = "open", "Open"
        ARCHIVED = "archived", "Archived"

    floor = models.OneToOneField(Floor, on_delete=models.PROTECT, related_name="target")
    title = models.CharField(max_length=200)
    instructions = models.TextField(blank=True)
    status = models.CharField(max_length=12, choices=Status, default=Status.OPEN)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            enum_check("status", ["open", "archived"], "target_status_ck"),
            models.CheckConstraint(
                condition=Q(status="open", archived_at__isnull=True)
                | Q(status="archived", archived_at__isnull=False),
                name="target_archive_time_ck",
            ),
        ]


class Membership(Record):
    class Role(models.TextChoices):
        ADMIN = "admin", "Administrator"
        VOLUNTEER = "volunteer", "Volunteer"

    target = models.ForeignKey(MapTarget, on_delete=models.PROTECT, related_name="memberships")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    role = models.CharField(max_length=12, choices=Role)
    granted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="granted_map_memberships"
    )
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["target", "user"], name="membership_user_uq"),
            enum_check("role", ["admin", "volunteer"], "membership_role_ck"),
        ]


class Contribution(Record):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        SUBMITTED = "submitted", "Submitted"
        CHANGES_REQUESTED = "changes_requested", "Changes requested"
        REJECTED = "rejected", "Rejected"
        MERGED = "merged", "Merged"

    target = models.ForeignKey(MapTarget, on_delete=models.PROTECT, related_name="contributions")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    title = models.CharField(max_length=200)
    status = models.CharField(max_length=20, choices=Status, default=Status.DRAFT)
    base_revision = models.ForeignKey(
        "Revision",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="based_contributions",
    )
    head_revision = models.ForeignKey(
        "Revision",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="headed_contributions",
    )
    # Optimistic token for save/apply operations; increment using a conditional UPDATE.
    lock_version = models.PositiveIntegerField(default=0)
    submitted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            scope_key("target", "contribution_target_key"),
            enum_check(
                "status",
                ["draft", "submitted", "changes_requested", "rejected", "merged"],
                "contribution_status_ck",
            ),
        ]
        indexes = [
            models.Index(fields=["target", "status", "created_at"], name="contribution_inbox_idx")
        ]


class Asset(Record):
    class Kind(models.TextChoices):
        SOURCE = "source", "Source floor plan"
        CORRECTED = "corrected", "Corrected floor plan"
        STANDARDIZED = "standardized", "Standardized bitmap"
        PHOTO = "photo", "Reference photo"
        SVG = "svg", "Rendered vector map"
        SEMANTIC = "semantic", "Semantic data"
        INDEX = "index", "Retrieval index"
        CAPTURE = "capture", "Visitor capture"

    target = models.ForeignKey(MapTarget, on_delete=models.PROTECT, related_name="assets")
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT
    )
    kind = models.CharField(max_length=16, choices=Kind)
    # Adapter-relative private key; never a signed URL, credential, or image blob.
    storage_key = models.CharField(max_length=500, unique=True)
    content_type = models.CharField(max_length=100)
    sha256 = models.CharField(max_length=64, validators=[RegexValidator(r"^[0-9a-f]{64}$")])
    byte_size = models.PositiveBigIntegerField()
    width = models.PositiveIntegerField(null=True, blank=True)
    height = models.PositiveIntegerField(null=True, blank=True)
    source_asset = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT)
    provenance = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            scope_key("target", "asset_target_key"),
            enum_check(
                "kind",
                [
                    "source",
                    "corrected",
                    "standardized",
                    "photo",
                    "svg",
                    "semantic",
                    "index",
                    "capture",
                ],
                "asset_kind_ck",
            ),
            models.CheckConstraint(
                condition=Q(width__isnull=True, height__isnull=True)
                | Q(width__isnull=False, height__isnull=False, width__gt=0, height__gt=0),
                name="asset_dimensions_ck",
            ),
            models.CheckConstraint(condition=Q(byte_size__gt=0), name="asset_size_ck"),
            models.CheckConstraint(condition=~Q(id=F("source_asset")), name="asset_not_own_source"),
        ]


class Revision(Record):
    target = models.ForeignKey(MapTarget, on_delete=models.PROTECT, related_name="revisions")
    contribution = models.ForeignKey(
        Contribution, on_delete=models.PROTECT, related_name="revisions"
    )
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    schema_version = models.PositiveIntegerField(default=1)
    geometry = models.JSONField(default=dict)
    # Explicit local frame: image/top-left coordinates are never assumed to be north/metres.
    coordinate_frame = models.JSONField(default=dict)
    north_degrees = models.DecimalField(max_digits=6, decimal_places=3, null=True, blank=True)
    metres_per_unit = models.DecimalField(max_digits=16, decimal_places=9, null=True, blank=True)
    source_asset = models.ForeignKey(
        Asset, on_delete=models.PROTECT, related_name="source_revisions", null=True, blank=True
    )
    standardized_asset = models.ForeignKey(
        Asset,
        on_delete=models.PROTECT,
        related_name="standardized_revisions",
        null=True,
        blank=True,
    )
    # Digest covers geometry, records, graph, references and source/profile identities.
    content_hash = models.CharField(max_length=64, blank=True)
    frozen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            scope_key("target", "revision_target_key"),
            scope_key("contribution", "revision_contribution_key"),
            models.CheckConstraint(condition=Q(schema_version__gt=0), name="revision_schema_ck"),
            models.CheckConstraint(condition=~Q(id=F("parent")), name="revision_not_own_parent"),
            models.CheckConstraint(
                condition=Q(north_degrees__isnull=True)
                | Q(north_degrees__gte=0, north_degrees__lt=360),
                name="revision_north_ck",
            ),
            models.CheckConstraint(
                condition=Q(metres_per_unit__isnull=True) | Q(metres_per_unit__gt=0),
                name="revision_scale_ck",
            ),
            models.CheckConstraint(
                condition=Q(frozen_at__isnull=True) | ~Q(content_hash=""),
                name="revision_frozen_hash_ck",
            ),
        ]


class MapObject(Record):
    revision = models.ForeignKey(Revision, on_delete=models.PROTECT, related_name="map_objects")
    # Copied unchanged between snapshots for the same logical geometry object.
    stable_id = models.UUIDField(default=uuid.uuid4)
    kind = models.CharField(max_length=30)

    class Meta:
        constraints = [
            scope_key("revision", "object_revision_key"),
            models.UniqueConstraint(fields=["revision", "stable_id"], name="object_stable_id_uq"),
        ]


class Room(Record):
    revision = models.ForeignKey(Revision, on_delete=models.PROTECT, related_name="rooms")
    map_object = models.OneToOneField(MapObject, on_delete=models.PROTECT, related_name="room")
    number = models.CharField(max_length=80, blank=True)
    name = models.CharField(max_length=200, blank=True)
    purpose = models.TextField(blank=True)
    attributes = models.JSONField(default=dict, blank=True)
    provenance = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [scope_key("revision", "room_revision_key")]
        indexes = [models.Index(fields=["revision", "number"], name="room_search_idx")]


class Node(Record):
    class Kind(models.TextChoices):
        ROOM = "room", "Room destination"
        DOOR = "door", "Door"
        JUNCTION = "junction", "Corridor junction"
        ENTRANCE = "entrance", "Building entrance"
        STAIRS = "stairs", "Stairs"
        LIFT = "lift", "Lift"
        CHECKPOINT = "checkpoint", "Checkpoint"

    revision = models.ForeignKey(Revision, on_delete=models.PROTECT, related_name="nodes")
    stable_id = models.UUIDField(default=uuid.uuid4)
    kind = models.CharField(max_length=16, choices=Kind)
    room = models.ForeignKey(Room, null=True, blank=True, on_delete=models.PROTECT)
    map_object = models.ForeignKey(MapObject, null=True, blank=True, on_delete=models.PROTECT)
    # Graph position in Revision.coordinate_frame, independent of wall geometry.
    x = models.DecimalField(max_digits=16, decimal_places=6)
    y = models.DecimalField(max_digits=16, decimal_places=6)
    label = models.CharField(max_length=200, blank=True)

    class Meta:
        constraints = [
            scope_key("revision", "node_revision_key"),
            models.UniqueConstraint(fields=["revision", "stable_id"], name="node_stable_id_uq"),
            models.UniqueConstraint(
                fields=["revision", "room"],
                condition=Q(kind="room"),
                name="node_room_destination_uq",
            ),
            enum_check(
                "kind",
                ["room", "door", "junction", "entrance", "stairs", "lift", "checkpoint"],
                "node_kind_ck",
            ),
            models.CheckConstraint(
                condition=~Q(kind="room") | Q(room__isnull=False), name="node_room_required_ck"
            ),
        ]


class Edge(Record):
    revision = models.ForeignKey(Revision, on_delete=models.PROTECT, related_name="edges")
    stable_id = models.UUIDField(default=uuid.uuid4)
    from_node = models.ForeignKey(Node, on_delete=models.PROTECT, related_name="outgoing_edges")
    to_node = models.ForeignKey(Node, on_delete=models.PROTECT, related_name="incoming_edges")
    cost = models.DecimalField(max_digits=16, decimal_places=6)
    distance_metres = models.DecimalField(max_digits=12, decimal_places=3, null=True, blank=True)
    is_open = models.BooleanField(default=True)
    is_verified = models.BooleanField(default=False)
    restrictions = models.JSONField(default=dict, blank=True)
    provenance = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            scope_key("revision", "edge_revision_key"),
            models.UniqueConstraint(fields=["revision", "stable_id"], name="edge_stable_id_uq"),
            models.UniqueConstraint(
                fields=["revision", "from_node", "to_node"], name="edge_direction_uq"
            ),
            models.CheckConstraint(condition=Q(cost__gte=0), name="edge_cost_ck"),
            models.CheckConstraint(
                condition=~Q(from_node=F("to_node")), name="edge_no_self_loop_ck"
            ),
            models.CheckConstraint(
                condition=Q(distance_metres__isnull=True) | Q(distance_metres__gte=0),
                name="edge_distance_ck",
            ),
        ]


class ReferencePhoto(Record):
    class Status(models.TextChoices):
        PROPOSED = "proposed", "Proposed"
        REVIEWED = "reviewed", "Reviewed"
        REJECTED = "rejected", "Rejected"

    revision = models.ForeignKey(Revision, on_delete=models.PROTECT, related_name="references")
    stable_id = models.UUIDField(default=uuid.uuid4)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT)
    node = models.ForeignKey(Node, on_delete=models.PROTECT, null=True, blank=True)
    captured_at = models.DateTimeField(null=True, blank=True)
    collection_session = models.CharField(max_length=100, blank=True)
    heading_degrees = models.DecimalField(max_digits=6, decimal_places=3, null=True, blank=True)
    status = models.CharField(max_length=12, choices=Status, default=Status.PROPOSED)
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    capture_context = models.JSONField(default=dict, blank=True)
    scene_description = models.TextField(blank=True)
    analysis_provenance = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            scope_key("revision", "reference_revision_key"),
            models.UniqueConstraint(
                fields=["revision", "stable_id"], name="reference_stable_id_uq"
            ),
            enum_check("status", ["proposed", "reviewed", "rejected"], "reference_status_ck"),
            models.CheckConstraint(
                condition=Q(heading_degrees__isnull=True)
                | Q(heading_degrees__gte=0, heading_degrees__lt=360),
                name="reference_heading_ck",
            ),
            models.CheckConstraint(
                condition=~Q(status="reviewed")
                | Q(node__isnull=False, reviewed_by__isnull=False, reviewed_at__isnull=False),
                name="reference_review_ck",
            ),
        ]


class SceneRelationship(Record):
    revision = models.ForeignKey(Revision, on_delete=models.PROTECT, related_name="relationships")
    reference = models.ForeignKey(
        ReferencePhoto, on_delete=models.PROTECT, related_name="relationships"
    )
    kind = models.CharField(max_length=80)
    # An observed room or sign direction is distinct from ReferencePhoto.node (camera location).
    room = models.ForeignKey(Room, on_delete=models.PROTECT, null=True, blank=True)
    node = models.ForeignKey(Node, on_delete=models.PROTECT, null=True, blank=True)
    evidence = models.JSONField(default=dict)
    status = models.CharField(
        max_length=12, choices=ReferencePhoto.Status, default=ReferencePhoto.Status.PROPOSED
    )
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            enum_check("status", ReferencePhoto.Status.values, "relationship_status_ck"),
            models.CheckConstraint(
                condition=~Q(status="reviewed")
                | Q(reviewed_by__isnull=False, reviewed_at__isnull=False),
                name="relationship_review_ck",
            ),
        ]


class Review(Record):
    class Decision(models.TextChoices):
        APPROVED = "approved", "Approved"
        CHANGES_REQUESTED = "changes_requested", "Changes requested"
        REJECTED = "rejected", "Rejected"

    revision = models.ForeignKey(Revision, on_delete=models.PROTECT, related_name="reviews")
    reviewer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    decision = models.CharField(max_length=20, choices=Decision)
    feedback = models.TextField(blank=True)

    class Meta:
        constraints = [
            scope_key("revision", "review_revision_key"),
            enum_check(
                "decision", ["approved", "changes_requested", "rejected"], "review_decision_ck"
            ),
            models.CheckConstraint(
                condition=Q(decision="approved") | ~Q(feedback=""), name="review_feedback_ck"
            ),
        ]


class RevisionArtifact(Record):
    class State(models.TextChoices):
        PENDING = "pending", "Pending"
        READY = "ready", "Ready"
        FAILED = "failed", "Failed"

    revision = models.ForeignKey(Revision, on_delete=models.PROTECT, related_name="artifacts")
    kind = models.CharField(max_length=16, choices=Asset.Kind)
    state = models.CharField(max_length=10, choices=State, default=State.PENDING)
    required = models.BooleanField(default=True)
    asset = models.ForeignKey(Asset, null=True, blank=True, on_delete=models.PROTECT)
    input_content_hash = models.CharField(max_length=64)
    # Model, dimensions, task mode, preprocessing, normalization/prefix and format versions.
    profile = models.JSONField(default=dict)
    error_code = models.CharField(max_length=80, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["revision", "kind"], name="artifact_kind_uq"),
            enum_check("kind", ["svg", "semantic", "index"], "artifact_kind_ck"),
            enum_check("state", ["pending", "ready", "failed"], "artifact_state_ck"),
            models.CheckConstraint(
                condition=~Q(state="ready") | Q(asset__isnull=False), name="artifact_ready_asset_ck"
            ),
        ]


class Publication(Record):
    target = models.ForeignKey(MapTarget, on_delete=models.PROTECT, related_name="publications")
    revision = models.OneToOneField(Revision, on_delete=models.PROTECT, related_name="publication")
    approval = models.ForeignKey(Review, on_delete=models.PROTECT)
    published_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    sequence = models.PositiveIntegerField()
    is_current = models.BooleanField(default=False)
    invalidated_at = models.DateTimeField(null=True, blank=True)
    invalidation_reason = models.TextField(blank=True)

    class Meta:
        constraints = [
            scope_key("revision", "publication_revision_key"),
            models.UniqueConstraint(fields=["target", "sequence"], name="publication_sequence_uq"),
            models.UniqueConstraint(
                fields=["target"], condition=Q(is_current=True), name="publication_current_uq"
            ),
            models.CheckConstraint(condition=Q(sequence__gt=0), name="publication_sequence_ck"),
            models.CheckConstraint(
                condition=Q(invalidated_at__isnull=True, invalidation_reason="")
                | (Q(invalidated_at__isnull=False, is_current=False) & ~Q(invalidation_reason="")),
                name="publication_invalidation_ck",
            ),
        ]


class ChangeSet(Record):
    contribution = models.ForeignKey(Contribution, on_delete=models.PROTECT, related_name="changes")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    base_revision = models.ForeignKey(
        Revision, on_delete=models.PROTECT, related_name="outgoing_changes"
    )
    result_revision = models.OneToOneField(
        Revision, on_delete=models.PROTECT, related_name="incoming_change"
    )
    idempotency_key = models.UUIDField(default=uuid.uuid4)
    operations = models.JSONField(default=list)
    inverse_operations = models.JSONField(default=list)
    source = models.CharField(max_length=10, choices=[("manual", "Manual"), ("agent", "Agent")])
    provenance = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["contribution", "idempotency_key"], name="change_idempotency_uq"
            ),
            enum_check("source", ["manual", "agent"], "change_source_ck"),
            models.CheckConstraint(
                condition=~Q(base_revision=F("result_revision")),
                name="change_distinct_revisions_ck",
            ),
        ]


class AuditEvent(Record):
    target = models.ForeignKey(MapTarget, on_delete=models.PROTECT, related_name="events")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    revision = models.ForeignKey(Revision, null=True, blank=True, on_delete=models.PROTECT)
    action = models.CharField(max_length=80)
    details = models.JSONField(default=dict, blank=True)

    class Meta:
        indexes = [models.Index(fields=["target", "created_at"], name="audit_timeline_idx")]
