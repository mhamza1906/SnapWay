from django.urls import path

from navigation.views import (
    LocalizationHealthView,
    LocalizeView,
    MegaLocIndexView,
    ReferenceThumbnailView,
)
from navigation.views_connections import FloorConnectionView
from navigation.views_routing import PhotoRouteView, VisitorSessionView

urlpatterns = [
    path("floor-connections/", FloorConnectionView.as_view(), name="floor-connections"),
    path("sessions/", VisitorSessionView.as_view(), name="visitor-session"),
    path("photo-route/", PhotoRouteView.as_view(), name="photo-route"),
    path("localize/health/", LocalizationHealthView.as_view(), name="localize-health"),
    path("localize/", LocalizeView.as_view(), name="localize"),
    path(
        "localize/references/<str:reference_set>/thumb/<path:reference_id>",
        ReferenceThumbnailView.as_view(),
        name="localize-thumb",
    ),
    path(
        "localize/references/<str:reference_set>/megaloc-index/",
        MegaLocIndexView.as_view(),
        name="localize-megaloc-index",
    ),
]
