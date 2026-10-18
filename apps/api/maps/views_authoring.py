"""Authenticated access to the bundled project and stateless private computation.

This is deliberately not a general Node proxy: no files/catalogues, saved copies,
paid jobs, arbitrary URLs or publication authority are exposed.
"""

import json
from pathlib import Path

import httpx
from accounts.modes import IsDeveloperMode
from drf_spectacular.utils import extend_schema
from rest_framework.response import Response
from rest_framework.views import APIView

PROJECT = Path(__file__).with_name("data") / "sam-ibrahim.json"
COMPUTE = frozenset(
    "authoring/" + name
    for name in (
        "plans",
        "summary",
        "render",
        "routes",
        "hall-points",
        "doorways/place",
        "doorways/define-room",
        "doorways/not-room",
        "doorways/edges",
        "doorways/add",
        "doorways/describe",
        "doorways/edit",
        "doorways/remove",
        "spaces/rename",
        "spaces/stair",
        "spaces/kind",
        "spaces/unmerge",
        "spaces/fold-strips",
        "spaces/merge",
    )
)


def bundled_project():
    return json.loads(PROJECT.read_text(encoding="utf-8"))


@extend_schema(exclude=True)
class AuthoringComputeView(APIView):
    permission_classes = [IsDeveloperMode]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    def get(self, request, operation):
        if operation == "health":
            return self.compute(request, operation)
        if operation not in {"buildings", "buildings/sam-ibrahim"}:
            return Response({"error": "Unknown authoring operation."}, status=404)
        try:
            project = bundled_project()
        except (OSError, ValueError):
            return Response(
                {"error": "The bundled Sam Ibrahim project is unavailable."}, status=503
            )
        if operation == "buildings/sam-ibrahim":
            response = Response(project)
            if request.query_params.get("download") == "1":
                response["Content-Disposition"] = 'attachment; filename="Sam_Ibrahim_Project.json"'
            return response
        return Response(
            {
                "buildings": [
                    {
                        "key": "sam-ibrahim",
                        "id": project["id"],
                        "name": project["name"],
                        "floors": [{"id": f["id"], "label": f["label"]} for f in project["floors"]],
                        "sourceLabel": "Bundled Sam Ibrahim project",
                        "source": "published",
                    }
                ]
            }
        )

    def post(self, request, operation):
        if operation == "map-jobs" or operation == "buildings/copies":
            return Response(
                {
                    "error": "Use the saved project and manual tools. Cloud AI jobs and "
                    "shared-file saves are not enabled through this compute boundary."
                },
                status=503,
            )
        if operation not in COMPUTE:
            return Response({"error": "Unknown authoring operation."}, status=404)
        return self.compute(request, operation)

    def compute(self, request, operation):
        kwargs = {}
        if request.method == "POST":
            if operation == "authoring/plans":
                plan = request.FILES.get("plan")
                if not plan or plan.size > 15 * 1024 * 1024:
                    return Response({"error": "Choose a PDF, PNG or JPEG up to 15 MB."}, status=400)
                kwargs = {
                    "files": {"plan": (plan.name, plan.file, plan.content_type)},
                    "data": {
                        k: request.data[k] for k in ("name", "floorLabel") if k in request.data
                    },
                }
            else:
                kwargs = {"json": request.data}
        try:
            # Fixed loopback origin + allowlisted operation, no user headers or redirects.
            with httpx.Client(timeout=45, trust_env=False, follow_redirects=False) as client:
                upstream = client.request(
                    request.method, "http://127.0.0.1:5175/api/" + operation, **kwargs
                )
            if len(upstream.content) > 24 * 1024 * 1024:
                raise ValueError("Oversized compute response")
            if upstream.status_code >= 500:
                raise ValueError("Compute failure")
            data = upstream.json()
            if operation == "health":
                data["authoringJobs"] = False
                data["savedProject"] = PROJECT.is_file()
            return Response(data, status=upstream.status_code)
        except (httpx.HTTPError, ValueError):
            return Response(
                {
                    "error": "The private map computation service is unavailable. "
                    "Your saved project and PDFs are still available; try again shortly."
                },
                status=503,
            )
