"""Public, allowlisted PDF downloads from the existing private Cloudflare R2 bucket."""

import json
from pathlib import Path

from django.core.files.storage import default_storage
from django.http import HttpResponseRedirect
from django.urls import reverse
from drf_spectacular.utils import extend_schema
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from maps.services.media_store import point_photo_storage_ready, signed_url

REGISTRY = Path(__file__).with_name("shared_documents.json")


def shared_documents():
    return json.loads(REGISTRY.read_text())["documents"] if REGISTRY.exists() else {}


class SharedDocumentListView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(exclude=True)
    def get(self, request):
        documents = []
        for slug, item in shared_documents().items():
            documents.append(
                {
                    "id": slug,
                    **{key: item[key] for key in ("title", "filename", "sha256", "bytes", "pages")},
                    "download_url": reverse("shared-document-download", kwargs={"slug": slug}),
                }
            )
        response = Response({"documents": documents})
        response["Cache-Control"] = "no-store"
        return response


class SharedDocumentDownloadView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(exclude=True)
    def get(self, request, slug):
        # The URL accepts a registry ID, never an arbitrary bucket key or URL.
        document = shared_documents().get(slug)
        if document is None:
            return Response({"detail": "Shared document not found."}, status=404)
        if not point_photo_storage_ready():
            return Response({"detail": "Cloud PDF storage is unavailable."}, status=503)
        try:
            if not default_storage.exists(document["storage_key"]):
                return Response({"detail": "Shared PDF is temporarily unavailable."}, status=503)
            url = signed_url(document["storage_key"])
        except Exception:  # Do not expose provider errors or private configuration.
            return Response({"detail": "Shared PDF is temporarily unavailable."}, status=503)
        response = HttpResponseRedirect(url)
        # Every access gets a fresh short-lived URL; no signed links go in client bundles.
        response["Cache-Control"] = "no-store, private"
        response["Referrer-Policy"] = "no-referrer"
        return response
