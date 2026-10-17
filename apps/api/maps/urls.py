from django.urls import path

from maps.views import TargetAccessView

urlpatterns = [
    path(
        "targets/<uuid:target_id>/access/",
        TargetAccessView.as_view(),
        name="map-target-access",
    ),
]
