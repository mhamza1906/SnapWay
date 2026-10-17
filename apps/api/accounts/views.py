"""Session identity endpoints for the Angular contributor workspace."""

from django.contrib.auth import logout
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import ensure_csrf_cookie
from drf_spectacular.utils import extend_schema
from maps.services.membership import list_active_memberships
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .serializers import SessionIdentitySerializer


def _user_payload(user):
    memberships = [
        {"target_id": row.target_id, "role": row.role} for row in list_active_memberships(user)
    ]
    return {
        "authenticated": True,
        "id": user.pk,
        "username": user.get_username(),
        "email": user.email or "",
        "is_staff": user.is_staff,
        "is_superuser": user.is_superuser,
        "memberships": memberships,
    }


@extend_schema(
    summary="Current session identity",
    description=(
        "Returns the authenticated Django user for the browser session, or "
        "`authenticated: false` when anonymous. Active map Membership roles are "
        "listed read-only; clients must never send a role to authorize writes."
    ),
    responses={200: SessionIdentitySerializer},
)
@api_view(["GET"])
@permission_classes([AllowAny])
@ensure_csrf_cookie
@never_cache
def me(request):
    user = request.user
    if not user.is_authenticated:
        return Response({"authenticated": False})
    return Response(_user_payload(user))


@extend_schema(
    summary="End the browser session",
    request=None,
    responses={200: SessionIdentitySerializer},
)
@api_view(["POST"])
@permission_classes([AllowAny])
def logout_view(request):
    logout(request)
    return Response({"authenticated": False})
