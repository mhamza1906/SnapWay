"""DRF permission classes backed by maps.Membership (not Django staff flags)."""

from accounts.modes import IsDeveloperMode

from maps.models import Membership
from maps.services.membership import get_active_membership, user_has_role


def _resolve_target(view, request):
    if hasattr(view, "get_map_target"):
        return view.get_map_target()
    return getattr(view, "map_target", None)


class IsAuthenticatedMapMember(IsDeveloperMode):
    """Any active membership (admin or volunteer) on the view's map target."""

    message = "Active map membership is required."

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        target = _resolve_target(view, request)
        if target is None:
            return False
        return get_active_membership(request.user, target) is not None


class IsAuthenticatedMapAdmin(IsDeveloperMode):
    """Active administrator membership on the view's map target."""

    message = "Map administrator membership is required."

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        target = _resolve_target(view, request)
        if target is None:
            return False
        return user_has_role(request.user, target, {Membership.Role.ADMIN})
