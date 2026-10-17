from django.urls import path

from . import views

urlpatterns = [
    path("google/start/", views.google_login_start, name="auth-google-start"),
    path("mode/", views.switch_mode, name="auth-mode"),
    path("me/", views.me, name="auth-me"),
    path("logout/", views.logout_view, name="auth-logout"),
]
