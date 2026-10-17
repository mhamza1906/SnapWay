"""Photo localization API: validates and forwards frames to the place-match engine.

MegaLoc-first decisions, Vertex AI fallback and every score come from the engine unchanged.
Frames are not stored and their bytes are never logged. Persisting results in
``LocalizationResult`` needs a stored ``Capture`` asset, which is out of scope until frame
retention is approved (see docs/place-match-production.md).
"""

from __future__ import annotations

import json

from django.http import HttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema, inline_serializer
from PIL import Image, UnidentifiedImageError
from rest_framework import serializers, status
from rest_framework.authentication import SessionAuthentication
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from navigation.authentication import DevTokenAuthentication, NavigationCapabilityAuthentication
from navigation.permissions import CanLocalize, caller_kind
from navigation.services import placematch
from navigation.services.placematch import MAX_UPLOAD_BYTES, EngineError

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
        summary="Match one camera frame to reference photos",
        description=(
            "Multipart `image` (JPEG, at most 3 MB and 4096 px) and `meta` JSON. Query "
            "`backend=auto|megaloc|vertex`, `verify`, `second_opinion`. Returns the engine's "
            "MegaLoc-first decision, raw cosine candidates (never percentages), backend_used, "
            "fallback_used, thresholds_id and timings. Frames are not stored."
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
        backend = request.query_params.get("backend", "auto")
        if backend not in {"auto", "megaloc", "vertex"}:
            return Response({"backend": "Use auto, megaloc or vertex."}, status=400)
        flags = {
            name: request.query_params.get(name, "false").lower() == "true"
            for name in ("verify", "second_opinion")
        }
        try:
            body = placematch.match(
                image,
                {k: v for k, v in meta.validated_data.items() if v is not None},
                backend=backend,
                **flags,
            )
        except EngineError as exc:
            return _engine_error(exc)
        return Response({**body, "caller": caller_kind(request)})


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
