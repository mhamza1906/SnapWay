"""REST surfaces for draft bootstrap and graph Node/Edge editing."""

from django.shortcuts import get_object_or_404
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from maps.models import MapTarget, Membership, Revision
from maps.permissions import IsAuthenticatedMapMember
from maps.services.draft import ensure_demo_draft
from maps.services.graph import (
    GraphError,
    GraphPermissionError,
    add_edge,
    add_node,
    list_graph,
    remove_edge,
    remove_node,
    update_node,
)
from maps.services.membership import get_active_membership
from maps.services.reference_index import build_reference_index, get_index_status
from maps.services.references import (
    PhotoStorageUnavailable,
    attach_node_photo,
    list_node_photos,
    remove_node_photo,
)
from maps.services.underlay import store_underlay_file


def _error_response(exc: Exception):
    if isinstance(exc, PhotoStorageUnavailable):
        return Response({"detail": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
    if isinstance(exc, GraphPermissionError | PermissionError):
        return Response({"detail": str(exc)}, status=status.HTTP_403_FORBIDDEN)
    if isinstance(exc, GraphError | ValueError):
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    if isinstance(exc, MapTarget.DoesNotExist | Revision.DoesNotExist):
        return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
    raise exc


class EnsureDraftView(APIView):
    """POST /api/maps/drafts/ensure/ — create or resume editable draft."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        """List this contributor's writable maps for phone collection; no writes."""
        from maps.models import Contribution

        drafts = []
        for contribution in (
            Contribution.objects.filter(
                author=request.user,
                status=Contribution.Status.DRAFT,
                head_revision__isnull=False,
                head_revision__frozen_at__isnull=True,
                target__status=MapTarget.Status.OPEN,
            )
            .select_related("target__floor", "head_revision")
            .order_by("-created_at")
        ):
            membership = get_active_membership(request.user, contribution.target)
            if membership and membership.role in ("admin", "volunteer"):
                drafts.append(
                    {
                        "target_id": str(contribution.target_id),
                        "title": contribution.target.title,
                        "floor": contribution.target.floor.name,
                    }
                )
        return Response({"drafts": drafts})

    @extend_schema(
        summary="Ensure demo draft contribution + unfrozen revision",
        request=inline_serializer(
            "EnsureDraftRequest",
            {
                "target_id": serializers.UUIDField(required=False, allow_null=True),
                "force_new": serializers.BooleanField(required=False),
            },
        ),
        responses={200: OpenApiTypes.OBJECT},
    )
    def post(self, request):
        target_id = request.data.get("target_id") or None
        force_new = bool(request.data.get("force_new"))
        try:
            payload = ensure_demo_draft(request.user, target_id=target_id, force_new=force_new)
        except Exception as exc:  # noqa: BLE001 — mapped below
            return _error_response(exc)
        return Response(
            {
                "target_id": str(payload["target_id"]),
                "contribution_id": str(payload["contribution_id"]),
                "revision_id": str(payload["revision_id"]),
                "coordinate_frame": payload["coordinate_frame"],
                "underlay_url": payload["underlay_url"],
            },
            status=status.HTTP_200_OK,
        )


class RevisionGraphMixin:
    permission_classes = [IsAuthenticatedMapMember]

    def get_revision(self):
        return get_object_or_404(
            Revision.objects.select_related("target", "source_asset"),
            pk=self.kwargs["revision_id"],
        )

    def get_map_target(self):
        return self.get_revision().target


class GraphListView(RevisionGraphMixin, APIView):
    @extend_schema(
        summary="List nodes and edges for a revision",
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request, revision_id):
        revision = self.get_revision()
        return Response(list_graph(revision))


class NodeCollectionView(RevisionGraphMixin, APIView):
    @extend_schema(
        summary="Add a waypoint node",
        request=inline_serializer(
            "AddNodeRequest",
            {
                "x": serializers.FloatField(),
                "y": serializers.FloatField(),
                "label": serializers.CharField(required=False, allow_blank=True),
                "kind": serializers.CharField(required=False),
            },
        ),
        responses={201: OpenApiTypes.OBJECT},
    )
    def post(self, request, revision_id):
        revision = self.get_revision()
        try:
            node = add_node(
                revision,
                x=request.data.get("x"),
                y=request.data.get("y"),
                label=request.data.get("label") or "",
                kind=request.data.get("kind") or "checkpoint",
                actor=request.user,
            )
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(
            {
                "id": str(node.id),
                "x": float(node.x),
                "y": float(node.y),
                "label": node.label,
                "kind": node.kind,
            },
            status=status.HTTP_201_CREATED,
        )


class NodeDetailView(RevisionGraphMixin, APIView):
    @extend_schema(
        summary="Update a node label",
        request=inline_serializer(
            "UpdateNodeRequest",
            {"label": serializers.CharField(allow_blank=True)},
        ),
        responses={200: OpenApiTypes.OBJECT},
    )
    def patch(self, request, revision_id, node_id):
        revision = self.get_revision()
        if "label" not in request.data:
            return Response({"detail": "label is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            node = update_node(
                revision,
                node_id=node_id,
                label=request.data.get("label") or "",
                actor=request.user,
            )
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(
            {
                "id": str(node.id),
                "x": float(node.x),
                "y": float(node.y),
                "label": node.label,
                "kind": node.kind,
            }
        )

    @extend_schema(
        summary="Remove a node and incident edges",
        responses={204: OpenApiTypes.NONE},
    )
    def delete(self, request, revision_id, node_id):
        revision = self.get_revision()
        try:
            remove_node(revision, node_id=node_id, actor=request.user)
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(status=status.HTTP_204_NO_CONTENT)


class NodePhotoCollectionView(RevisionGraphMixin, APIView):
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    @extend_schema(
        summary="List reference photos for a node",
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request, revision_id, node_id):
        revision = self.get_revision()
        try:
            photos = list_node_photos(revision, node_id=node_id, actor=request.user)
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response({"photos": photos})

    @extend_schema(
        summary="Attach a reference photo to a node",
        request={
            "multipart/form-data": inline_serializer(
                "AttachNodePhotoRequest",
                {
                    "file": serializers.FileField(),
                    "direction": serializers.ChoiceField(
                        choices=["front", "right", "back", "left"], required=False
                    ),
                },
            )
        },
        responses={201: OpenApiTypes.OBJECT},
    )
    def post(self, request, revision_id, node_id):
        revision = self.get_revision()
        uploaded = request.FILES.get("file")
        if uploaded is None:
            return Response({"detail": "file is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            payload = attach_node_photo(
                revision,
                node_id=node_id,
                uploaded_file=uploaded,
                actor=request.user,
                content_type=uploaded.content_type,
                direction=request.data.get("direction") or None,
            )
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(payload, status=status.HTTP_201_CREATED)


class PhotoDetailView(RevisionGraphMixin, APIView):
    @extend_schema(
        summary="Remove a reference photo",
        responses={204: OpenApiTypes.NONE},
    )
    def delete(self, request, revision_id, photo_id):
        revision = self.get_revision()
        try:
            remove_node_photo(revision, reference_id=photo_id, actor=request.user)
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(status=status.HTTP_204_NO_CONTENT)


class RevisionIndexView(RevisionGraphMixin, APIView):
    """Developer/contributor MegaLoc index for reference photos on a revision."""

    @extend_schema(
        summary="Get MegaLoc reference index status for a revision",
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request, revision_id):
        revision = self.get_revision()
        try:
            payload = get_index_status(revision, actor=request.user)
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(payload)

    @extend_schema(
        summary="Build or refresh MegaLoc reference index for a revision",
        request=None,
        responses={200: OpenApiTypes.OBJECT},
    )
    def post(self, request, revision_id):
        revision = self.get_revision()
        try:
            payload = build_reference_index(revision, actor=request.user)
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(payload)


class EdgeCollectionView(RevisionGraphMixin, APIView):
    @extend_schema(
        summary="Add a graph edge",
        request=inline_serializer(
            "AddEdgeRequest",
            {
                "from_node_id": serializers.UUIDField(),
                "to_node_id": serializers.UUIDField(),
            },
        ),
        responses={201: OpenApiTypes.OBJECT},
    )
    def post(self, request, revision_id):
        revision = self.get_revision()
        try:
            edge = add_edge(
                revision,
                from_id=request.data.get("from_node_id"),
                to_id=request.data.get("to_node_id"),
                actor=request.user,
            )
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(
            {
                "id": str(edge.id),
                "from_node_id": str(edge.from_node_id),
                "to_node_id": str(edge.to_node_id),
                "cost": float(edge.cost),
            },
            status=status.HTTP_201_CREATED,
        )


class EdgeDetailView(RevisionGraphMixin, APIView):
    @extend_schema(
        summary="Remove an edge",
        responses={204: OpenApiTypes.NONE},
    )
    def delete(self, request, revision_id, edge_id):
        revision = self.get_revision()
        try:
            remove_edge(revision, edge_id=edge_id, actor=request.user)
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(status=status.HTTP_204_NO_CONTENT)


class UnderlayUploadView(RevisionGraphMixin, APIView):
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    @extend_schema(
        summary="Upload display underlay for a revision",
        request={
            "multipart/form-data": inline_serializer(
                "UnderlayUploadRequest",
                {"file": serializers.FileField()},
            )
        },
        responses={201: OpenApiTypes.OBJECT},
    )
    def post(self, request, revision_id):
        revision = self.get_revision()
        uploaded = request.FILES.get("file")
        if uploaded is None:
            return Response({"detail": "file is required."}, status=status.HTTP_400_BAD_REQUEST)
        membership = get_active_membership(request.user, revision.target)
        if membership is None or membership.role not in {
            Membership.Role.ADMIN,
            Membership.Role.VOLUNTEER,
        }:
            return Response({"detail": "Volunteer or admin membership is required."}, status=403)
        try:
            payload = store_underlay_file(
                revision,
                uploaded_file=uploaded,
                actor=request.user,
                content_type=uploaded.content_type,
            )
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(payload, status=status.HTTP_201_CREATED)
