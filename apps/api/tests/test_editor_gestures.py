"""Editor gestures must be atomic, snapshot-scoped and safe for photo slots."""

import io
import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from maps.models import ReferencePhoto, Revision
from maps.services.draft import ensure_demo_draft
from maps.services.editor import EditorConflict, edit_graph
from maps.services.graph import (
    GraphError,
    GraphPermissionError,
    add_node,
    freeze_revision,
    list_graph,
)
from maps.services.references import attach_node_photo, list_node_photos
from PIL import Image
from rest_framework.test import APIClient


@pytest.fixture
def scene(db, settings, tmp_path, monkeypatch):
    settings.MEDIA_ROOT = tmp_path
    # These gesture tests isolate editor semantics. Real R2 adapter/signing and
    # refusal without R2 are covered by test_node_media.py.
    monkeypatch.setattr("maps.services.references.point_photo_storage_ready", lambda: True)
    user = get_user_model().objects.create_user(username="editor-test")
    draft = ensure_demo_draft(user)
    revision = Revision.objects.get(pk=draft["revision_id"])
    a = add_node(revision, x=20, y=30, label="Door A", actor=user, kind="door")
    b = add_node(revision, x=80, y=50, label="Junction", actor=user, kind="junction")
    return user, revision, a, b


def commit(scene, **data):
    user, revision, *_ = scene
    return edit_graph(
        revision,
        data={"expected_version": list_graph(revision)["lock_version"], **data},
        actor=user,
    )


def photo():
    raw = io.BytesIO()
    Image.new("RGB", (8, 8), "blue").save(raw, format="PNG")
    return SimpleUploadedFile("QA-not-a-site-photo.png", raw.getvalue(), content_type="image/png")


def test_group_move_and_two_way_connection_are_persistent(scene):
    _, revision, a, b = scene
    graph = commit(
        scene,
        nodes=[{"id": str(a.id), "x": 40, "y": 60}, {"id": str(b.id), "x": 100, "y": 80}],
        connect=[{"from": str(a.id), "to": str(b.id), "both": True}],
    )
    assert len(graph["edges"]) == 2
    a.refresh_from_db()
    b.refresh_from_db()
    assert (a.x, a.y, b.x, b.y) == (40, 60, 100, 80)
    assert len(list_graph(revision)["nodes"]) == 2


def test_create_nodes_supports_restoring_a_known_id(scene):
    user, revision, *_ = scene
    node_id = str(uuid.uuid4())
    before = list_graph(revision)["lock_version"]
    graph = commit(
        scene,
        create_nodes=[{"id": node_id, "x": 12, "y": 18, "label": "Restored", "kind": "checkpoint"}],
    )
    assert any(n["id"] == node_id and n["label"] == "Restored" for n in graph["nodes"])
    # One writable lock for the whole gesture, not one per helper call.
    assert graph["lock_version"] == before + 1
    assert list_graph(revision)["lock_version"] == before + 1
    # Actor still required for the outer edit_graph lock.
    assert user.is_authenticated


def test_failed_gesture_rolls_back_every_node_and_version(scene):
    _, revision, a, b = scene
    before = list_graph(revision)
    with pytest.raises(GraphError):
        commit(
            scene, nodes=[{"id": str(a.id), "x": 55, "y": 55}, {"id": str(b.id), "x": -1, "y": 9}]
        )
    assert list_graph(revision) == before


def test_foreign_node_and_stale_version_do_not_change_snapshot(scene):
    user, revision, a, _ = scene
    before = list_graph(revision)
    with pytest.raises(GraphError):
        commit(
            scene,
            nodes=[
                {"id": str(a.id), "x": 42, "y": 42},
                {"id": str(uuid.uuid4()), "label": "foreign"},
            ],
        )
    assert list_graph(revision) == before
    commit(scene, nodes=[{"id": str(a.id), "label": "new label"}])
    with pytest.raises(EditorConflict):
        edit_graph(
            revision,
            data={"expected_version": before["lock_version"], "delete_nodes": [str(a.id)]},
            actor=user,
        )
    assert revision.nodes.filter(pk=a.id, label="new label").exists()


def test_delete_selection_also_removes_incident_edges_and_photos(scene):
    user, revision, a, b = scene
    attach_node_photo(revision, node_id=a.id, uploaded_file=photo(), actor=user, direction="front")
    commit(scene, connect=[{"from": str(a.id), "to": str(b.id), "both": True}])
    result = commit(scene, delete_nodes=[str(a.id)])
    assert not result["edges"] and len(result["nodes"]) == 1
    assert not ReferencePhoto.objects.filter(node=a).exists()


def test_four_direction_slots_replace_and_preserve_declared_frame(scene):
    user, revision, a, _ = scene
    for direction in ["front", "right", "back", "left"]:
        attach_node_photo(
            revision, node_id=a.id, uploaded_file=photo(), actor=user, direction=direction
        )
    first = ReferencePhoto.objects.get(node=a, capture_context__direction="front").id
    attach_node_photo(revision, node_id=a.id, uploaded_file=photo(), actor=user, direction="front")
    refs = list_node_photos(revision, node_id=a.id, actor=user)
    assert len(refs) == 4 and not ReferencePhoto.objects.filter(pk=first).exists()
    assert {r["direction"]: r["heading_degrees"] for r in refs} == {
        "front": 0,
        "right": 90,
        "back": 180,
        "left": 270,
    }
    assert all(
        r["capture_context"]["heading_frame"] == "plan_up_clockwise"
        and r["embedding_status"] == "not_connected"
        for r in refs
    )
    assert all(r["byte_size"] > 0 for r in refs)


def test_invalid_photo_and_direction_leave_no_rows(scene):
    user, revision, a, _ = scene
    with pytest.raises(GraphError):
        attach_node_photo(
            revision, node_id=a.id, uploaded_file=photo(), actor=user, direction="north-ish"
        )
    with pytest.raises(GraphError):
        attach_node_photo(
            revision,
            node_id=a.id,
            uploaded_file=SimpleUploadedFile("bad.png", b"not an image", content_type="image/png"),
            actor=user,
            direction="front",
        )
    assert not revision.references.exists()


def test_frozen_and_foreign_author_cannot_move_or_upload(scene):
    user, revision, a, _ = scene
    stranger = get_user_model().objects.create_user(username="other-editor")
    with pytest.raises(GraphPermissionError):
        edit_graph(
            revision,
            data={"expected_version": list_graph(revision)["lock_version"]},
            actor=stranger,
        )
    freeze_revision(revision)
    with pytest.raises(GraphError):
        commit(scene, nodes=[{"id": str(a.id), "x": 4, "y": 5}])
    with pytest.raises(GraphError):
        attach_node_photo(
            revision, node_id=a.id, uploaded_file=photo(), actor=user, direction="front"
        )


def test_editor_http_returns_409_for_stale_tab_and_accepts_multipart_directions(scene):
    user, revision, a, _ = scene
    client = APIClient()
    client.force_login(user)
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    url = f"/api/maps/revisions/{revision.id}/graph/"
    version = client.get(url).json()["lock_version"]
    request = {"expected_version": version, "nodes": [{"id": str(a.id), "x": 25, "y": 35}]}
    assert client.patch(url, request, format="json").status_code == 200
    assert client.patch(url, request, format="json").status_code == 409
    photo_url = f"/api/maps/revisions/{revision.id}/nodes/{a.id}/photos/"
    response = client.post(photo_url, {"file": photo(), "direction": "left"}, format="multipart")
    assert response.status_code == 201 and response.json()["heading_degrees"] == 270
    assert client.get(photo_url).json()["photos"][0]["direction"] == "left"


def test_photo_walk_directions_do_not_invent_plan_bearings(scene):
    user, revision, a, _ = scene
    revision.geometry = {"photo_walk_source": "sam-ibrahim:Level-1:adaptive-40-v1"}
    revision.save(update_fields=["geometry"])
    attached = attach_node_photo(
        revision, node_id=a.id, uploaded_file=photo(), actor=user, direction="right"
    )
    assert attached["direction"] == "right"
    assert attached["heading_degrees"] is None
    assert attached["capture_context"]["heading_frame"] == "walking_relative"
    from navigation.services.routing import photo_heading

    assert photo_heading(ReferencePhoto.objects.get(pk=attached["id"])) is None


def test_new_photo_walk_can_declare_relative_direction_without_import_marker(scene):
    user, revision, a, _ = scene
    assert not revision.geometry.get("photo_walk_source")
    result = attach_node_photo(
        revision,
        node_id=a.id,
        uploaded_file=photo(),
        actor=user,
        direction="left",
        direction_frame="walking_relative",
    )
    assert result["heading_degrees"] is None
    assert result["capture_context"]["heading_frame"] == "walking_relative"


@pytest.mark.parametrize("direction_frame", ["", "north", 42, {}, []])
def test_invalid_direction_frame_keeps_graph_and_storage_untouched(scene, direction_frame):
    user, revision, a, _ = scene
    before = list_graph(revision)
    with pytest.raises(GraphError, match="direction_frame"):
        attach_node_photo(
            revision,
            node_id=a.id,
            uploaded_file=photo(),
            actor=user,
            direction="front",
            direction_frame=direction_frame,
        )
    assert list_graph(revision) == before
    assert not revision.references.exists()
    assert not revision.target.assets.filter(kind="photo").exists()


def test_imported_walk_cannot_be_mislabeled_as_absolute_plan_direction(scene):
    user, revision, a, _ = scene
    revision.geometry = {"photo_walk_source": "sam-ibrahim:L1:adaptive-40-v1"}
    revision.save(update_fields=["geometry"])
    with pytest.raises(GraphError, match="walking-relative"):
        attach_node_photo(
            revision,
            node_id=a.id,
            uploaded_file=photo(),
            actor=user,
            direction="front",
            direction_frame="plan",
        )
    assert not revision.references.exists()


def test_photo_upload_transport_validates_and_preserves_direction_frame(scene):
    user, revision, a, _ = scene
    client = APIClient()
    client.force_login(user)
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    url = f"/api/maps/revisions/{revision.id}/nodes/{a.id}/photos/"
    before = list_graph(revision)
    invalid = client.post(
        url, {"file": photo(), "direction": "front", "direction_frame": "north"}, format="multipart"
    )
    assert invalid.status_code == 400
    assert list_graph(revision) == before
    response = client.post(
        url,
        {"file": photo(), "direction": "right", "direction_frame": "walking_relative"},
        format="multipart",
    )
    assert response.status_code == 201
    assert response.json()["heading_degrees"] is None
    assert response.json()["capture_context"]["heading_frame"] == "walking_relative"
