from django.contrib import admin
from django.urls import path

from .views import liveness, readiness

urlpatterns = [
    path("api/health/live/", liveness, name="liveness"),
    path("api/health/ready/", readiness, name="readiness"),
    path("admin/", admin.site.urls),
]
