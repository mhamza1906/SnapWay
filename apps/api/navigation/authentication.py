"""Visitor navigation capability and development token authentication.

Visitors use published maps without a developer login (architecture: scoped navigation
capability). A ``NavigationSession`` stores only the SHA-256 digest of a random secret; the
app sends ``Authorization: Navigation <secret>``. The iOS debug build may instead send
``Authorization: Bearer <PLACEMATCH_DEV_TOKEN>``, accepted only while ``DEBUG`` is true.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass

from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.db.models import Q
from django.utils import timezone
from drf_spectacular.extensions import OpenApiAuthenticationExtension
from rest_framework import exceptions
from rest_framework.authentication import BaseAuthentication, get_authorization_header

from navigation.models import NavigationSession


@dataclass(frozen=True)
class DevToken:
    """Marker for the development-only bearer token (no user, no map scope)."""

    kind: str = "dev_token"


def token_digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def active_session(secret: str) -> NavigationSession | None:
    now = timezone.now()
    return (
        NavigationSession.objects.select_related("publication")
        .filter(token_hash=token_digest(secret), expires_at__gt=now, invalidated_at__isnull=True)
        .filter(Q(publication__invalidated_at__isnull=True))
        .first()
    )


class NavigationCapabilityAuthentication(BaseAuthentication):
    keyword = b"navigation"

    def authenticate(self, request):
        parts = get_authorization_header(request).split()
        if not parts or parts[0].lower() != self.keyword:
            return None
        if len(parts) != 2:
            raise exceptions.AuthenticationFailed("Invalid navigation capability header.")
        session = active_session(parts[1].decode("ascii", errors="ignore"))
        if session is None:
            raise exceptions.AuthenticationFailed("Navigation session is invalid or expired.")
        return AnonymousUser(), session

    def authenticate_header(self, request):
        return "Navigation"


class DevTokenAuthentication(BaseAuthentication):
    keyword = b"bearer"

    def authenticate(self, request):
        parts = get_authorization_header(request).split()
        if not parts or parts[0].lower() != self.keyword:
            return None
        expected = settings.PLACEMATCH_DEV_TOKEN
        if not settings.DEBUG or len(expected) < 24:
            raise exceptions.AuthenticationFailed("Bearer tokens are not accepted here.")
        if len(parts) != 2 or not hmac.compare_digest(parts[1], expected.encode()):
            raise exceptions.AuthenticationFailed("Invalid token.")
        return AnonymousUser(), DevToken()

    def authenticate_header(self, request):
        return "Bearer"


class NavigationCapabilityScheme(OpenApiAuthenticationExtension):
    target_class = "navigation.authentication.NavigationCapabilityAuthentication"
    name = "navigationCapability"

    def get_security_definition(self, auto_schema):
        return {
            "type": "apiKey",
            "in": "header",
            "name": "Authorization",
            "description": "`Navigation <secret>` from an active visitor navigation session.",
        }


class DevTokenScheme(OpenApiAuthenticationExtension):
    target_class = "navigation.authentication.DevTokenAuthentication"
    name = "placematchDevToken"

    def get_security_definition(self, auto_schema):
        return {
            "type": "http",
            "scheme": "bearer",
            "description": "PLACEMATCH_DEV_TOKEN; accepted only while DEBUG is true.",
        }
