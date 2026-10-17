import logging

from django.conf import settings
from django.db import DatabaseError, connection
from drf_spectacular.utils import extend_schema
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

logger = logging.getLogger(__name__)


@extend_schema(exclude=True)
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def liveness(request):
    """Process liveness, deliberately independent of database/provider readiness."""
    return Response({"service": "snapway-api", "status": "ok", "release": settings.APP_RELEASE})


@extend_schema(exclude=True)
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def readiness(request):
    """Framework readiness only; product queues/indexes will add their own checks."""
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
        # Ensure the initial auth migrations exist, not just an available SQL listener.
        from accounts.models import User

        User.objects.exists()
    except DatabaseError:
        logger.warning("Database readiness check failed")
        return Response(
            {"status": "unavailable", "checks": {"database": "unavailable"}}, status=503
        )
    return Response({"status": "ready", "checks": {"database": "ok"}})
