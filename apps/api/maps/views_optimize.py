"""Image 2.5 optimize review and demo vectorize endpoints."""

from __future__ import annotations

from django.core.exceptions import ObjectDoesNotExist, PermissionDenied, ValidationError
from drf_spectacular.utils import extend_schema
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.modes import IsDeveloperMode
from maps.services import image_optimize as optimize_svc
from maps.services import vectorize_demo as vector_svc
from maps.services import workspace as workspace_svc
from maps.services.graph import GraphError


class OptimizeViewBase(APIView):
    permission_classes = [IsDeveloperMode]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def handle_exception(self, exc):
        if isinstance(exc, PermissionDenied | PermissionError):
            return Response({"detail": str(exc)}, status=403)
        if isinstance(exc, ObjectDoesNotExist):
            return Response({"detail": "This map is no longer available."}, status=404)
        if isinstance(exc, ValidationError):
            return Response({"detail": " ".join(getattr(exc, "messages", [str(exc)]))}, status=400)
        if isinstance(exc, GraphError):
            return Response({"detail": str(exc)}, status=400)
        return super().handle_exception(exc)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    def draft_revision(self, request, target_id):
        contribution = workspace_svc.start_edit(request.user, target_id)
        return contribution.head_revision, contribution


@extend_schema(exclude=True)
class OptimizeStatusView(OptimizeViewBase):
    def get(self, request, target_id):
        revision, contribution = self.draft_revision(request, target_id)
        payload = optimize_svc.optimize_status(revision)
        payload["contribution_id"] = str(contribution.id)
        return Response(payload)


@extend_schema(exclude=True)
class OptimizeUploadView(OptimizeViewBase):
    def post(self, request, target_id):
        uploaded = request.FILES.get("file")
        if not uploaded:
            return Response({"detail": "Attach a floor-plan image as file."}, status=400)
        revision, contribution = self.draft_revision(request, target_id)
        prompt = request.data.get("prompt") if hasattr(request, "data") else None
        payload = optimize_svc.start_optimize(
            revision, uploaded_file=uploaded, actor=request.user, prompt=prompt or None
        )
        payload["contribution_id"] = str(contribution.id)
        return Response(payload, status=201)


@extend_schema(exclude=True)
class OptimizeRegenerateView(OptimizeViewBase):
    def post(self, request, target_id):
        revision, contribution = self.draft_revision(request, target_id)
        prompt = None
        if isinstance(request.data, dict):
            prompt = request.data.get("prompt")
        payload = optimize_svc.regenerate_optimize(
            revision, actor=request.user, prompt=prompt or None
        )
        payload["contribution_id"] = str(contribution.id)
        return Response(payload)


@extend_schema(exclude=True)
class VectorizeDemoView(OptimizeViewBase):
    def post(self, request, target_id):
        revision, contribution = self.draft_revision(request, target_id)
        payload = vector_svc.apply_demo_vector(revision, actor=request.user)
        status = optimize_svc.optimize_status(revision)
        status.update(payload)
        status["contribution_id"] = str(contribution.id)
        return Response(status)
