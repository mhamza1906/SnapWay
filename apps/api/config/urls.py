from django.contrib import admin
from django.urls import include, path

from .views import liveness, readiness

urlpatterns = [
    path("api/health/live/", liveness, name="liveness"),
    path("api/health/ready/", readiness, name="readiness"),
    path("api/auth/", include("accounts.urls")),
    path("accounts/", include("allauth.urls")),
    path("admin/", admin.site.urls),
]
