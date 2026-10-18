"""Live Developer workspace API. Session mode and map scope are checked server-side."""

from accounts.modes import IsDeveloperMode
from django.core.exceptions import ObjectDoesNotExist, PermissionDenied, ValidationError
from django.db.models import Prefetch
from django.http import HttpResponse
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from maps.models import AuditEvent, Contribution, Membership, Publication
from maps.services import retention
from maps.services import workspace as svc


class NewMapSerializer(serializers.Serializer):
    building_name = serializers.CharField(max_length=200)
    floor_code = serializers.CharField(max_length=50)
    floor_name = serializers.CharField(max_length=200, required=False)
    building_id = serializers.UUIDField(required=False)
    place_id = serializers.CharField(max_length=300, required=False)
    address = serializers.CharField(max_length=1000, required=False, allow_blank=True)
    latitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, min_value=-90, max_value=90, required=False
    )
    longitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, min_value=-180, max_value=180, required=False
    )

    def validate(self, values):
        if not values.get("building_id") and not {"latitude", "longitude"}.issubset(values):
            raise serializers.ValidationError(
                "Select a building on Explore or provide its coordinates."
            )
        return values


class WorkspaceView(APIView):
    permission_classes = [IsDeveloperMode]

    def handle_exception(self, exc):
        if isinstance(exc, PermissionDenied | PermissionError):
            return Response({"detail": str(exc)}, status=403)
        if isinstance(exc, ObjectDoesNotExist):
            return Response(
                {"detail": "This map or submission is no longer available."}, status=404
            )
        if isinstance(exc, ValidationError):
            return Response({"detail": " ".join(exc.messages)}, status=400)
        if isinstance(exc, ValueError | TypeError | KeyError):
            return Response({"detail": "Invalid workspace request."}, status=400)
        return super().handle_exception(exc)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response


@extend_schema(exclude=True)
class WorkspaceBuildingsView(WorkspaceView):
    """Explore discovery for signed-in developers (draft + published floors with coordinates)."""

    def get(self, request):
        return Response({"buildings": svc.workspace_buildings(request.user)})


@extend_schema(exclude=True)
class WorkspaceMapsView(WorkspaceView):
    def get(self, request):
        # List must stay metadata-only: do not sign underlay URLs here. Each
        # preview_url pointed at the full floor-plan asset (often a large SVG),
        # so three cards triggered three full underlay downloads in the browser.
        targets = list(
            svc.visible_targets(request.user).prefetch_related(
                Prefetch(
                    "contributions",
                    queryset=Contribution.objects.filter(author=request.user)
                    .select_related(
                        "head_revision__source_asset",
                        "head_revision__standardized_asset",
                        "author",
                    )
                    .order_by("-updated_at"),
                    to_attr="user_contributions",
                ),
                Prefetch(
                    "contributions",
                    queryset=Contribution.objects.filter(head_revision__isnull=False)
                    .select_related(
                        "head_revision__source_asset",
                        "head_revision__standardized_asset",
                        "author",
                    )
                    .order_by("-updated_at"),
                    to_attr="shared_contributions",
                ),
                Prefetch(
                    "publications",
                    queryset=Publication.objects.filter(
                        is_current=True, invalidated_at__isnull=True
                    ).select_related("revision"),
                    to_attr="current_pubs",
                ),
            )
        )
        target_ids = [target.id for target in targets]
        staff = request.user.is_staff or request.user.is_superuser
        admin_ids = set()
        if not staff and target_ids:
            admin_ids = set(
                Membership.objects.filter(
                    user=request.user,
                    role=Membership.Role.ADMIN,
                    revoked_at__isnull=True,
                    target_id__in=target_ids,
                ).values_list("target_id", flat=True)
            )
        cards = []
        for target in targets:
            contribution = (getattr(target, "user_contributions", None) or [None])[0]
            publication = (getattr(target, "current_pubs", None) or [None])[0]
            shared = (getattr(target, "shared_contributions", None) or [None])[0]
            shared_revision = (
                None if contribution or publication or not shared else shared.head_revision
            )
            if not contribution and not publication and not shared_revision:
                continue
            # Preview URLs stay off the list payload (bandwidth); preview_kind still
            # drives sort: vectorized first, then Image 2.5, then everything else.
            row = svc.card(
                target,
                contribution,
                include_preview=False,
                shared_revision=shared_revision,
            )
            if shared_revision and not contribution:
                row["author"] = shared.author.get_username() if shared else row["author"]
                row["status"] = shared.status if shared else row["status"]
            row["can_admin"] = staff or target.id in admin_ids
            cards.append(row)

        def sort_key(row: dict):
            kind = row.get("preview_kind") or ""
            stage = row.get("authoring_stage") or ""
            rank = {"vector": 0, "optimize": 1}.get(kind, 3)
            if stage == "image_optimize":
                rank = min(rank, 1)
            elif stage == "vectorized_demo":
                rank = 0
            updated = row.get("updated_at")
            stamp = updated.timestamp() if hasattr(updated, "timestamp") else 0
            return (rank, -stamp)

        cards.sort(key=sort_key)
        return Response({"maps": cards})

    def post(self, request):
        serializer = NewMapSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        contribution = svc.create_map(request.user, serializer.validated_data)
        return Response(svc.card(contribution.target, contribution), status=201)


@extend_schema(exclude=True)
class EditMapView(WorkspaceView):
    def post(self, request, target_id):
        contribution = svc.start_edit(request.user, target_id)
        return Response(
            {
                **svc.card(contribution.target, contribution),
                **svc.revision_payload(contribution.head_revision),
                "can_admin": svc.is_admin(request.user, contribution.target),
            }
        )


@extend_schema(exclude=True)
class SubmissionView(WorkspaceView):
    def post(self, request, contribution_id):
        contribution = svc.submit(request.user, contribution_id)
        return Response(svc.card(contribution.target, contribution))


@extend_schema(exclude=True)
class PipelineImportView(WorkspaceView):
    def post(self, request, contribution_id):
        contribution = svc.import_pipeline(request.user, contribution_id, request.data)
        return Response(svc.card(contribution.target, contribution))


@extend_schema(exclude=True)
class ContributionListView(WorkspaceView):
    def get(self, request):
        svc.require_admin(request.user)
        targets = svc.visible_targets(request.user, admin=True)
        rows = [svc.card(t) for t in targets.filter(status="archived")]
        submissions = (
            Contribution.objects.filter(target__in=targets, target__status="open")
            .exclude(
                status="draft",
            )
            .select_related("target__floor__building", "head_revision__source_asset", "author")
            .order_by("-updated_at")
        )
        rows.extend(svc.card(c.target, c) for c in submissions)
        rows.sort(key=lambda row: row["updated_at"], reverse=True)
        return Response({"contributions": rows})


@extend_schema(exclude=True)
class ContributionDetailView(WorkspaceView):
    def get(self, request, contribution_id):
        contribution = Contribution.objects.select_related(
            "target__floor__building", "head_revision__source_asset", "author"
        ).get(pk=contribution_id)
        svc.require_admin(request.user, contribution.target)
        if contribution.status == "draft":
            raise NotFound()
        publication = svc.current_publication(contribution.target)
        history = contribution.target.publications.select_related("revision").order_by("-sequence")
        selected = contribution.head_revision
        revision_id = request.query_params.get("revision")
        if revision_id:
            selected = history.get(revision_id=revision_id).revision
        return Response(
            {
                "contribution": svc.card(contribution.target, contribution),
                "latest": svc.revision_payload(publication.revision) if publication else None,
                "selected": svc.revision_payload(selected),
                "history": [
                    {
                        "revision_id": str(p.revision_id),
                        "sequence": p.sequence,
                        "created_at": p.created_at,
                    }
                    for p in history
                ],
            }
        )

    def post(self, request, contribution_id):
        contribution = svc.review(
            request.user,
            contribution_id,
            request.data.get("decision"),
            request.data.get("feedback", ""),
        )
        return Response(svc.card(contribution.target, contribution))


@extend_schema(exclude=True)
class TargetLifecycleView(WorkspaceView):
    def post(self, request, target_id):
        target = retention.archive(request.user, target_id)
        return Response(svc.card(target))

    def delete(self, request, target_id):
        retention.delete_archived(request.user, target_id)
        return Response(status=204)


@extend_schema(exclude=True)
class WorkspaceActivityView(WorkspaceView):
    def get(self, request):
        svc.require_admin(request.user)
        rows = (
            AuditEvent.objects.filter(target__in=svc.visible_targets(request.user, admin=True))
            .select_related("actor", "target")
            .order_by("-created_at")[:200]
        )
        return Response(
            {
                "events": [
                    {
                        "id": str(row.pk),
                        "action": row.action,
                        "target": row.target.title,
                        "actor": row.actor.get_username() if row.actor else "System",
                        "at": row.created_at,
                        "details": row.details,
                    }
                    for row in rows
                ]
            }
        )


@extend_schema(exclude=True)
class MapExportView(WorkspaceView):
    def get(self, request, target_id):
        target = svc.visible_targets(request.user).get(pk=target_id)
        revision = None
        contribution = (
            target.contributions.filter(author=request.user)
            .select_related("head_revision")
            .order_by("-updated_at")
            .first()
        )
        if contribution:
            revision = contribution.head_revision
        if not revision:
            published = svc.current_publication(target)
            revision = published.revision if published else None
        if not revision:
            raise NotFound("No map content is available.")
        kind = request.query_params.get("kind", "json")
        if kind == "svg":
            response = HttpResponse(svc.render_svg(revision), content_type="image/svg+xml")
        elif kind in {"json", "graph"}:
            import json

            payload = svc.revision_payload(revision)
            # Signed display URLs expire; exports describe durable IDs instead.
            payload.pop("underlay_url", None)
            payload.pop("vector_url", None)
            payload["source_asset_id"] = (
                str(revision.source_asset_id) if revision.source_asset_id else None
            )
            if kind == "graph":
                payload.pop("geometry", None)
            response = HttpResponse(
                json.dumps(payload, default=str, indent=2), content_type="application/json"
            )
        else:
            raise ValidationError("Choose json, graph or svg.")
        response["Content-Disposition"] = (
            f'attachment; filename="map-{target.pk}.{"svg" if kind == "svg" else "json"}"'
        )
        return response
