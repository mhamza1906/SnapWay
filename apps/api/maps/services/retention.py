"""Explicit, scoped destruction after administrator archival.

The normal database guards still forbid modifying or deleting immutable history.
Only this transaction sets the archived-target purge scope; live workers cannot
restore a draft after archival because every writer takes the target lock first.
"""

import logging

from django.apps import apps
from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone

from maps.models import AuditEvent, Contribution, Floor, MapTarget, Publication, Revision
from maps.services.media_store import delete_bytes
from maps.services.workspace import require_admin


def _raw(queryset):
    queryset._raw_delete(queryset.db)


def _purge(target, contributions=None):
    all_rows = contributions is None
    revisions = Revision.objects.filter(target=target)
    if not all_rows:
        revisions = revisions.filter(contribution__in=contributions)
    ids = list(revisions.values_list("id", flat=True))
    keys = []
    if connection.vendor == "postgresql":
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL DEFERRED")
            cursor.execute("SELECT set_config('snapway.purge_target', %s, true)", [str(target.pk)])
    try:
        # Navigation sessions only refer to publications, so pending submissions
        # have no visitor sessions. Full deletion removes dependent captures too.
        if all_rows:
            for name in ["Route", "LocalizationResult", "Capture", "NavigationSession"]:
                _raw(apps.get_model("navigation", name).objects.filter(revision_id__in=ids))
        jobs = apps.get_model("jobs", "Job").objects.filter(target=target)
        if not all_rows:
            jobs = jobs.filter(revision_id__in=ids)
        _raw(apps.get_model("jobs", "JobAttempt").objects.filter(job__in=jobs))
        _raw(jobs)
        # Transfers pin exact nodes on either floor; remove them before purging
        # an endpoint revision, while retaining the other floor's own graph.
        _raw(
            apps.get_model("maps", "FloorConnection").objects.filter(
                Q(from_node__revision_id__in=ids) | Q(to_node__revision_id__in=ids)
            )
        )
        for name in [
            "SceneRelationship",
            "ReferencePhoto",
            "Edge",
            "Node",
            "Room",
            "MapObject",
            "RevisionArtifact",
            "Review",
            "ChangeSet",
            "AuditEvent",
        ]:
            model = apps.get_model("maps", name)
            field = "result_revision_id" if name == "ChangeSet" else "revision_id"
            _raw(model.objects.filter(**{f"{field}__in": ids}))
        if all_rows:
            _raw(Publication.objects.filter(target=target))
        _raw(revisions)
        _raw(Contribution.objects.filter(target=target) if all_rows else contributions)
        assets = apps.get_model("maps", "Asset").objects.filter(target=target)
        if all_rows:
            keys = list(assets.values_list("storage_key", flat=True))
            _raw(assets)
            _raw(apps.get_model("maps", "Membership").objects.filter(target=target))
            _raw(AuditEvent.objects.filter(target=target))
            floor_id = target.floor_id
            _raw(MapTarget.objects.filter(pk=target.pk))
            _raw(Floor.objects.filter(pk=floor_id))
        else:
            # Keep publication assets and their provenance chains; destroy assets
            # used only by the discarded draft/submission lifecycle.
            kept = set()
            for app, name, fields in [
                ("maps", "Revision", ["source_asset_id", "standardized_asset_id"]),
                ("maps", "RevisionArtifact", ["asset_id"]),
                ("maps", "ReferencePhoto", ["asset_id"]),
                ("navigation", "Capture", ["asset_id"]),
            ]:
                model = apps.get_model(app, name)
                for field in fields:
                    kept.update(
                        model.objects.filter(**{f"{field}__in": assets}).values_list(
                            field, flat=True
                        )
                    )
            parents = dict(assets.values_list("id", "source_asset_id"))
            frontier = list(kept)
            while frontier:
                parent = parents.get(frontier.pop())
                if parent and parent not in kept:
                    kept.add(parent)
                    frontier.append(parent)
            discarded = assets.exclude(pk__in=kept)
            keys = list(discarded.values_list("storage_key", flat=True))
            _raw(discarded)
        # Validate deferred relations before clearing the narrowly scoped flag.
        if connection.vendor == "postgresql":
            with connection.cursor() as cursor:
                cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
    finally:
        if connection.vendor == "postgresql":
            with connection.cursor() as cursor:
                # Transaction rollback will reset the flag if an SQL error occurred.
                if not connection.needs_rollback:
                    cursor.execute("SELECT set_config('snapway.purge_target', '', true)")
    for key in keys:
        transaction.on_commit(lambda key=key: delete_bytes(key))


@transaction.atomic
def archive(user, target_id):
    target = MapTarget.objects.select_for_update().get(pk=target_id)
    require_admin(user, target)
    if target.status == "archived":
        return target
    target.status, target.archived_at = "archived", timezone.now()
    target.save(update_fields=["status", "archived_at", "updated_at"])
    pending = Contribution.objects.filter(target=target).exclude(status__in=["merged", "rejected"])
    count = pending.count()
    _purge(target, pending)
    target.publications.filter(is_current=True).update(is_current=False)
    AuditEvent.objects.create(
        target=target,
        actor=user,
        action="map.archived",
        details={"destroyed_pending_contributions": count},
    )
    return target


@transaction.atomic
def delete_archived(user, target_id):
    target = MapTarget.objects.select_for_update().get(pk=target_id)
    require_admin(user, target)
    if target.status != "archived":
        from django.core.exceptions import ValidationError

        raise ValidationError("Archive the map before permanently deleting it.")
    _purge(target)
    logging.getLogger(__name__).info("Archived map %s deleted by user %s", target_id, user.pk)
