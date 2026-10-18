"""Public building discovery, visitor metadata directory and target access checks."""

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from maps.models import Building, MapTarget, Publication
from maps.permissions import IsAuthenticatedMapMember
from maps.services.membership import get_active_membership


class PublicBuildingListView(APIView):
    """Public discovery metadata only, never draft geometry or private membership."""

    authentication_classes = []
    permission_classes = [AllowAny]
    include_directory = False

    @staticmethod
    def building_metadata(building):
        return {
            "id": str(building.id),
            "name": building.name,
            "place_id": building.google_place_id,
            "slug": building.slug,
            "address": building.address,
            "latitude": float(building.latitude),
            "longitude": float(building.longitude),
            "floors": [],
        }

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
        if self.include_directory:
            directory = (
                Building.objects.filter(
                    latitude__isnull=False,
                    longitude__isnull=False,
                    floors__target__status=MapTarget.Status.OPEN,
                )
                .distinct()
                .prefetch_related("floors__target")
                .order_by("name", "id")
            )
            for building in directory:
                entry = self.building_metadata(building)
                for floor in sorted(
                    building.floors.all(), key=lambda row: (row.sort_order, row.code)
                ):
                    target = getattr(floor, "target", None)
                    if target is None or target.status != MapTarget.Status.OPEN:
                        continue
                    entry["floors"].append(
                        {
                            "target_id": str(target.id),
                            "name": floor.name,
                            "code": floor.code,
                            "publication_id": None,
                            "sequence": None,
                            "checkpoints": [],
                            "destinations": [],
                        }
                    )
                buildings[str(building.id)] = entry
        for publication in publications:
            target = publication.target
            floor = target.floor
            building = floor.building
            entry = buildings.setdefault(
                str(building.id),
                self.building_metadata(building),
            )
            published_floor = {
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
            existing = next(
                (row for row in entry["floors"] if row["target_id"] == str(target.id)), None
            )
            if existing is None:
                entry["floors"].append(published_floor)
            else:
                existing.update(published_floor)
        response = Response({"buildings": list(buildings.values())})
        response["Cache-Control"] = "no-store"
        return response


class PublicBuildingDirectoryView(PublicBuildingListView):
    """Stored building/floor metadata, enriched only with published visitor content."""

    include_directory = True


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
