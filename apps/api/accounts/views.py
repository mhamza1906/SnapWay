"""Session identity endpoints for the Angular contributor workspace."""

from django.contrib.auth import logout
from django.http import HttpResponseBadRequest
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.http import require_POST
from drf_spectacular.utils import extend_schema
from maps.services.membership import list_active_memberships
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from .modes import MODE_KEY, MODES, current_mode
from .serializers import ExperienceModeSerializer, SessionIdentitySerializer


def _user_payload(request):
    user = request.user
    developer = current_mode(request) == "developer"
    memberships = (
        [{"target_id": row.target_id, "role": row.role} for row in list_active_memberships(user)]
        if developer
        else []
    )
    return {
        "authenticated": True,
        "id": user.pk,
        "username": user.get_username(),
        "email": user.email or "",
        "is_staff": developer and user.is_staff,
        "is_superuser": developer and user.is_superuser,
        "memberships": memberships,
        "mode": current_mode(request),
        "available_modes": list(MODES),
        "can_admin": developer
        and (user.is_staff or user.is_superuser or any(m["role"] == "admin" for m in memberships)),
    }


@extend_schema(
    summary="Current session identity",
    description=(
        "Returns the authenticated Django user for the browser session, or "
        "`authenticated: false` when anonymous. Developer mode includes read-only "
        "map memberships; Public User mode hides workspace permissions. Mode "
        "selection never grants staff or map administrator authority."
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
    return Response(_user_payload(request))


@require_POST
@csrf_protect
@never_cache
def google_login_start(request):
    """Validate a mode and start the existing Google PKCE flow in one form POST."""
    from allauth.socialaccount.providers.google.views import oauth2_login

    if request.POST.get("mode") not in MODES:
        return HttpResponseBadRequest("Choose Developer or Public User to continue.")
    # Always land on the retained welcome page after checking the new session.
    # The client cannot substitute an external callback or privileged landing page.
    data = request.POST.copy()
    data["next"] = "/auth/complete"
    request.POST = data
    return oauth2_login(request)


@extend_schema(request=ExperienceModeSerializer, responses={200: SessionIdentitySerializer})
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@never_cache
def switch_mode(request):
    serializer = ExperienceModeSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    request.session[MODE_KEY] = serializer.validated_data["mode"]
    return Response(_user_payload(request))


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
