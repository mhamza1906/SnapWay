from django.urls import path

from maps.views import PublicBuildingListView, TargetAccessView
from maps.views_graph import (
    EdgeCollectionView,
    EdgeDetailView,
    EnsureDraftView,
    GraphListView,
    NodeCollectionView,
    NodeDetailView,
    NodePhotoCollectionView,
    PhotoDetailView,
    RevisionIndexView,
    UnderlayUploadView,
)

urlpatterns = [
    path("public/buildings/", PublicBuildingListView.as_view(), name="public-buildings"),
    path(
        "targets/<uuid:target_id>/access/",
        TargetAccessView.as_view(),
        name="map-target-access",
    ),
    path("drafts/ensure/", EnsureDraftView.as_view(), name="map-draft-ensure"),
    path(
        "revisions/<uuid:revision_id>/graph/",
        GraphListView.as_view(),
        name="map-revision-graph",
    ),
    path(
        "revisions/<uuid:revision_id>/nodes/",
        NodeCollectionView.as_view(),
        name="map-revision-nodes",
    ),
    path(
        "revisions/<uuid:revision_id>/nodes/<uuid:node_id>/",
        NodeDetailView.as_view(),
        name="map-revision-node-detail",
    ),
    path(
        "revisions/<uuid:revision_id>/nodes/<uuid:node_id>/photos/",
        NodePhotoCollectionView.as_view(),
        name="map-revision-node-photos",
    ),
    path(
        "revisions/<uuid:revision_id>/photos/<uuid:photo_id>/",
        PhotoDetailView.as_view(),
        name="map-revision-photo-detail",
    ),
    path(
        "revisions/<uuid:revision_id>/edges/",
        EdgeCollectionView.as_view(),
        name="map-revision-edges",
    ),
    path(
        "revisions/<uuid:revision_id>/edges/<uuid:edge_id>/",
        EdgeDetailView.as_view(),
        name="map-revision-edge-detail",
    ),
    path(
        "revisions/<uuid:revision_id>/underlay/",
        UnderlayUploadView.as_view(),
        name="map-revision-underlay",
    ),
    path(
        "revisions/<uuid:revision_id>/index/",
        RevisionIndexView.as_view(),
        name="map-revision-index",
    ),
]
