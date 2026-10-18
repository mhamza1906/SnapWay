"""Diagnostic map access endpoint; product map CRUD arrives in a later story."""

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from maps.models import MapTarget, Publication
from maps.permissions import IsAuthenticatedMapMember
from maps.services.membership import get_active_membership


class PublicBuildingListView(APIView):
    """Public discovery metadata only, never draft geometry or private membership."""

    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(exclude=True)
    def get(self, request):
        publications = (
            Publication.objects.filter(
                is_current=True,
                invalidated_at__isnull=True,
                target__status=MapTarget.Status.OPEN,
                target__floor__building__latitude__isnull=False,
                target__floor__building__longitude__isnull=False,
            )
            .select_related("target__floor__building")
            .prefetch_related("revision__nodes__room")
            .order_by("target__floor__building__name", "target__floor__sort_order", "target_id")
        )
        buildings = {}
        for publication in publications:
            target = publication.target
            floor = target.floor
            building = floor.building
            entry = buildings.setdefault(
                str(building.id),
                {
                    "id": str(building.id),
                    "name": building.name,
                    "place_id": building.google_place_id,
                    "slug": building.slug,
                    "address": building.address,
                    "latitude": float(building.latitude),
                    "longitude": float(building.longitude),
                    "floors": [],
                },
            )
            entry["floors"].append(
                {
                    "target_id": str(target.id),
                    "name": floor.name,
                    "code": floor.code,
                    "publication_id": str(publication.id),
                    "sequence": publication.sequence,
                    "checkpoints": [
                        {"id": str(node.stable_id), "label": node.label}
                        for node in publication.revision.nodes.all()
                    ],
                    "destinations": [
                        {
                            "id": str(node.stable_id),
                            "label": node.room.number or node.room.name or node.label,
                            "name": node.room.name,
                        }
                        for node in publication.revision.nodes.all()
                        if node.kind == "room"
                        and node.room is not None
                        and node.room.revision_id == publication.revision_id
                    ],
                }
            )
        response = Response({"buildings": list(buildings.values())})
        response["Cache-Control"] = "no-store"
        return response


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
