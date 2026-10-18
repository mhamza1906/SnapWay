"""Visitor session bootstrap and published photo-route transport."""

import secrets
from datetime import timedelta

from django.core import signing
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from maps.models import Publication
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from navigation.authentication import token_digest
from navigation.models import NavigationSession
from navigation.services.routing import RouteUnavailable, published_route

LOCATION_SALT = "navigation.photo-location.v1"


def location_token(body):
    decision = body.get("decision") or {}
    if decision.get("outcome") != "likely_match":
        return None
    node_id = decision.get("node_id") or decision.get("location_id")
    revision_id = decision.get("revision_id")
    if not node_id or not revision_id:
        return None
    return signing.dumps({"node_id": node_id, "revision_id": revision_id}, salt=LOCATION_SALT)


class SessionInput(serializers.Serializer):
    publication_id = serializers.UUIDField()


class RouteInput(SessionInput):
    destination_id = serializers.UUIDField()
    localization_token = serializers.CharField(max_length=2048)
    preference = serializers.ChoiceField(
        choices=["any", "avoid_stairs", "avoid_elevators"], default="any"
    )


class VisitorPublicView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "localization"

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response


class VisitorSessionView(VisitorPublicView):
    @extend_schema(request=SessionInput, responses={201: OpenApiTypes.OBJECT})
    def post(self, request):
        data = SessionInput(data=request.data)
        data.is_valid(raise_exception=True)
        publication = get_object_or_404(
            Publication,
            pk=data.validated_data["publication_id"],
            is_current=True,
            invalidated_at__isnull=True,
            target__status="open",
        )
        secret = secrets.token_urlsafe(32)
        expires_at = timezone.now() + timedelta(minutes=30)
        NavigationSession.objects.create(
            publication=publication,
            revision_id=publication.revision_id,
            token_hash=token_digest(secret),
            expires_at=expires_at,
        )
        return Response({"token": secret, "expires_at": expires_at}, status=201)


class PhotoRouteView(VisitorPublicView):
    @extend_schema(request=RouteInput, responses={200: OpenApiTypes.OBJECT})
    def post(self, request):
        data = RouteInput(data=request.data)
        data.is_valid(raise_exception=True)
        values = data.validated_data
        try:
            location = signing.loads(
                values.pop("localization_token"), salt=LOCATION_SALT, max_age=1800
            )
        except signing.BadSignature:
            return Response(
                {"detail": "Your photo location has expired. Take another photo."}, status=400
            )
        try:
            result = published_route(
                start_node_id=location["node_id"],
                start_revision_id=location["revision_id"],
                **values,
            )
        except RouteUnavailable as exc:
            return Response({"detail": str(exc)}, status=409)
        return Response(result)
