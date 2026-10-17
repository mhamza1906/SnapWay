from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.urls import include, path

from .views import liveness, readiness

urlpatterns = [
    path("api/health/live/", liveness, name="liveness"),
    path("api/health/ready/", readiness, name="readiness"),
    path("api/capture/", include("capture.urls")),
    # allauth is installed but not in INSTALLED_APPS; contributors use Django's auth views.
    path(
        "accounts/login/",
        auth_views.LoginView.as_view(redirect_authenticated_user=True),
        name="login",
    ),
    path("accounts/logout/", auth_views.LogoutView.as_view(), name="logout"),
    path("admin/", admin.site.urls),
]
