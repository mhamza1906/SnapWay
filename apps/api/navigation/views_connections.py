"""Admin-only cross-floor connection authoring, separate from immutable floor edges."""

from django.core.exceptions import ValidationError
from django.db import IntegrityError
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from maps.models import Node
from maps.services.floor_connections import connect_floors
from maps.services.graph import GraphPermissionError
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


class ConnectionInput(serializers.Serializer):
    from_node_id = serializers.UUIDField()
    to_node_id = serializers.UUIDField()
    cost = serializers.DecimalField(max_digits=16, decimal_places=6, min_value=0)
    bidirectional = serializers.BooleanField(default=False)


class FloorConnectionView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=ConnectionInput, responses={201: OpenApiTypes.OBJECT})
    def post(self, request):
        data = ConnectionInput(data=request.data)
        data.is_valid(raise_exception=True)
        try:
            connections = connect_floors(actor=request.user, **data.validated_data)
        except GraphPermissionError as exc:
            return Response({"detail": str(exc)}, status=403)
        except Node.DoesNotExist:
            return Response({"detail": "Connection endpoint not found."}, status=404)
        except (ValidationError, IntegrityError):
            return Response(
                {
                    "detail": "Use different floors in one building and matching stair/lift kinds."
                    " The connection must not already exist."
                },
                status=400,
            )
        return Response({"connection_ids": [str(row.id) for row in connections]}, status=201)
