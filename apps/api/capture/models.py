"""Photo capture records (contract: docs/photo-capture.md, "Django capture API").

Capture points are not routing vertices: they only reference pipeline edge/node IDs.
Image bytes live in private storage as maps.Asset rows (append-only); these tables
hold capture metadata. Primary keys are client-generated UUIDs so writes are
idempotent PUTs.
"""

from django.conf import settings
from django.db import models
from django.db.models import Q
from maps.models import enum_check, scope_key

SLOTS = ["forward", "right", "backward", "left"]
SLOT_OFFSETS = {"forward": 0, "right": 90, "backward": 180, "left": 270}
POSITION_SOURCES = ["planned", "contributor-confirmed", "contributor-adjusted", "manual"]
POINT_REASONS = ["start", "spacing", "turn", "junction", "door", "end", "adjusted", "manual"]
REVISION_CHANGED = "map revision changed"


def angle_check(field, name, nullable=False):
    condition = Q(**{f"{field}__gte": 0, f"{field}__lt": 360})
    if nullable:
        condition |= Q(**{f"{field}__isnull": True})
    return models.CheckConstraint(condition=condition, name=name)


class Timestamped(models.Model):
    id = models.UUIDField(primary_key=True, editable=False)  # supplied by the client
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class CaptureMapLink(models.Model):
    """Associates a MapTarget (one per floor) with a pipeline building/floor map."""

    id = models.BigAutoField(primary_key=True)
    created_at = models.DateTimeField(auto_now_add=True)
    target = models.OneToOneField(
        "maps.MapTarget", on_delete=models.PROTECT, related_name="capture_link"
    )
    map_building_id = models.CharField(max_length=200)
    map_floor_id = models.CharField(max_length=200)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["map_building_id", "map_floor_id"], name="capture_map_link_uq"
            )
        ]


class CaptureSession(Timestamped):
    class Direction(models.TextChoices):
        FORWARD = "forward", "Forward"
        REVERSE = "reverse", "Reverse"

    target = models.ForeignKey(
        "maps.MapTarget", on_delete=models.PROTECT, related_name="capture_sessions"
    )
    contributor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="capture_sessions"
    )
    map_building_id = models.CharField(max_length=200)
    map_floor_id = models.CharField(max_length=200)
    map_revision = models.PositiveIntegerField()
    corridor_id = models.CharField(max_length=200)
    direction = models.CharField(max_length=8, choices=Direction)
    spacing_m = models.FloatField(null=True, blank=True)

    class Meta:
        constraints = [
            scope_key("target", "capture_session_target_key"),
            enum_check("direction", ["forward", "reverse"], "capture_session_direction_ck"),
            models.CheckConstraint(
                condition=Q(spacing_m__isnull=True) | Q(spacing_m__gt=0),
                name="capture_session_spacing_ck",
            ),
        ]
        indexes = [
            models.Index(
                fields=["contributor", "target", "-created_at"], name="capture_session_list_idx"
            )
        ]


class CapturePoint(Timestamped):
    class Status(models.TextChoices):
        EMPTY = "empty", "Empty"
        PARTIAL = "partial", "Partial"
        COMPLETE = "complete", "Complete"
        NEEDS_REVIEW = "needs-review", "Needs review"

    session = models.ForeignKey(CaptureSession, on_delete=models.PROTECT, related_name="points")
    order = models.PositiveIntegerField()
    plan_id = models.CharField(max_length=200, null=True, blank=True)
    map_revision = models.PositiveIntegerField()
    edge_id = models.CharField(max_length=200)
    node_id = models.CharField(max_length=200, null=True, blank=True)
    reference_edge_id = models.CharField(max_length=200)
    fraction = models.FloatField()
    corridor_distance_px = models.FloatField()
    distance_m = models.FloatField(null=True, blank=True)
    forward_angle_deg = models.FloatField()
    planned_x = models.FloatField()
    planned_y = models.FloatField()
    confirmed_x = models.FloatField(null=True, blank=True)
    confirmed_y = models.FloatField(null=True, blank=True)
    position_source = models.CharField(max_length=24)
    reason = models.CharField(max_length=16)
    status = models.CharField(max_length=14, choices=Status, default=Status.EMPTY)
    review_reason = models.CharField(max_length=200, blank=True)

    class Meta:
        constraints = [
            scope_key("session", "capture_point_session_key"),
            enum_check(
                "status",
                ["empty", "partial", "complete", "needs-review"],
                "capture_point_status_ck",
            ),
            enum_check("position_source", POSITION_SOURCES, "capture_point_source_ck"),
            enum_check("reason", POINT_REASONS, "capture_point_reason_ck"),
            angle_check("forward_angle_deg", "capture_point_angle_ck"),
            models.CheckConstraint(
                condition=Q(fraction__gte=0, fraction__lte=1), name="capture_point_fraction_ck"
            ),
            models.CheckConstraint(
                condition=Q(corridor_distance_px__gte=0), name="capture_point_corridor_ck"
            ),
            models.CheckConstraint(
                condition=Q(distance_m__isnull=True) | Q(distance_m__gte=0),
                name="capture_point_distance_ck",
            ),
            models.CheckConstraint(
                condition=Q(confirmed_x__isnull=True, confirmed_y__isnull=True)
                | Q(confirmed_x__isnull=False, confirmed_y__isnull=False),
                name="capture_point_confirmed_pair_ck",
            ),
            models.CheckConstraint(
                condition=~Q(status="needs-review") | ~Q(review_reason=""),
                name="capture_point_review_reason_ck",
            ),
        ]
        indexes = [models.Index(fields=["session", "order"], name="capture_point_order_idx")]


class CapturePhoto(Timestamped):
    class Slot(models.TextChoices):
        FORWARD = "forward", "Forward"
        RIGHT = "right", "Right"
        BACKWARD = "backward", "Backward"
        LEFT = "left", "Left"
        EXTRA = "extra", "Extra"

    class UploadStatus(models.TextChoices):
        UPLOADED = "uploaded", "Uploaded"

    class ReviewStatus(models.TextChoices):
        PENDING = "pending", "Pending"
        NEEDS_REVIEW = "needs-review", "Needs review"
        ACCEPTED = "accepted", "Accepted"
        REPLACED = "replaced", "Replaced"

    # Redundant target/session keys keep membership checks to one indexed lookup.
    target = models.ForeignKey(
        "maps.MapTarget", on_delete=models.PROTECT, related_name="capture_photos"
    )
    session = models.ForeignKey(CaptureSession, on_delete=models.PROTECT, related_name="photos")
    point = models.ForeignKey(CapturePoint, on_delete=models.PROTECT, related_name="photos")
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    slot = models.CharField(max_length=10, choices=Slot)
    viewing_angle_deg = models.FloatField()
    direction_source = models.CharField(max_length=20, default="manual-confirmed")
    position_source = models.CharField(max_length=24)
    # Confirmed (else planned) point position and map revision at upload time.
    position_x = models.FloatField()
    position_y = models.FloatField()
    map_revision = models.PositiveIntegerField()
    captured_at = models.DateTimeField()
    original_asset = models.ForeignKey(
        "maps.Asset", on_delete=models.PROTECT, related_name="capture_originals"
    )
    display_asset = models.ForeignKey(
        "maps.Asset", on_delete=models.PROTECT, related_name="capture_displays"
    )
    thumbnail_asset = models.ForeignKey(
        "maps.Asset", on_delete=models.PROTECT, related_name="capture_thumbnails"
    )
    sha256 = models.CharField(max_length=64)  # of the original bytes
    client_sha256 = models.CharField(max_length=64, blank=True)
    content_type = models.CharField(max_length=40)
    byte_size = models.PositiveBigIntegerField()
    # Upright (EXIF orientation applied) original dimensions.
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()
    upload_status = models.CharField(
        max_length=12, choices=UploadStatus, default=UploadStatus.UPLOADED
    )
    review_status = models.CharField(
        max_length=14, choices=ReviewStatus, default=ReviewStatus.PENDING
    )
    review_reason = models.CharField(max_length=200, blank=True)
    replaced_by = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.PROTECT, related_name="replaces"
    )

    class Meta:
        constraints = [
            enum_check(
                "slot", ["forward", "right", "backward", "left", "extra"], "capture_slot_ck"
            ),
            enum_check("upload_status", ["uploaded"], "capture_upload_status_ck"),
            enum_check(
                "review_status",
                ["pending", "needs-review", "accepted", "replaced"],
                "capture_review_status_ck",
            ),
            enum_check("direction_source", ["manual-confirmed"], "capture_direction_source_ck"),
            enum_check("position_source", POSITION_SOURCES, "capture_photo_source_ck"),
            angle_check("viewing_angle_deg", "capture_photo_angle_ck"),
            models.CheckConstraint(
                condition=Q(width__gt=0, height__gt=0, byte_size__gt=0),
                name="capture_photo_size_ck",
            ),
            models.CheckConstraint(
                condition=~Q(review_status="needs-review") | ~Q(review_reason=""),
                name="capture_photo_review_reason_ck",
            ),
            # At most one current (non-replaced) photo per point and fixed slot.
            models.UniqueConstraint(
                fields=["point", "slot"],
                condition=~Q(review_status="replaced") & ~Q(slot="extra"),
                name="capture_photo_current_slot_uq",
            ),
        ]
        indexes = [models.Index(fields=["point", "slot"], name="capture_photo_slot_idx")]
