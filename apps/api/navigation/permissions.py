"""Who may ask the localization service where a frame was taken."""

from rest_framework.permissions import BasePermission

from navigation.authentication import DevToken
from navigation.models import NavigationSession


class CanLocalize(BasePermission):
    """A signed-in user, an active visitor navigation session, or the DEBUG dev token."""

    message = "Sign in, or use an active navigation session, to localize a photo."

    def has_permission(self, request, view):
        if request.user and request.user.is_authenticated:
            return True
        return isinstance(request.auth, (NavigationSession, DevToken))


def caller_kind(request) -> str:
    if isinstance(request.auth, NavigationSession):
        return "navigation_session"
    if isinstance(request.auth, DevToken):
        return "dev_token"
    return "user"
