"""Django capture API (docs/photo-capture.md, "Django capture API")."""

import json
import logging
import uuid
from urllib.parse import quote

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import IntegrityError, transaction
from django.http import FileResponse
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from drf_spectacular.utils import extend_schema
from maps.models import Asset
from rest_framework import status
from rest_framework.exceptions import NotFound, ParseError, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import images
from .access import (
    CaptureSessionAuthentication,
    active_memberships,
    check_session,
    get_or_404,
    membership_for,
)
from .models import REVISION_CHANGED, SLOTS, CaptureMapLink, CapturePhoto, CapturePoint
from .models import CaptureSession as Session
from .serializers import (
    PhotoMetadata,
    PointInput,
    SessionInput,
    angle_difference,
    expected_angle,
    photo_json,
    point_json,
    session_json,
)

logger = logging.getLogger(__name__)
SLOT_ANGLE_TOLERANCE_DEG = 1.0
# Fields that fix a point's position (and therefore its photos' meaning).
POSITION_FIELDS = {
    "mapRevision": "map_revision",
    "edgeId": "edge_id",
    "nodeId": "node_id",
    "referenceEdgeId": "reference_edge_id",
    "fraction": "fraction",
    "corridorDistancePx": "corridor_distance_px",
    "distanceM": "distance_m",
    "forwardAngleDeg": "forward_angle_deg",
    "plannedX": "planned_x",
    "plannedY": "planned_y",
    "confirmedX": "confirmed_x",
    "confirmedY": "confirmed_y",
    "positionSource": "position_source",
}
OTHER_POINT_FIELDS = {"order": "order", "planId": "plan_id", "reason": "reason"}


def conflict(detail, **extra):
    return Response({"detail": detail, **extra}, status=status.HTTP_409_CONFLICT)


def safe_next(value):
    if value and value.startswith("/") and not value.startswith("//") and "\\" not in value:
        return value
    return "/capture"


class CaptureView(APIView):
    authentication_classes = [CaptureSessionAuthentication]
    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]

    def dispatch(self, request, *args, **kwargs):
        # URL IDs are validated by the route regex; normalise them to UUID objects.
        kwargs = {
            key: uuid.UUID(value) if key.endswith("_id") else value for key, value in kwargs.items()
        }
        return super().dispatch(request, *args, **kwargs)


def recompute_point_status(point):
    """empty/partial/complete from uploaded, non-replaced photos; needs-review is sticky."""
    if point.status == CapturePoint.Status.NEEDS_REVIEW:
        return
    slots = set(
        point.photos.filter(upload_status=CapturePhoto.UploadStatus.UPLOADED, slot__in=SLOTS)
        .exclude(review_status=CapturePhoto.ReviewStatus.REPLACED)
        .values_list("slot", flat=True)
    )
    if not slots:
        point.status = CapturePoint.Status.EMPTY
    elif len(slots) == len(SLOTS):
        point.status = CapturePoint.Status.COMPLETE
    else:
        point.status = CapturePoint.Status.PARTIAL


def session_detail(session):
    points = session.points.order_by("order", "created_at")
    photos = session.photos.order_by("created_at")
    return {
        **session_json(session),
        "points": [point_json(point) for point in points],
        "photos": [photo_json(photo) for photo in photos],
    }


@method_decorator(ensure_csrf_cookie, name="dispatch")
@extend_schema(exclude=True)
class MeView(CaptureView):
    permission_classes = [AllowAny]

    def get(self, request):
        login_url = f"{settings.LOGIN_URL}?next={quote(safe_next(request.GET.get('next')))}"
        user = request.user
        if not user.is_authenticated:
            return Response(
                {"authenticated": False, "username": None, "loginUrl": login_url, "targets": []}
            )
        memberships = (
            active_memberships(user)
            .filter(target__capture_link__isnull=False)
            .select_related("target__capture_link", "target__floor__building")
            .order_by("target__floor__building__name", "target__floor__sort_order")
        )
        targets = [
            {
                "id": str(m.target_id),
                "title": m.target.title,
                "role": m.role,
                "mapBuildingId": m.target.capture_link.map_building_id,
                "mapFloorId": m.target.capture_link.map_floor_id,
            }
            for m in memberships
        ]
        return Response(
            {
                "authenticated": True,
                "username": user.get_username(),
                "loginUrl": login_url,
                "targets": targets,
            }
        )


@extend_schema(exclude=True)
class SessionListView(CaptureView):
    def get(self, request):
        target_ids = active_memberships(request.user).values("target_id")
        sessions = Session.objects.filter(contributor=request.user, target_id__in=target_ids)
        if target_id := request.GET.get("targetId"):
            try:
                target_id = uuid.UUID(target_id)
            except ValueError as error:
                raise ParseError("targetId must be a UUID.") from error
            membership_for(request.user, target_id)
            sessions = sessions.filter(target_id=target_id)
        if floor_id := request.GET.get("mapFloorId"):
            sessions = sessions.filter(map_floor_id=floor_id)
        sessions = sessions.select_related("contributor").order_by("-created_at")
        return Response({"sessions": [session_json(s) for s in sessions]})


@extend_schema(exclude=True)
class SessionView(CaptureView):
    def get(self, request, session_id):
        session = get_or_404(Session.objects.select_related("contributor"), id=session_id)
        check_session(request.user, session)
        return Response(session_detail(session))

    def put(self, request, session_id):
        data = SessionInput(data=request.data)
        data.is_valid(raise_exception=True)
        data = data.validated_data
        membership_for(request.user, data["targetId"])
        link = CaptureMapLink.objects.filter(target_id=data["targetId"]).first()
        if (
            link is None
            or link.map_building_id != data["mapBuildingId"]
            or link.map_floor_id != data["mapFloorId"]
        ):
            raise ValidationError({"mapFloorId": "Does not match the map target's floor."})
        fields = {
            "map_revision": data["mapRevision"],
            "corridor_id": data["corridorId"],
            "direction": data["direction"],
            "spacing_m": data["spacingM"],
        }
        with transaction.atomic():
            session = Session.objects.select_for_update().filter(id=session_id).first()
            if session is None:
                try:
                    with transaction.atomic():
                        session = Session.objects.create(
                            id=session_id,
                            target_id=data["targetId"],
                            contributor=request.user,
                            map_building_id=data["mapBuildingId"],
                            map_floor_id=data["mapFloorId"],
                            **fields,
                        )
                except IntegrityError:
                    return conflict("Session was created concurrently; retry.")
                return Response(session_json(session), status=status.HTTP_201_CREATED)
            check_session(request.user, session, write=True)
            if str(session.target_id) != str(data["targetId"]) or (
                session.map_building_id,
                session.map_floor_id,
            ) != (data["mapBuildingId"], data["mapFloorId"]):
                return conflict("A session cannot move to another map target or floor.")
            if session.points.exists() and (
                session.corridor_id != fields["corridor_id"]
                or session.direction != fields["direction"]
            ):
                return conflict("Corridor and direction are fixed once points exist.")
            for name, value in fields.items():
                setattr(session, name, value)
            session.save()
        return Response(session_json(session))


@extend_schema(exclude=True)
class PointView(CaptureView):
    def put(self, request, session_id, point_id):
        session = get_or_404(Session.objects.select_related("contributor"), id=session_id)
        check_session(request.user, session, write=True)
        data = PointInput(data=request.data)
        data.is_valid(raise_exception=True)
        data = data.validated_data
        data["planId"] = data["planId"] or None
        data["nodeId"] = data["nodeId"] or None
        with transaction.atomic():
            point = CapturePoint.objects.select_for_update().filter(id=point_id).first()
            if point is None:
                values = {
                    column: data[key]
                    for key, column in {**POSITION_FIELDS, **OTHER_POINT_FIELDS}.items()
                }
                try:
                    with transaction.atomic():
                        point = CapturePoint(id=point_id, session=session, **values)
                        point.save()
                except IntegrityError:
                    return conflict("Point was created concurrently; retry.")
                return Response(point_json(point), status=status.HTTP_201_CREATED)
            if point.session_id != session.id:
                return conflict("This point ID belongs to another session.")
            has_photos = point.photos.exists()
            moved = [
                key
                for key, column in POSITION_FIELDS.items()
                if getattr(point, column) != data[key]
            ]
            if has_photos and moved:
                return conflict(
                    "This point already has photos; add another point instead.", fields=moved
                )
            for key, column in OTHER_POINT_FIELDS.items():
                setattr(point, column, data[key])
            if moved:
                if point.map_revision != data["mapRevision"]:
                    # Re-planned on another revision with no photos: the review flag is resolved.
                    point.status = CapturePoint.Status.EMPTY
                    point.review_reason = ""
                for key in moved:
                    setattr(point, POSITION_FIELDS[key], data[key])
            recompute_point_status(point)
            point.save()
        return Response(point_json(point))

    def delete(self, request, session_id, point_id):
        session = get_or_404(Session.objects, id=session_id)
        check_session(request.user, session, write=True)
        with transaction.atomic():
            point = CapturePoint.objects.select_for_update().filter(id=point_id).first()
            if point is None:
                return Response(status=status.HTTP_204_NO_CONTENT)  # idempotent retry
            if point.session_id != session.id:
                raise NotFound()
            if point.photos.exists():
                return conflict("This point has photos and cannot be deleted.")
            point.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema(exclude=True)
class RevisionCheckView(CaptureView):
    def post(self, request, session_id):
        session = get_or_404(Session.objects.select_related("contributor"), id=session_id)
        check_session(request.user, session, write=True)
        current = request.data.get("currentRevision") if isinstance(request.data, dict) else None
        if not isinstance(current, int) or isinstance(current, bool) or current < 0:
            raise ValidationError({"currentRevision": "A non-negative integer is required."})
        with transaction.atomic():
            points = session.points.select_for_update().filter(map_revision__lt=current)
            flagged_points = points.exclude(
                status=CapturePoint.Status.NEEDS_REVIEW, review_reason=REVISION_CHANGED
            ).update(status=CapturePoint.Status.NEEDS_REVIEW, review_reason=REVISION_CHANGED)
            flagged_photos = (
                session.photos.filter(map_revision__lt=current)
                .exclude(review_status=CapturePhoto.ReviewStatus.REPLACED)
                .exclude(
                    review_status=CapturePhoto.ReviewStatus.NEEDS_REVIEW,
                    review_reason=REVISION_CHANGED,
                )
                .update(
                    review_status=CapturePhoto.ReviewStatus.NEEDS_REVIEW,
                    review_reason=REVISION_CHANGED,
                )
            )
        return Response(
            {
                "currentRevision": current,
                "flaggedPoints": flagged_points,
                "flaggedPhotos": flagged_photos,
                "session": session_detail(session),
            }
        )


def _save(name, data):
    return default_storage.save(name, ContentFile(data))


@extend_schema(exclude=True)
class PhotoView(CaptureView):
    parser_classes = [MultiPartParser, FormParser]

    def put(self, request, point_id, photo_id):
        point = get_or_404(CapturePoint.objects.select_related("session"), id=point_id)
        session = point.session
        check_session(request.user, session, write=True)

        upload = request.FILES.get("image")
        if upload is None:
            raise ValidationError({"image": "An image file is required."})
        if upload.size > images.max_upload_bytes():
            return Response(
                {"detail": "Image exceeds the upload size limit."},
                status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )
        raw_metadata = request.data.get("metadata")
        try:
            metadata = json.loads(raw_metadata) if isinstance(raw_metadata, str) else None
        except json.JSONDecodeError:
            metadata = None
        if not isinstance(metadata, dict):
            raise ValidationError({"metadata": "A JSON object is required."})
        meta = PhotoMetadata(data=metadata)
        meta.is_valid(raise_exception=True)
        meta = meta.validated_data

        data = upload.read()
        sha256 = images.sha256_hex(data)
        existing = CapturePhoto.objects.filter(id=photo_id).first()
        if existing is not None:
            return self._retry(request, existing, point, sha256)
        if meta["clientSha256"] and meta["clientSha256"] != sha256:
            raise ValidationError({"clientSha256": "Does not match the uploaded bytes."})
        if meta["slot"] in SLOTS:
            expected = expected_angle(point.forward_angle_deg, meta["slot"])
            if angle_difference(expected, meta["viewingAngleDeg"]) > SLOT_ANGLE_TOLERANCE_DEG:
                raise ValidationError(
                    {"viewingAngleDeg": f"Slot {meta['slot']} expects {expected:g} degrees."}
                )
        try:
            processed = images.process(data)
        except images.ImageRejected as error:
            if "size limit" in str(error):
                return Response(
                    {"detail": str(error)}, status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
                )
            raise ValidationError({"image": str(error)}) from None

        prefix = f"capture/{session.target_id}/{session.id}/{photo_id}"
        saved = []
        try:
            saved.append(_save(f"{prefix}/original.{processed.extension}", processed.original))
            saved.append(_save(f"{prefix}/display.jpg", processed.display.data))
            saved.append(_save(f"{prefix}/thumbnail.jpg", processed.thumbnail.data))
            with transaction.atomic():
                point = CapturePoint.objects.select_for_update().get(id=point.id)
                if CapturePhoto.objects.filter(id=photo_id).exists():
                    raise IntegrityError("concurrent photo")
                photo = self._create(request, point, photo_id, meta, processed, saved)
        except IntegrityError:
            self._discard(saved)
            existing = CapturePhoto.objects.filter(id=photo_id).first()
            if existing is not None:
                return self._retry(request, existing, point, sha256)
            return conflict("Photo was written concurrently; retry.")
        except Exception:
            self._discard(saved)
            raise
        return Response(photo_json(photo), status=status.HTTP_201_CREATED)

    def _retry(self, request, existing, point, sha256):
        if existing.point_id != point.id:
            return conflict("This photo ID belongs to another point.")
        check_session(request.user, existing.session, write=True)
        if existing.sha256 != sha256:
            return conflict("A different image was already stored under this photo ID.")
        return Response(photo_json(existing), status=status.HTTP_200_OK)

    @staticmethod
    def _discard(names):
        for name in names:
            try:
                default_storage.delete(name)
            except OSError:
                logger.warning("Could not remove an orphaned capture file")

    def _create(self, request, point, photo_id, meta, processed, saved):
        target_id = point.session.target_id
        common = {"target_id": target_id, "uploaded_by": request.user, "kind": Asset.Kind.PHOTO}
        provenance = {"capturePhotoId": str(photo_id), "capturePointId": str(point.id)}
        original = Asset.objects.create(
            **common,
            storage_key=saved[0],
            content_type=processed.content_type,
            sha256=processed.sha256,
            byte_size=len(processed.original),
            width=processed.raw_width,
            height=processed.raw_height,
            provenance={
                **provenance,
                "variant": "original",
                "exifOrientation": processed.orientation,
            },
        )
        derived = {}
        for index, (variant, rendition) in enumerate(
            [("display", processed.display), ("thumbnail", processed.thumbnail)], start=1
        ):
            derived[variant] = Asset.objects.create(
                **common,
                storage_key=saved[index],
                content_type=rendition.content_type,
                sha256=images.sha256_hex(rendition.data),
                byte_size=len(rendition.data),
                width=rendition.width,
                height=rendition.height,
                source_asset=original,
                provenance={**provenance, "variant": variant, "transform": "exif_transpose+jpeg"},
            )
        previous = []
        if meta["slot"] in SLOTS:
            previous = list(
                point.photos.filter(slot=meta["slot"]).exclude(
                    review_status=CapturePhoto.ReviewStatus.REPLACED
                )
            )
            for old in previous:
                old.review_status = CapturePhoto.ReviewStatus.REPLACED
                old.save(update_fields=["review_status", "updated_at"])
        x, y = (
            (point.confirmed_x, point.confirmed_y)
            if point.confirmed_x is not None
            else (point.planned_x, point.planned_y)
        )
        photo = CapturePhoto.objects.create(
            id=photo_id,
            target_id=target_id,
            session=point.session,
            point=point,
            uploaded_by=request.user,
            slot=meta["slot"],
            viewing_angle_deg=meta["viewingAngleDeg"],
            direction_source=meta["directionSource"],
            position_source=meta["positionSource"],
            position_x=x,
            position_y=y,
            map_revision=point.map_revision,
            captured_at=meta["capturedAt"],
            original_asset=original,
            display_asset=derived["display"],
            thumbnail_asset=derived["thumbnail"],
            sha256=processed.sha256,
            client_sha256=meta["clientSha256"],
            content_type=processed.content_type,
            byte_size=len(processed.original),
            width=processed.width,
            height=processed.height,
        )
        for old in previous:
            old.replaced_by = photo
            old.save(update_fields=["replaced_by", "updated_at"])
        recompute_point_status(point)
        point.save(update_fields=["status", "updated_at"])
        return photo


@extend_schema(exclude=True)
class PhotoImageView(CaptureView):
    def get(self, request, photo_id, variant):
        photo = get_or_404(
            CapturePhoto.objects.select_related("session", "display_asset", "thumbnail_asset"),
            id=photo_id,
        )
        check_session(request.user, photo.session)
        asset = photo.thumbnail_asset if variant == "thumbnail" else photo.display_asset
        try:
            handle = default_storage.open(asset.storage_key, "rb")
        except (FileNotFoundError, OSError):
            raise NotFound("Image file is unavailable.") from None
        response = FileResponse(handle, content_type=asset.content_type)
        response["Cache-Control"] = "private, max-age=3600"
        response["X-Content-Type-Options"] = "nosniff"
        response["Content-Disposition"] = "inline"
        return response
