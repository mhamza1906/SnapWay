"""Input validation (camelCase, as in the contract) and JSON representations."""

from datetime import UTC

from django.urls import reverse
from rest_framework import serializers

from .models import POINT_REASONS, POSITION_SOURCES, SLOT_OFFSETS, CapturePhoto


def angle_field(**kwargs):
    return serializers.FloatField(min_value=0, max_value=360, **kwargs)


def check_angle(value, name):
    if not 0 <= value < 360:
        raise serializers.ValidationError({name: "Must be in [0, 360)."})


class SessionInput(serializers.Serializer):
    targetId = serializers.UUIDField()
    mapBuildingId = serializers.CharField(max_length=200)
    mapFloorId = serializers.CharField(max_length=200)
    mapRevision = serializers.IntegerField(min_value=0)
    corridorId = serializers.CharField(max_length=200)
    direction = serializers.ChoiceField(choices=["forward", "reverse"])
    spacingM = serializers.FloatField(min_value=0.1, max_value=100, allow_null=True, default=None)


class PointInput(serializers.Serializer):
    order = serializers.IntegerField(min_value=0)
    planId = serializers.CharField(max_length=200, allow_null=True, allow_blank=True, default=None)
    mapRevision = serializers.IntegerField(min_value=0)
    edgeId = serializers.CharField(max_length=200)
    nodeId = serializers.CharField(max_length=200, allow_null=True, allow_blank=True, default=None)
    referenceEdgeId = serializers.CharField(max_length=200)
    fraction = serializers.FloatField(min_value=0, max_value=1)
    corridorDistancePx = serializers.FloatField(min_value=0)
    distanceM = serializers.FloatField(min_value=0, allow_null=True, default=None)
    forwardAngleDeg = angle_field()
    plannedX = serializers.FloatField()
    plannedY = serializers.FloatField()
    confirmedX = serializers.FloatField(allow_null=True, default=None)
    confirmedY = serializers.FloatField(allow_null=True, default=None)
    positionSource = serializers.ChoiceField(choices=POSITION_SOURCES)
    reason = serializers.ChoiceField(choices=POINT_REASONS)

    def validate(self, data):
        check_angle(data["forwardAngleDeg"], "forwardAngleDeg")
        if (data["confirmedX"] is None) != (data["confirmedY"] is None):
            raise serializers.ValidationError("confirmedX and confirmedY must be set together.")
        return data


class PhotoMetadata(serializers.Serializer):
    slot = serializers.ChoiceField(choices=CapturePhoto.Slot.values)
    viewingAngleDeg = angle_field()
    directionSource = serializers.ChoiceField(choices=["manual-confirmed"])
    positionSource = serializers.ChoiceField(choices=POSITION_SOURCES)
    capturedAt = serializers.DateTimeField()
    clientSha256 = serializers.RegexField(
        r"^[0-9a-fA-F]{64}$", required=False, allow_null=True, allow_blank=True, default=""
    )

    def validate(self, data):
        check_angle(data["viewingAngleDeg"], "viewingAngleDeg")
        data["clientSha256"] = (data.get("clientSha256") or "").lower()
        return data


def iso(value):
    """UTC ISO-8601, identical for fresh and reloaded rows."""
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def expected_angle(forward_angle, slot):
    return (forward_angle + SLOT_OFFSETS[slot]) % 360


def angle_difference(a, b):
    difference = abs(a - b) % 360
    return min(difference, 360 - difference)


def session_json(session):
    return {
        "id": str(session.id),
        "targetId": str(session.target_id),
        "contributor": session.contributor.get_username(),
        "mapBuildingId": session.map_building_id,
        "mapFloorId": session.map_floor_id,
        "mapRevision": session.map_revision,
        "corridorId": session.corridor_id,
        "direction": session.direction,
        "spacingM": session.spacing_m,
        "createdAt": iso(session.created_at),
        "updatedAt": iso(session.updated_at),
    }


def point_json(point):
    return {
        "id": str(point.id),
        "sessionId": str(point.session_id),
        "order": point.order,
        "planId": point.plan_id,
        "mapRevision": point.map_revision,
        "edgeId": point.edge_id,
        "nodeId": point.node_id,
        "referenceEdgeId": point.reference_edge_id,
        "fraction": point.fraction,
        "corridorDistancePx": point.corridor_distance_px,
        "distanceM": point.distance_m,
        "forwardAngleDeg": point.forward_angle_deg,
        "plannedX": point.planned_x,
        "plannedY": point.planned_y,
        "confirmedX": point.confirmed_x,
        "confirmedY": point.confirmed_y,
        "positionSource": point.position_source,
        "reason": point.reason,
        "status": point.status,
        "reviewReason": point.review_reason or None,
        "createdAt": iso(point.created_at),
        "updatedAt": iso(point.updated_at),
    }


def photo_json(photo):
    return {
        "id": str(photo.id),
        "pointId": str(photo.point_id),
        "sessionId": str(photo.session_id),
        "slot": photo.slot,
        "viewingAngleDeg": photo.viewing_angle_deg,
        "directionSource": photo.direction_source,
        "positionSource": photo.position_source,
        "positionX": photo.position_x,
        "positionY": photo.position_y,
        "mapRevision": photo.map_revision,
        "capturedAt": iso(photo.captured_at),
        "sha256": photo.sha256,
        "contentType": photo.content_type,
        "byteSize": photo.byte_size,
        "width": photo.width,
        "height": photo.height,
        "uploadStatus": photo.upload_status,
        "reviewStatus": photo.review_status,
        "reviewReason": photo.review_reason or None,
        "replacedBy": str(photo.replaced_by_id) if photo.replaced_by_id else None,
        "thumbnailUrl": reverse(
            "capture-photo-image", kwargs={"photo_id": photo.id, "variant": "thumbnail"}
        ),
        "displayUrl": reverse(
            "capture-photo-image", kwargs={"photo_id": photo.id, "variant": "display"}
        ),
        "createdAt": iso(photo.created_at),
    }
