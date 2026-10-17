"""Application-owned map roles. Google identity never grants map authority."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone

from maps.models import MapTarget, Membership

User = get_user_model()


def get_active_membership(user, target: MapTarget) -> Membership | None:
    if user is None or not getattr(user, "is_authenticated", False):
        return None
    return (
        Membership.objects.filter(user=user, target=target, revoked_at__isnull=True)
        .select_related("target", "user")
        .first()
    )


def user_has_role(user, target: MapTarget, roles: set[str] | frozenset[str]) -> bool:
    membership = get_active_membership(user, target)
    return membership is not None and membership.role in roles


def require_role(user, target: MapTarget, roles: set[str] | frozenset[str]) -> Membership:
    membership = get_active_membership(user, target)
    if membership is None or membership.role not in roles:
        raise PermissionDenied("Map membership does not allow this action.")
    return membership


def list_active_memberships(user) -> list[Membership]:
    if user is None or not getattr(user, "is_authenticated", False):
        return []
    return list(
        Membership.objects.filter(user=user, revoked_at__isnull=True)
        .select_related("target")
        .order_by("created_at")
    )


@transaction.atomic
def grant_membership(
    *,
    target: MapTarget,
    user,
    role: str,
    granted_by,
) -> Membership:
    if role not in Membership.Role.values:
        raise ValidationError({"role": f"Invalid role: {role}"})
    if not _actor_may_manage_memberships(granted_by, target):
        raise PermissionDenied(
            "Only a map administrator or Django staff (bootstrap) may grant membership."
        )

    existing = Membership.objects.select_for_update().filter(target=target, user=user).first()
    if existing is None:
        return Membership.objects.create(
            target=target,
            user=user,
            role=role,
            granted_by=granted_by,
        )
    existing.role = role
    existing.granted_by = granted_by
    existing.revoked_at = None
    existing.save(update_fields=["role", "granted_by", "revoked_at"])
    return existing


@transaction.atomic
def revoke_membership(*, target: MapTarget, user, actor) -> Membership:
    if not _actor_may_manage_memberships(actor, target):
        raise PermissionDenied(
            "Only a map administrator or Django staff (bootstrap) may revoke membership."
        )
    membership = Membership.objects.select_for_update().filter(target=target, user=user).first()
    if membership is None:
        raise ValidationError({"user": "No membership exists for this user on the target."})
    if membership.revoked_at is not None:
        return membership
    membership.revoked_at = timezone.now()
    membership.save(update_fields=["revoked_at"])
    return membership


def _actor_may_manage_memberships(actor, target: MapTarget) -> bool:
    """Map admin always; Django staff is a controlled bootstrap/ops escape hatch only."""
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    if actor.is_staff or actor.is_superuser:
        return True
    return user_has_role(actor, target, {Membership.Role.ADMIN})
