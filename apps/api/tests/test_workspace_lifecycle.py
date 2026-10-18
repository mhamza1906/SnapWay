"""Behavioral acceptance of workspace ownership, pinned snapshots and last approval wins."""

import io
import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection, transaction
from maps.models import Contribution, Edge, MapTarget, Membership, Node, Publication, Revision
from maps.services.graph import GraphPermissionError, add_edge, add_node, update_node
from maps.services.retention import archive, delete_archived
from maps.services.underlay import store_underlay_file
from maps.services.workspace import create_map, import_pipeline, review, start_edit, submit
from PIL import Image
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db


@pytest.fixture
def people():
    users = get_user_model()
    return [
        users.objects.create_user(username=name, is_staff=name == "admin")
        for name in ["admin", "alice", "bob"]
    ]


def plan(contribution):
    image = io.BytesIO()
    Image.new("RGB", (100, 80), "white").save(image, format="PNG")
    revision = contribution.head_revision
    store_underlay_file(
        revision,
        uploaded_file=SimpleUploadedFile(
            "floor.png",
            image.getvalue(),
            content_type="image/png",
        ),
        actor=contribution.author,
    )
    a = add_node(revision, x=10, y=10, label="Door A", actor=contribution.author)
    b = add_node(revision, x=40, y=30, label="Room B", actor=contribution.author)
    add_edge(revision, from_id=a.pk, to_id=b.pk, actor=contribution.author)
    return revision


def new_map(user):
    return create_map(
        user,
        {
            "building_name": "Instructional Centre",
            "floor_code": "4",
            "latitude": 43.78412,
            "longitude": -79.18812,
        },
    )


def client_for(user, mode="developer"):
    client = APIClient()
    client.force_login(user)
    session = client.session
    session["snapway_mode"] = mode
    session.save()
    return client


def test_developer_waits_for_approval_and_admin_publishes_immediately(people):
    admin, alice, _ = people
    contribution = new_map(alice)
    plan(contribution)
    result = submit(alice, contribution.pk)
    assert result.status == "submitted"
    assert not Publication.objects.exists()
    assert result.head_revision.frozen_at
    review(admin, result.pk, "approved")
    assert Publication.objects.get(is_current=True).revision_id == result.head_revision_id
    own = new_map(admin)
    plan(own)
    assert submit(admin, own.pk).status == "merged"


def test_two_editors_keep_pinned_snapshots_and_last_approval_wins(people):
    admin, alice, bob = people
    original = new_map(admin)
    source = plan(original)
    submit(admin, original.pk)
    first, second = start_edit(alice, original.target_id), start_edit(bob, original.target_id)
    assert first.base_revision_id == second.base_revision_id == source.pk
    assert first.head_revision_id != second.head_revision_id
    assert first.head_revision.nodes.count() == 2
    assert first.head_revision.edges.count() == 1
    assert set(first.head_revision.nodes.values_list("stable_id", flat=True)) == set(
        source.nodes.values_list("stable_id", flat=True)
    )
    assert first.head_revision.source_asset_id == source.source_asset_id
    node = first.head_revision.nodes.get(label="Door A")
    update_node(first.head_revision, node_id=node.pk, label="Alice", actor=alice)
    submit(alice, first.pk)
    review(admin, first.pk, "approved")
    # Resuming Bob's edit must not rebase or replace it with Alice's publication.
    resumed = start_edit(bob, original.target_id)
    assert resumed.head_revision_id == second.head_revision_id
    assert resumed.head_revision.nodes.filter(label="Door A").exists()
    update_node(
        second.head_revision,
        node_id=second.head_revision.nodes.get(label="Door A").pk,
        label="Bob",
        actor=bob,
    )
    submit(bob, second.pk)
    review(admin, second.pk, "approved")
    current = Publication.objects.get(target=original.target, is_current=True)
    assert current.sequence == 3
    assert current.revision.nodes.filter(label="Bob").exists()
    assert not current.revision.nodes.filter(label="Alice").exists()


def test_member_cannot_mutate_or_read_another_private_snapshot(people):
    admin, alice, bob = people
    original = new_map(admin)
    plan(original)
    submit(admin, original.pk)
    a, b = start_edit(alice, original.target_id), start_edit(bob, original.target_id)
    with pytest.raises(GraphPermissionError):
        add_node(a.head_revision, x=20, y=20, actor=bob)
    response = client_for(bob).get(f"/api/maps/revisions/{a.head_revision_id}/graph/")
    assert response.status_code == 403
    assert client_for(alice, "public").get("/api/maps/workspace/").status_code == 403
    assert client_for(alice).get("/api/maps/workspace/contributions/").status_code == 403
    with pytest.raises(PermissionDenied):
        submit(bob, a.pk)
    assert Membership.objects.get(user=bob, target=b.target).role == "volunteer"


def test_archive_destroys_all_pending_work_and_late_writes_cannot_restore_it(people):
    admin, alice, bob = people
    original = new_map(admin)
    plan(original)
    submit(admin, original.pk)
    a, b = start_edit(alice, original.target_id), start_edit(bob, original.target_id)
    submit(alice, a.pk)
    pending_ids = [a.head_revision_id, b.head_revision_id]
    archive(admin, original.target_id)
    assert not Contribution.objects.filter(pk__in=[a.pk, b.pk]).exists()
    assert not Revision.objects.filter(pk__in=pending_ids).exists()
    assert not Publication.objects.filter(target=original.target, is_current=True).exists()
    assert client_for(admin).get("/api/maps/public/buildings/").json()["buildings"] == []
    assert (
        client_for(alice).post(f"/api/maps/workspace/contributions/{a.pk}/submit/", {}).status_code
        == 404
    )
    with pytest.raises(ValidationError):
        start_edit(bob, original.target_id)
    with pytest.raises(PermissionDenied):
        delete_archived(alice, original.target_id)
    delete_archived(admin, original.target_id)
    assert not MapTarget.objects.filter(pk=original.target_id).exists()
    assert not Revision.objects.exists()
    assert not Node.objects.exists()
    assert not Edge.objects.exists()


def test_pipeline_import_is_private_until_explicit_submission(people):
    admin, alice, _ = people
    draft = new_map(alice)
    import_pipeline(
        alice,
        draft.pk,
        {
            "floor_id": "4",
            "svg": (
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">'
                '<path d="M0 0H100"/></svg>'
            ),
            "building": {
                "floors": [
                    {
                        "id": "4",
                        "width": 100,
                        "height": 80,
                        "geometry": {"spaces": [{"id": "r1", "kind": "room", "label": "401"}]},
                    }
                ],
                "nodes": [
                    {
                        "id": "a",
                        "floorId": "4",
                        "type": "entrance",
                        "label": "Entrance",
                        "position": {"x": 10, "y": 10},
                    },
                    {
                        "id": "b",
                        "floorId": "4",
                        "type": "destination",
                        "spaceIds": ["r1"],
                        "label": "Room",
                        "position": {"x": 40, "y": 20},
                    },
                ],
                "edges": [{"from": "a", "to": "b", "length": 32, "direction": "both"}],
            },
        },
    )
    draft.refresh_from_db()
    assert draft.head_revision.nodes.count() == 2
    assert draft.head_revision.edges.count() == 2
    assert draft.head_revision.rooms.get().number == "401"
    assert draft.head_revision.nodes.get(label="Room").kind == "room"
    assert draft.status == "draft"
    assert not Publication.objects.exists()
    submit(alice, draft.pk)
    review(admin, draft.pk, "approved")


def test_developers_share_unpublished_maps_but_keep_private_drafts(people):
    """Peer developers see the shared catalog; each still gets their own draft clone."""
    _, alice, bob = people
    alice_map = new_map(alice)
    plan(alice_map)
    # Bob can see Alice's unpublished floor on My maps and Explore buildings.
    bob_maps = client_for(bob).get("/api/maps/workspace/").json()["maps"]
    assert any(row["target_id"] == str(alice_map.target_id) for row in bob_maps)
    buildings = client_for(bob).get("/api/maps/workspace/buildings/").json()["buildings"]
    assert any(
        floor["target_id"] == str(alice_map.target_id)
        for building in buildings
        for floor in building["floors"]
    )
    # Joining clones Alice's SoT into Bob's own contribution; Alice's draft stays private.
    bob_draft = start_edit(bob, alice_map.target_id)
    assert bob_draft.author_id == bob.pk
    assert bob_draft.head_revision_id != alice_map.head_revision_id
    assert bob_draft.head_revision.nodes.count() == alice_map.head_revision.nodes.count()
    with pytest.raises(GraphPermissionError):
        add_node(alice_map.head_revision, x=99, y=99, actor=bob)


def test_exports_and_building_markers_only_expose_published_floors(people):
    admin, alice, _ = people
    draft = new_map(alice)
    plan(draft)
    submit(alice, draft.pk)
    client = client_for(alice)
    assert not client.get("/api/maps/public/buildings/").json()["buildings"]
    workspace = client.get("/api/maps/workspace/buildings/").json()["buildings"]
    assert len(workspace) == 1
    assert workspace[0]["published"] is False
    assert workspace[0]["latitude"] == 43.78412
    assert workspace[0]["floors"][0]["published"] is False
    review(admin, draft.pk, "approved")
    buildings = client.get("/api/maps/public/buildings/").json()["buildings"]
    assert len(buildings) == 1 and buildings[0]["floors"][0]["code"] == "4"
    published = client.get("/api/maps/workspace/buildings/").json()["buildings"]
    assert published[0]["published"] is True
    assert published[0]["floors"][0]["published"] is True
    for format in ["json", "graph", "svg"]:
        response = client.get(
            f"/api/maps/workspace/targets/{draft.target_id}/export/?kind={format}"
        )
        assert response.status_code == 200
        assert "attachment" in response["Content-Disposition"]
    assert (
        client.get(
            f"/api/maps/workspace/targets/{draft.target_id}/export/?kind=invalid"
        ).status_code
        == 400
    )


def test_snapshot_remaps_room_photo_and_relationship_associations(people):
    from django.utils import timezone
    from maps.models import Asset, MapObject, ReferencePhoto, Room, SceneRelationship

    admin, alice, _ = people
    original = new_map(admin)
    source = plan(original)
    obj = MapObject.objects.create(revision=source, kind="room")
    room = Room.objects.create(revision=source, map_object=obj, number="401", name="Studio")
    node = Node.objects.create(revision=source, kind="room", room=room, map_object=obj, x=20, y=20)
    asset = Asset.objects.create(
        target=original.target,
        uploaded_by=admin,
        kind="photo",
        storage_key=f"test-photo/{source.pk}",
        content_type="image/png",
        sha256="a" * 64,
        byte_size=10,
    )
    ref = ReferencePhoto.objects.create(
        revision=source,
        node=node,
        asset=asset,
        heading_degrees=90,
        scene_description="Blue studio door",
        status="reviewed",
        reviewed_by=admin,
        reviewed_at=timezone.now(),
    )
    SceneRelationship.objects.create(
        revision=source,
        reference=ref,
        room=room,
        node=node,
        kind="door_is",
        evidence={"color": "blue"},
    )
    submit(admin, original.pk)
    draft = start_edit(alice, original.target_id).head_revision
    copied = draft.references.get()
    assert copied.pk != ref.pk and copied.stable_id == ref.stable_id
    assert copied.asset_id == ref.asset_id and copied.heading_degrees == 90
    assert copied.node.revision_id == draft.pk
    assert copied.node.room.revision_id == draft.pk
    assert copied.node.map_object_id == copied.node.room.map_object_id
    relationship = draft.relationships.get()
    assert relationship.reference_id == copied.pk
    assert relationship.room_id == copied.node.room_id


def test_weight_edit_validates_cost_and_cannot_modify_submitted_content(people):
    from maps.services.graph import GraphError, update_edge

    _, alice, _ = people
    draft = new_map(alice)
    revision = plan(draft)
    edge = revision.edges.get()
    assert update_edge(revision, edge_id=edge.pk, cost=7.5, actor=alice).cost == 7.5
    for cost in [-1, float("nan"), float("inf")]:
        with pytest.raises(GraphError):
            update_edge(revision, edge_id=edge.pk, cost=cost, actor=alice)
    submit(alice, draft.pk)
    with pytest.raises(GraphError):
        update_edge(revision, edge_id=edge.pk, cost=2, actor=alice)


def test_archival_can_destroy_a_pending_proposal_after_its_copy_is_published(people):
    admin, alice, _ = people
    first = new_map(alice)
    plan(first)
    submit(alice, first.pk)
    second = start_edit(alice, first.target_id)
    assert second.head_revision.nodes.count() == first.head_revision.nodes.count()
    assert second.head_revision.parent_id is None
    submit(alice, second.pk)
    review(admin, second.pk, "approved")
    archive(admin, first.target_id)
    assert not Contribution.objects.filter(pk=first.pk).exists()
    assert Publication.objects.filter(revision=second.head_revision).exists()


def test_my_maps_list_omits_underlay_preview_urls(people):
    """Card grid must not point img tags at full floor-plan assets."""
    _, alice, _ = people
    contribution = new_map(alice)
    plan(contribution)
    assert contribution.head_revision.source_asset_id
    from maps.services.workspace import card

    detail = card(contribution.target, contribution, include_preview=True)
    assert detail["preview_url"]
    listed = client_for(alice).get("/api/maps/workspace/").json()["maps"]
    assert len(listed) >= 1
    assert all(row.get("preview_url") is None for row in listed)


def test_create_api_requires_position_and_cannot_self_grant_admin(people):
    _, alice, _ = people
    client = client_for(alice)
    assert (
        client.post(
            "/api/maps/workspace/",
            {"building_name": "No position", "floor_code": "1"},
            format="json",
        ).status_code
        == 400
    )

    response = client.post(
        "/api/maps/workspace/",
        {
            "building_name": "Located building",
            "floor_code": "1",
            "latitude": 43.7,
            "longitude": -79.1,
            "role": "admin",
            "status": "published",
        },
        format="json",
    )
    assert response.status_code == 201
    assert response.json()["status"] == "draft"
    assert (
        Membership.objects.get(target_id=response.json()["target_id"], user=alice).role
        == "volunteer"
    )


def test_database_timestamps_accept_inserts_from_the_previous_release(people):
    from django.utils import timezone
    from maps.models import Floor

    admin, _, _ = people
    original = new_map(admin)
    floor = Floor.objects.create(
        building=original.target.floor.building, code="old", name="Old writer"
    )

    def insert(model, values):
        fields = [model._meta.get_field(name) for name in values]
        columns = ",".join(connection.ops.quote_name(field.column) for field in fields)
        placeholders = ",".join(["%s"] * len(fields))
        prepared = [
            field.get_db_prep_save(value, connection)
            for field, value in zip(fields, values.values(), strict=True)
        ]
        with connection.cursor() as cursor:
            cursor.execute(
                f"INSERT INTO {connection.ops.quote_name(model._meta.db_table)} "
                f"({columns}) VALUES ({placeholders})",
                prepared,
            )
        return model.objects.get(pk=values["id"])

    target = insert(
        MapTarget,
        {
            "id": uuid.uuid4(),
            "created_at": timezone.now(),
            "floor": floor.pk,
            "title": "Previous release target",
            "instructions": "",
            "status": "open",
            "created_by": admin.pk,
            "archived_at": None,
        },
    )
    contribution = insert(
        Contribution,
        {
            "id": uuid.uuid4(),
            "created_at": timezone.now(),
            "target": target.pk,
            "author": admin.pk,
            "title": "Previous release contribution",
            "status": "draft",
            "base_revision": None,
            "head_revision": None,
            "lock_version": 0,
            "submitted_at": None,
        },
    )
    assert target.updated_at is not None and contribution.updated_at is not None


@pytest.mark.skipif(connection.vendor != "postgresql", reason="PostgreSQL-only immutability guards")
def test_purge_flag_cannot_delete_open_or_unrelated_history(people):
    from django.db import IntegrityError

    admin, _, _ = people
    original = new_map(admin)
    plan(original)
    submit(admin, original.pk)
    with pytest.raises(IntegrityError), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('snapway.purge_target', %s, true)", [str(original.target_id)]
            )
        original.head_revision.nodes.all()._raw_delete("default")
