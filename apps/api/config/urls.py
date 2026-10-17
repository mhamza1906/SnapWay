from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

from .views import client_config, liveness, readiness

urlpatterns = [
    path("api/client-config/", client_config, name="client-config"),
    path("api/health/live/", liveness, name="liveness"),
    path("api/health/ready/", readiness, name="readiness"),
    path("api/auth/", include("accounts.urls")),
    path("api/maps/", include("maps.urls")),
    path("api/navigation/", include("navigation.urls")),
    path("accounts/", include("allauth.urls")),
    path("admin/", admin.site.urls),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
