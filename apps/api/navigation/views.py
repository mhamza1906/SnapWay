"""Photo localization and visitor session / route-plan APIs.

MegaLoc-first decisions come from the place-match engine unchanged. Frames are not stored.
First successful session localize may attach a Dijkstra RoutePlan (see
docs/visitor-text-route-guidance.md). Capture-backed LocalizationResult remains retention-gated.
"""

from __future__ import annotations

import json

from django.http import HttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema, inline_serializer
from maps.models import Node
from maps.services.index_catalog import eligible_index_entries, enrich_target_context
from PIL import Image, UnidentifiedImageError
from rest_framework import serializers, status
from rest_framework.authentication import SessionAuthentication
from rest_framework.parsers import JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from navigation.authentication import (
    DevTokenAuthentication,
    NavigationCapabilityAuthentication,
)
from navigation.models import NavigationSession
from navigation.permissions import CanLocalize, caller_kind
from navigation.services import placematch
from navigation.services.placematch import MAX_UPLOAD_BYTES, EngineError
from navigation.services.route_plan import active_plan, ensure_route_for_localize, plan_to_dict
from navigation.services.session import SessionError, create_session, session_public_payload

MAX_SIDE = 4096


class FrameMetaSerializer(serializers.Serializer):
    client_frame_id = serializers.IntegerField(min_value=0)
    timestamp_s = serializers.FloatField(min_value=0, required=False, allow_null=True)
    captured_at = serializers.CharField(max_length=40, required=False, allow_null=True)
    orientation = serializers.ChoiceField(
        choices=["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight", "unknown"],
        required=False,
        allow_null=True,
    )
    app_version = serializers.CharField(max_length=32, required=False, allow_null=True)
    source = serializers.ChoiceField(choices=["camera", "video"], required=False, allow_null=True)

    def validate(self, attrs):
        unknown = set(self.initial_data) - set(self.fields)
        if unknown:
            raise serializers.ValidationError(f"Unknown fields: {sorted(unknown)}")
        return attrs


class CreateSessionSerializer(serializers.Serializer):
    publication_id = serializers.UUIDField()
    destination_stable_id = serializers.UUIDField(
        help_text="Public buildings destinations[].id (Node.stable_id), not Node.id."
    )


class LocalizationView(APIView):
    authentication_classes = [
        NavigationCapabilityAuthentication,
        DevTokenAuthentication,
        SessionAuthentication,
    ]
    permission_classes = [CanLocalize]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "localization"


def _engine_error(exc: EngineError) -> Response:
    return Response({"error": exc.code, "detail": exc.detail}, status=exc.status)


def _check_jpeg(upload) -> bytes:
    if upload is None:
        raise serializers.ValidationError({"image": "Attach a JPEG frame."})
    if (upload.content_type or "").lower() != "image/jpeg":
        raise _Unsupported("Frames must be sent as image/jpeg.")
    if upload.size > MAX_UPLOAD_BYTES:
        raise _TooLarge(f"Frames must be at most {MAX_UPLOAD_BYTES} bytes.")
    data = upload.read()
    try:
        with Image.open(upload) as im:
            if im.format != "JPEG":
                raise _Unsupported("Frames must be JPEG images.")
            if max(im.size) > MAX_SIDE:
                raise _TooLarge(f"Frames must be at most {MAX_SIDE} px on the longest side.")
    except (UnidentifiedImageError, OSError) as exc:
        raise serializers.ValidationError({"image": "The frame could not be decoded."}) from exc
    return data


class _Unsupported(Exception):
    status = status.HTTP_415_UNSUPPORTED_MEDIA_TYPE


class _TooLarge(Exception):
    status = status.HTTP_413_REQUEST_ENTITY_TOO_LARGE


def _stable_id_for_pk(node_pk) -> str | None:
    from navigation.services.routing import _as_uuid

    pk = _as_uuid(node_pk)
    if pk is None:
        return None
    found = Node.objects.filter(pk=pk).values_list("stable_id", flat=True).first()
    return str(found) if found else None


def _attach_route(request, body: dict) -> dict:
    """On first likely_match for a NavigationSession, build/return RoutePlan."""
    decision = body.get("decision") or {}
    node_pk = body.get("node_id") or decision.get("node_id") or decision.get("location_id")
    body["node_stable_id"] = _stable_id_for_pk(node_pk)

    session = request.auth if isinstance(request.auth, NavigationSession) else None
    if session is None:
        body["route"] = None
        return body

    dest = session.destination
    body["destination_node_id"] = str(dest.id) if dest else None
    body["destination_stable_id"] = str(dest.stable_id) if dest else None

    outcome = (decision.get("outcome") or "").lower()
    if outcome != "likely_match" or not node_pk or dest is None:
        existing = active_plan(session)
        body["route"] = plan_to_dict(existing) if existing else None
        return body

    body["route"] = ensure_route_for_localize(session, start_node_id=node_pk)
    return body


class LocalizationHealthView(LocalizationView):
    @extend_schema(
        summary="Localization service health",
        description="Engine readiness per backend, reference set and thresholds id. No secrets.",
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        try:
            body = placematch.health()
        except EngineError as exc:
            return _engine_error(exc)
        return Response({**body, "caller": caller_kind(request)})


class LocalizeView(LocalizationView):
    parser_classes = [MultiPartParser]

    @extend_schema(
        summary="Match one camera frame across all ready floor MegaLoc indexes",
        description=(
            "Multipart `image` (JPEG, at most 3 MB and 4096 px) and `meta` JSON. Searches the "
            "union of published (and DEBUG draft) revision index zips — no floor prompt. "
            "With Authorization: Navigation <secret> and a session destination, the first "
            "likely_match also returns a Dijkstra route plan (stable_id vs node PK documented "
            "in docs/visitor-text-route-guidance.md)."
        ),
        request={
            "multipart/form-data": inline_serializer(
                "LocalizeRequest",
                {
                    "image": serializers.FileField(),
                    "meta": serializers.CharField(help_text="FrameMeta JSON"),
                },
            )
        },
        responses={200: OpenApiTypes.OBJECT},
    )
    def post(self, request):
        try:
            image = _check_jpeg(request.FILES.get("image"))
        except (_Unsupported, _TooLarge) as exc:
            return Response({"error": "invalid_image", "detail": str(exc)}, status=exc.status)
        try:
            meta_raw = json.loads(request.data.get("meta") or "{}")
        except ValueError:
            return Response({"meta": "Must be JSON."}, status=status.HTTP_400_BAD_REQUEST)
        meta = FrameMetaSerializer(data=meta_raw if isinstance(meta_raw, dict) else {})
        meta.is_valid(raise_exception=True)
        frame_meta = {k: v for k, v in meta.validated_data.items() if v is not None}

        if request.query_params.get("mode", "global") == "legacy":
            backend = request.query_params.get("backend", "auto")
            if backend not in {"auto", "megaloc", "vertex"}:
                return Response({"backend": "Use auto, megaloc or vertex."}, status=400)
            flags = {
                name: request.query_params.get(name, "false").lower() == "true"
                for name in ("verify", "second_opinion")
            }
            try:
                body = placematch.match(image, frame_meta, backend=backend, **flags)
            except EngineError as exc:
                return _engine_error(exc)
            return Response({**body, "caller": caller_kind(request), "route": None})

        revision_id = request.query_params.get("revision_id") or None
        target_id = request.query_params.get("target_id") or None
        if revision_id and target_id:
            return Response(
                {"detail": "Pass at most one of revision_id or target_id."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        entries = eligible_index_entries(revision_id=revision_id, target_id=target_id)
        if not entries:
            return Response(
                {
                    "error": "index_not_ready",
                    "detail": "No ready MegaLoc indexes in the localization catalog.",
                },
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            placematch.ensure_catalog_synced(entries)
            body = placematch.match_global(image, frame_meta)
        except EngineError as exc:
            return _engine_error(exc)

        decision = body.get("decision") or {}
        ctx = enrich_target_context(decision.get("target_id"))
        payload = {
            **body,
            **ctx,
            "node_id": decision.get("node_id") or decision.get("location_id"),
            "revision_id": decision.get("revision_id") or ctx.get("revision_id"),
            "caller": caller_kind(request),
        }
        return Response(_attach_route(request, payload))


class NavigationSessionCreateView(APIView):
    """Anonymous visitor session: pin publication + destination_stable_id before first photo."""

    authentication_classes = []
    permission_classes = [AllowAny]
    parser_classes = [JSONParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "navigation_session"

    @extend_schema(
        summary="Create visitor navigation session",
        request=CreateSessionSerializer,
        responses={201: OpenApiTypes.OBJECT},
    )
    def post(self, request):
        ser = CreateSessionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            session, secret = create_session(
                publication_id=ser.validated_data["publication_id"],
                destination_stable_id=ser.validated_data["destination_stable_id"],
            )
        except SessionError as exc:
            return Response(
                {"error": exc.code, "detail": exc.detail},
                status=exc.status,
            )
        return Response(
            session_public_payload(session, secret=secret), status=status.HTTP_201_CREATED
        )


class CurrentRouteView(LocalizationView):
    """Return the active RoutePlan for the Navigation session capability."""

    @extend_schema(
        summary="Current route plan for this navigation session",
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        if not isinstance(request.auth, NavigationSession):
            return Response(
                {
                    "error": "navigation_session_required",
                    "detail": "Use Authorization: Navigation <secret>.",
                },
                status=status.HTTP_401_UNAUTHORIZED,
            )
        plan = active_plan(request.auth)
        return Response(
            {
                "route": plan_to_dict(plan) if plan else None,
                "destination_node_id": (
                    str(request.auth.destination_id) if request.auth.destination_id else None
                ),
                "destination_stable_id": (
                    str(request.auth.destination.stable_id) if request.auth.destination else None
                ),
                "context_version": request.auth.context_version,
                "caller": caller_kind(request),
            }
        )


class ReferenceThumbnailView(LocalizationView):
    @extend_schema(
        summary="Reference photo thumbnail (only ids from the set)",
        responses={(200, "image/jpeg"): OpenApiTypes.BINARY},
    )
    def get(self, request, reference_set, reference_id):
        try:
            resp = placematch.thumbnail(reference_set, reference_id)
        except EngineError as exc:
            return _engine_error(exc)
        if not resp.content_type.startswith("image/jpeg"):
            return Response({"error": "engine_error"}, status=status.HTTP_502_BAD_GATEWAY)
        out = HttpResponse(resp.body, content_type="image/jpeg")
        out["Cache-Control"] = "private, max-age=300"
        return out


class MegaLocIndexView(LocalizationView):
    @extend_schema(
        summary="fp16 MegaLoc reference index for on-device search",
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request, reference_set):
        try:
            return Response(placematch.megaloc_index(reference_set))
        except EngineError as exc:
            return _engine_error(exc)
