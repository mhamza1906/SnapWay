"""Diagnostic map access endpoint; product map CRUD arrives in a later story."""

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema
from rest_framework.response import Response
from rest_framework.views import APIView

from maps.models import MapTarget
from maps.permissions import IsAuthenticatedMapMember
from maps.services.membership import get_active_membership


class TargetAccessView(APIView):
    """Smoke/diagnostic: returns the caller's active role on a target."""

    permission_classes = [IsAuthenticatedMapMember]

    def get_map_target(self):
        return get_object_or_404(MapTarget, pk=self.kwargs["target_id"])

    @extend_schema(
        summary="Diagnostic map access check",
        description=(
            "Returns the authenticated caller's active Membership role for the "
            "target. Not a product UI surface; used for AUTH checks and smoke tests."
        ),
        responses={
            200: {
                "type": "object",
                "properties": {
                    "target_id": {"type": "string", "format": "uuid"},
                    "role": {"type": "string", "enum": ["admin", "volunteer"]},
                },
            }
        },
    )
    def get(self, request, target_id):
        target = self.get_map_target()
        membership = get_active_membership(request.user, target)
        return Response({"target_id": str(target.id), "role": membership.role})
