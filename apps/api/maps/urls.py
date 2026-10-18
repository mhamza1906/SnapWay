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
from maps.views_optimize import (
    OptimizeRegenerateView,
    OptimizeStatusView,
    OptimizeUploadView,
    VectorizeDemoView,
)
from maps.views_workspace import (
    ContributionDetailView,
    ContributionListView,
    EditMapView,
    MapExportView,
    PipelineImportView,
    SubmissionView,
    TargetLifecycleView,
    WorkspaceActivityView,
    WorkspaceBuildingsView,
    WorkspaceMapsView,
)

urlpatterns = [
    path("workspace/", WorkspaceMapsView.as_view()),
    path("workspace/buildings/", WorkspaceBuildingsView.as_view()),
    path("workspace/activity/", WorkspaceActivityView.as_view()),
    path("workspace/contributions/", ContributionListView.as_view()),
    path("workspace/contributions/<uuid:contribution_id>/", ContributionDetailView.as_view()),
    path("workspace/contributions/<uuid:contribution_id>/submit/", SubmissionView.as_view()),
    path("workspace/contributions/<uuid:contribution_id>/pipeline/", PipelineImportView.as_view()),
    path("workspace/targets/<uuid:target_id>/edit/", EditMapView.as_view()),
    path("workspace/targets/<uuid:target_id>/optimize/", OptimizeStatusView.as_view()),
    path("workspace/targets/<uuid:target_id>/optimize/upload/", OptimizeUploadView.as_view()),
    path(
        "workspace/targets/<uuid:target_id>/optimize/regenerate/",
        OptimizeRegenerateView.as_view(),
    ),
    path(
        "workspace/targets/<uuid:target_id>/vectorize-demo/",
        VectorizeDemoView.as_view(),
    ),
    path("workspace/targets/<uuid:target_id>/archive/", TargetLifecycleView.as_view()),
    path("workspace/targets/<uuid:target_id>/export/", MapExportView.as_view()),
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
