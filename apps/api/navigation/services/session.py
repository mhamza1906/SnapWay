"""Create and resolve visitor NavigationSession records (destination before first photo)."""

from __future__ import annotations

import secrets
from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from maps.models import Node, Publication

from navigation.authentication import token_digest
from navigation.models import NavigationSession

SESSION_TTL = timedelta(hours=4)


class SessionError(Exception):
    def __init__(self, code: str, detail: str, status: int = 400):
        self.code = code
        self.detail = detail
        self.status = status
        super().__init__(detail)


def resolve_destination(*, publication: Publication, destination_stable_id) -> Node:
    """Map public discovery id (Node.stable_id) to the Node PK on this publication revision."""
    try:
        node = Node.objects.select_related("room").get(
            revision_id=publication.revision_id,
            stable_id=destination_stable_id,
        )
    except Node.DoesNotExist as exc:
        raise SessionError(
            "unknown_destination",
            "No destination node with that stable_id on this publication revision.",
        ) from exc
    if node.kind != Node.Kind.ROOM:
        raise SessionError(
            "invalid_destination",
            "Destination must be a room node (public destinations use room stable_id).",
        )
    return node


@transaction.atomic
def create_session(*, publication_id, destination_stable_id) -> tuple[NavigationSession, str]:
    """Pin publication + destination; return session and one-time plaintext secret."""
    try:
        publication = (
            Publication.objects.select_related("revision", "target")
            .filter(
                pk=publication_id,
                is_current=True,
                invalidated_at__isnull=True,
                target__status="open",
            )
            .get()
        )
    except Publication.DoesNotExist as exc:
        raise SessionError(
            "unknown_publication",
            "Publication is missing, not current, or invalidated.",
            status=404,
        ) from exc

    destination = resolve_destination(
        publication=publication, destination_stable_id=destination_stable_id
    )
    secret = secrets.token_urlsafe(32)
    session = NavigationSession.objects.create(
        publication=publication,
        revision_id=publication.revision_id,
        token_hash=token_digest(secret),
        expires_at=timezone.now() + SESSION_TTL,
        destination=destination,
        context_version=0,
    )
    return session, secret


def session_public_payload(session: NavigationSession, *, secret: str | None = None) -> dict:
    destination = session.destination
    body = {
        "session_id": str(session.id),
        "publication_id": str(session.publication_id),
        "revision_id": str(session.revision_id),
        "context_version": session.context_version,
        "expires_at": session.expires_at.isoformat(),
        "destination_node_id": str(destination.id) if destination else None,
        "destination_stable_id": str(destination.stable_id) if destination else None,
        "destination_label": (destination.label if destination else "") or "",
    }
    if secret is not None:
        body["secret"] = secret
    return body
