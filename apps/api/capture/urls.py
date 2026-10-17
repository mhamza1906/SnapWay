from django.urls import re_path

from . import views

UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

# Contract paths have no trailing slash; a trailing slash is also accepted.
urlpatterns = [
    re_path(r"^me/?$", views.MeView.as_view(), name="capture-me"),
    re_path(r"^sessions/?$", views.SessionListView.as_view(), name="capture-sessions"),
    re_path(
        rf"^sessions/(?P<session_id>{UUID})/?$", views.SessionView.as_view(), name="capture-session"
    ),
    re_path(
        rf"^sessions/(?P<session_id>{UUID})/points/(?P<point_id>{UUID})/?$",
        views.PointView.as_view(),
        name="capture-point",
    ),
    re_path(
        rf"^sessions/(?P<session_id>{UUID})/revision-check/?$",
        views.RevisionCheckView.as_view(),
        name="capture-revision-check",
    ),
    re_path(
        rf"^points/(?P<point_id>{UUID})/photos/(?P<photo_id>{UUID})/?$",
        views.PhotoView.as_view(),
        name="capture-photo",
    ),
    re_path(
        rf"^photos/(?P<photo_id>{UUID})/(?P<variant>thumbnail|display)/?$",
        views.PhotoImageView.as_view(),
        name="capture-photo-image",
    ),
]
