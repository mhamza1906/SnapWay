from django.urls import path

from . import views

urlpatterns = [
    path("me/", views.me, name="auth-me"),
    path("logout/", views.logout_view, name="auth-logout"),
]
