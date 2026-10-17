"""REST surfaces for draft bootstrap and graph Node/Edge editing."""

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema
from rest_framework import status
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
from maps.services.references import attach_node_photo, list_node_photos, remove_node_photo
from maps.services.underlay import store_underlay_file


def _error_response(exc: Exception):
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

    @extend_schema(summary="Ensure demo draft contribution + unfrozen revision")
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
    @extend_schema(summary="List nodes and edges for a revision")
    def get(self, request, revision_id):
        revision = self.get_revision()
        return Response(list_graph(revision))


class NodeCollectionView(RevisionGraphMixin, APIView):
    @extend_schema(summary="Add a waypoint node")
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
    @extend_schema(summary="Update a node label")
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

    @extend_schema(summary="Remove a node and incident edges")
    def delete(self, request, revision_id, node_id):
        revision = self.get_revision()
        try:
            remove_node(revision, node_id=node_id, actor=request.user)
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(status=status.HTTP_204_NO_CONTENT)


class NodePhotoCollectionView(RevisionGraphMixin, APIView):
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    @extend_schema(summary="List reference photos for a node")
    def get(self, request, revision_id, node_id):
        revision = self.get_revision()
        try:
            photos = list_node_photos(revision, node_id=node_id, actor=request.user)
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response({"photos": photos})

    @extend_schema(summary="Attach a reference photo to a node")
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
            )
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(payload, status=status.HTTP_201_CREATED)


class PhotoDetailView(RevisionGraphMixin, APIView):
    @extend_schema(summary="Remove a reference photo")
    def delete(self, request, revision_id, photo_id):
        revision = self.get_revision()
        try:
            remove_node_photo(revision, reference_id=photo_id, actor=request.user)
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(status=status.HTTP_204_NO_CONTENT)


class EdgeCollectionView(RevisionGraphMixin, APIView):
    @extend_schema(summary="Add a graph edge")
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
    @extend_schema(summary="Remove an edge")
    def delete(self, request, revision_id, edge_id):
        revision = self.get_revision()
        try:
            remove_edge(revision, edge_id=edge_id, actor=request.user)
        except Exception as exc:  # noqa: BLE001
            return _error_response(exc)
        return Response(status=status.HTTP_204_NO_CONTENT)


class UnderlayUploadView(RevisionGraphMixin, APIView):
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    @extend_schema(summary="Upload display underlay for a revision")
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
