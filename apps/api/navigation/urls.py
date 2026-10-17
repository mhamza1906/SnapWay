from django.urls import path

from navigation.views import (
    LocalizationHealthView,
    LocalizeView,
    MegaLocIndexView,
    ReferenceThumbnailView,
)

urlpatterns = [
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
