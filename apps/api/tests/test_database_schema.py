"""Database constraints, including bulk writes that bypass Model.full_clean()."""

import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from jobs.models import Job
from maps.models import (
    Asset,
    Building,
    Contribution,
    Edge,
    Floor,
    MapObject,
    MapTarget,
    Node,
    Publication,
    ReferencePhoto,
    Review,
    Revision,
    RevisionArtifact,
    Room,
    SceneRelationship,
)
from navigation.models import Capture, LocalizationResult, NavigationSession

pytestmark = pytest.mark.django_db
postgresql = pytest.mark.skipif(
    connection.vendor != "postgresql", reason="PostgreSQL scope keys and triggers"
)
DIGEST = "a" * 64


@pytest.fixture
def world():
    user = get_user_model().objects.create_user(username="schema-reviewer")
    building = Building.objects.create(name="Test building", slug="test-building", created_by=user)
    floor = Floor.objects.create(building=building, code="G", name="Ground")
    target = MapTarget.objects.create(floor=floor, title="Ground floor", created_by=user)
    return SimpleNamespace(user=user, building=building, target=target)


def snapshot(world, *, target=None, base=None):
    target = target or world.target
    contribution = Contribution.objects.create(
        target=target, author=world.user, title="Test contribution", base_revision=base
    )
    revision = Revision.objects.create(
        target=target,
        contribution=contribution,
        created_by=world.user,
        geometry={"objects": []},
        coordinate_frame={"origin": "top-left", "unit": "plan_unit", "y_axis": "down"},
    )
    contribution.head_revision = revision
    contribution.save(update_fields=["head_revision"])
    return revision


def asset(world, kind="svg", target=None):
    return Asset.objects.create(
        target=target or world.target,
        uploaded_by=world.user,
        kind=kind,
        storage_key=f"tests/{uuid.uuid4()}",
        content_type="image/svg+xml" if kind == "svg" else "image/jpeg",
        sha256=DIGEST,
        byte_size=100,
    )


def freeze(revision):
    revision.content_hash = DIGEST
    revision.frozen_at = timezone.now()
    revision.save(update_fields=["content_hash", "frozen_at"])


def candidate(world, revision=None, *, ready=True):
    revision = revision or snapshot(world)
    freeze(revision)
    Contribution.objects.filter(pk=revision.contribution_id).update(status="submitted")
    review = Review.objects.create(revision=revision, reviewer=world.user, decision="approved")
    RevisionArtifact.objects.create(
        revision=revision,
        kind="svg",
        state="ready" if ready else "pending",
        asset=asset(world, target=revision.target) if ready else None,
        input_content_hash=DIGEST,
        profile={"renderer_version": "test-1"},
    )
    return dict(
        target=revision.target,
        revision=revision,
        approval=review,
        published_by=world.user,
        sequence=1,
        is_current=True,
    )


def node(revision, **kwargs):
    return Node.objects.create(revision=revision, kind="checkpoint", x=0, y=0, **kwargs)


def session(publication):
    return NavigationSession.objects.create(
        publication=publication,
        revision=publication.revision,
        token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
        expires_at=timezone.now() + timedelta(hours=1),
    )


def capture(world, visitor, **overrides):
    job = Job.objects.create(
        target=world.target,
        revision=visitor.revision,
        session=visitor,
        queue="localization",
        operation="localize",
        idempotency_scope=f"session:{visitor.pk}",
        idempotency_key=str(uuid.uuid4()),
        deadline_at=timezone.now() + timedelta(minutes=1),
        next_attempt_at=timezone.now(),
    )
    values = dict(
        session=visitor,
        revision=visitor.revision,
        asset=asset(world, "capture"),
        job=job,
        sequence=1,
        context_version=0,
        captured_at=timezone.now(),
        idempotency_key="capture-1",
    )
    values.update(overrides)
    return Capture.objects.create(**values)


@pytest.mark.parametrize("latitude,longitude", [(1, None), (None, 1), (91, 0), (0, -181)])
def test_building_rejects_incomplete_or_invalid_geographic_coordinates(world, latitude, longitude):
    with pytest.raises(IntegrityError), transaction.atomic():
        Building.objects.filter(pk=world.building.pk).update(latitude=latitude, longitude=longitude)


@pytest.mark.parametrize("width,height", [(0, 1), (1, None), (None, 1)])
def test_asset_rejects_incomplete_dimensions(world, width, height):
    with pytest.raises(IntegrityError), transaction.atomic():
        Asset.objects.create(
            target=world.target,
            kind="photo",
            storage_key="bad-dimensions",
            sha256=DIGEST,
            byte_size=100,
            width=width,
            height=height,
            content_type="image/jpeg",
        )


def test_edge_rejects_negative_cost_and_self_connection(world):
    revision = snapshot(world)
    start, end = node(revision), node(revision)
    for destination, cost in [(end, -1), (start, 1)]:
        with pytest.raises(IntegrityError), transaction.atomic():
            Edge.objects.create(revision=revision, from_node=start, to_node=destination, cost=cost)


def test_room_destination_is_idempotently_unique(world):
    revision = snapshot(world)
    obj = MapObject.objects.create(revision=revision, kind="room")
    room = Room.objects.create(revision=revision, map_object=obj, number="101")
    Node.objects.create(revision=revision, kind="room", room=room, x=0, y=0)
    with pytest.raises(IntegrityError), transaction.atomic():
        Node.objects.create(revision=revision, kind="room", room=room, x=1, y=1)


def test_reviewed_reference_requires_placement_and_reviewer(world):
    revision = snapshot(world)
    with pytest.raises(IntegrityError), transaction.atomic():
        ReferencePhoto.objects.create(
            revision=revision, asset=asset(world, "photo"), status="reviewed"
        )


def test_only_one_current_publication_per_target_and_sessions_keep_old_revision(world):
    first = Publication.objects.create(**candidate(world))
    visitor = session(first)
    second_values = candidate(world, snapshot(world, base=first.revision))
    second_values["sequence"] = 2
    with pytest.raises(IntegrityError), transaction.atomic():
        Publication.objects.create(**second_values)
    with transaction.atomic():
        Publication.objects.filter(pk=first.pk).update(is_current=False)
        second = Publication.objects.create(**second_values)
    visitor.refresh_from_db()
    assert visitor.publication_id == first.pk
    assert visitor.revision_id == first.revision_id
    assert Publication.objects.get(target=world.target, is_current=True).pk == second.pk


def test_job_deduplication_survives_retries(world):
    values = dict(
        target=world.target,
        requested_by=world.user,
        queue="authoring",
        operation="vectorize",
        idempotency_scope=f"user:{world.user.pk}:target:{world.target.pk}",
        idempotency_key="retry",
        deadline_at=timezone.now() + timedelta(minutes=1),
        next_attempt_at=timezone.now(),
    )
    Job.objects.create(**values)
    with pytest.raises(IntegrityError), transaction.atomic():
        Job.objects.create(**values)


@postgresql
def test_edge_cannot_cross_revisions_even_with_valid_node_ids(world):
    first, second = snapshot(world), snapshot(world)
    with pytest.raises(IntegrityError), transaction.atomic():
        Edge.objects.create(revision=first, from_node=node(first), to_node=node(second), cost=1)


@postgresql
def test_head_cannot_point_at_another_contribution(world):
    first, second = snapshot(world), snapshot(world)
    with pytest.raises(IntegrityError), transaction.atomic():
        Contribution.objects.filter(pk=first.contribution_id).update(head_revision=second)


@postgresql
def test_base_revision_cannot_cross_targets(world):
    first = snapshot(world)
    other_floor = Floor.objects.create(building=world.building, code="1", name="First")
    other_target = MapTarget.objects.create(floor=other_floor, title="First", created_by=world.user)
    with pytest.raises(IntegrityError), transaction.atomic():
        snapshot(world, target=other_target, base=first)


@postgresql
def test_frozen_snapshot_blocks_updates_inserts_and_deletes(world):
    revision = snapshot(world)
    point = node(revision)
    freeze(revision)
    for mutation in [
        lambda: Revision.objects.filter(pk=revision.pk).update(geometry={"tampered": True}),
        lambda: Node.objects.filter(pk=point.pk).update(label="Late AI output"),
        lambda: node(revision),
        lambda: Node.objects.filter(pk=point.pk).delete(),
    ]:
        with pytest.raises(IntegrityError, match="immutable"), transaction.atomic():
            mutation()


@postgresql
def test_review_requires_frozen_content(world):
    revision = snapshot(world)
    with pytest.raises(IntegrityError, match="frozen"), transaction.atomic():
        Review.objects.create(revision=revision, reviewer=world.user, decision="approved")


@postgresql
def test_publication_failure_preserves_previous_complete_publication(world):
    first = Publication.objects.create(**candidate(world))
    values = candidate(world, snapshot(world, base=first.revision), ready=False)
    values["sequence"] = 2
    with pytest.raises(IntegrityError, match="artifacts"), transaction.atomic():
        Publication.objects.filter(pk=first.pk).update(is_current=False)
        Publication.objects.create(**values)
    assert Publication.objects.get(target=world.target, is_current=True).pk == first.pk


@postgresql
def test_publication_accepts_stale_base_with_a_new_approval(world):
    stale = snapshot(world)  # Started before the first publication.
    first = Publication.objects.create(**candidate(world))
    values = candidate(world, stale)
    values["sequence"] = 2
    with transaction.atomic():
        Publication.objects.filter(pk=first.pk).update(is_current=False)
        accepted = Publication.objects.create(**values)
    assert Publication.objects.get(target=world.target, is_current=True).pk == accepted.pk


@postgresql
def test_old_approval_cannot_override_a_later_rejection(world):
    values = candidate(world)
    Review.objects.create(
        revision=values["revision"],
        reviewer=world.user,
        decision="rejected",
        feedback="Wrong doorway",
    )
    with pytest.raises(IntegrityError, match="latest review"), transaction.atomic():
        Publication.objects.create(**values)


@postgresql
def test_artifact_for_different_content_cannot_publish(world):
    values = candidate(world)
    RevisionArtifact.objects.filter(revision=values["revision"]).update(input_content_hash="b" * 64)
    with pytest.raises(IntegrityError, match="exact revision"), transaction.atomic():
        Publication.objects.create(**values)


@postgresql
def test_old_approval_cannot_publish_after_head_changes(world):
    values = candidate(world)
    contribution = values["revision"].contribution
    changed = Revision.objects.create(
        target=world.target,
        contribution=contribution,
        created_by=world.user,
        parent=values["revision"],
        geometry={"objects": []},
        coordinate_frame={},
    )
    Contribution.objects.filter(pk=contribution.pk).update(head_revision=changed)
    with pytest.raises(IntegrityError, match="frozen submitted content"), transaction.atomic():
        Publication.objects.create(**values)


@postgresql
def test_approval_cannot_authorize_a_different_revision(world):
    original = candidate(world)
    changed = candidate(world)
    changed["approval"] = original["approval"]
    with pytest.raises(IntegrityError), transaction.atomic():
        Publication.objects.create(**changed)


@postgresql
def test_archived_target_cannot_publish_late_work(world):
    values = candidate(world)
    MapTarget.objects.filter(pk=world.target.pk).update(
        status="archived", archived_at=timezone.now()
    )
    with pytest.raises(IntegrityError, match="open target"), transaction.atomic():
        Publication.objects.create(**values)


@postgresql
def test_published_artifacts_and_identity_cannot_change(world):
    publication = Publication.objects.create(**candidate(world))
    for mutation in [
        lambda: RevisionArtifact.objects.filter(revision=publication.revision).update(
            state="failed"
        ),
        lambda: Publication.objects.filter(pk=publication.pk).update(sequence=2),
        lambda: Review.objects.filter(pk=publication.approval_id).update(decision="rejected"),
    ]:
        with pytest.raises(IntegrityError), transaction.atomic():
            mutation()


@postgresql
def test_reference_evidence_and_relationship_must_match_target_and_revision(world):
    first, second = snapshot(world), snapshot(world)
    photo = ReferencePhoto.objects.create(revision=first, asset=asset(world, "photo"))
    with pytest.raises(IntegrityError), transaction.atomic():
        SceneRelationship.objects.create(revision=second, reference=photo, kind="sign_points_to")
    with pytest.raises(IntegrityError, match="expected kind"), transaction.atomic():
        ReferencePhoto.objects.create(revision=second, asset=asset(world, "svg"))


@postgresql
def test_navigation_results_cannot_be_confirmed_by_another_session(world):
    revision = snapshot(world)
    point = node(revision)
    publication = Publication.objects.create(**candidate(world, revision))
    first, second = session(publication), session(publication)
    image = capture(world, first)
    result = LocalizationResult.objects.create(
        capture=image, session=first, revision=revision, outcome="accepted", node=point, evidence={}
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        NavigationSession.objects.filter(pk=second.pk).update(confirmed_result=result)


@postgresql
def test_capture_job_cannot_belong_to_another_session(world):
    publication = Publication.objects.create(**candidate(world))
    first, second = session(publication), session(publication)
    with pytest.raises(IntegrityError), transaction.atomic():
        capture(world, first, session=second)
