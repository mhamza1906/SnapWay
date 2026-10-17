"""Membership-based authorization for capture data.

Every read and write needs an active (not revoked) admin/volunteer Membership on
an open MapTarget. Sessions, their points and photos are visible to their
contributor and to target administrators; only the contributor writes them.
"""

from maps.models import MapTarget, Membership
from rest_framework.authentication import SessionAuthentication
from rest_framework.exceptions import NotFound, PermissionDenied

CAPTURE_ROLES = [Membership.Role.ADMIN, Membership.Role.VOLUNTEER]


class CaptureSessionAuthentication(SessionAuthentication):
    """Session auth with CSRF; anonymous requests get 401 so clients can redirect to login."""

    def authenticate_header(self, request):
        return "Session"


def active_memberships(user):
    return Membership.objects.filter(
        user=user,
        revoked_at__isnull=True,
        role__in=CAPTURE_ROLES,
        target__status=MapTarget.Status.OPEN,
    )


def membership_for(user, target_id):
    """The user's active membership on an open target, or 403."""
    membership = active_memberships(user).filter(target_id=target_id).first()
    if membership is None:
        raise PermissionDenied("No active capture membership for this map target.")
    return membership


def check_session(user, session, *, write=False):
    membership = membership_for(user, session.target_id)
    if session.contributor_id == user.id:
        return membership
    if not write and membership.role == Membership.Role.ADMIN:
        return membership
    raise PermissionDenied("This capture session belongs to another contributor.")


def get_or_404(queryset, **lookup):
    obj = queryset.filter(**lookup).first()
    if obj is None:
        raise NotFound()
    return obj
