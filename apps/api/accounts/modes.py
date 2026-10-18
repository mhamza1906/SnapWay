"""Session experience modes, separate from database-owned map authority."""

from rest_framework.permissions import BasePermission

MODES = ("developer", "public")
MODE_KEY = "snapway_mode"


def current_mode(request):
    mode = request.session.get(MODE_KEY)
    return mode if mode in MODES else "public"


class IsDeveloperMode(BasePermission):
    message = "Switch to Developer mode to access the mapping workspace."

    def has_permission(self, request, view):
        return bool(request.user.is_authenticated and current_mode(request) == "developer")
