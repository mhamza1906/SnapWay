"""Django capture API contract (docs/photo-capture.md, "Django capture API")."""

import hashlib
import io
import json
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from capture.models import CaptureMapLink, CapturePhoto, CapturePoint
from capture.photo_store import MemoryPhotoStore, photo_store, signing_key
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.test import Client
from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart
from django.utils import timezone
from maps.models import Asset, Building, Floor, MapTarget, Membership
from PIL import Image

pytestmark = pytest.mark.django_db
API = "/api/capture"


@pytest.fixture(autouse=True)
def private_media(settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path / "media"
    MemoryPhotoStore.files.clear()


def make_target(building, floor_code, creator, map_building_id="fixture-building"):
    floor = Floor.objects.create(building=building, code=floor_code, name=floor_code)
    target = MapTarget.objects.create(
        floor=floor, title=f"Fixture {floor_code}", created_by=creator
    )
    CaptureMapLink.objects.create(
        target=target, map_building_id=map_building_id, map_floor_id=floor_code
    )
    return target


@pytest.fixture
def world():
    users = get_user_model().objects
    volunteer = users.create_user(username="volunteer", password="pw-volunteer")
    other = users.create_user(username="other-volunteer", password="pw-other")
    outsider = users.create_user(username="outsider", password="pw-outsider")
    revoked = users.create_user(username="revoked", password="pw-revoked")
    admin = users.create_user(username="target-admin", password="pw-admin")
    building = Building.objects.create(name="Fixture", slug="fixture", created_by=admin)
    floor1 = make_target(building, "floor-1", admin)
    floor2 = make_target(building, "floor-2", admin)
    for user, target, role in [
        (volunteer, floor1, "volunteer"),
        (other, floor2, "volunteer"),
        (revoked, floor1, "volunteer"),
        (admin, floor1, "admin"),
    ]:
        Membership.objects.create(target=target, user=user, role=role, granted_by=admin)
    Membership.objects.filter(user=revoked).update(revoked_at=timezone.now())
    return SimpleNamespace(
        volunteer=volunteer,
        other=other,
        outsider=outsider,
        revoked=revoked,
        admin=admin,
        floor1=floor1,
        floor2=floor2,
    )


def login(user):
    client = Client()
    client.force_login(user)
    return client


def put_json(client, url, body):
    return client.put(url, data=json.dumps(body), content_type="application/json")


def session_body(target, floor="floor-1", **overrides):
    return {
        "targetId": str(target.id),
        "mapBuildingId": "fixture-building",
        "mapFloorId": floor,
        "mapRevision": 3,
        "corridorId": "corridor-a",
        "direction": "forward",
        "spacingM": 2,
        **overrides,
    }


def point_body(**overrides):
    return {
        "order": 0,
        "planId": "plan-0",
        "mapRevision": 3,
        "edgeId": "edge-1",
        "nodeId": None,
        "referenceEdgeId": "edge-1",
        "fraction": 0.25,
        "corridorDistancePx": 40,
        "distanceM": 2.0,
        "forwardAngleDeg": 0,
        "plannedX": 100,
        "plannedY": 200,
        "confirmedX": 101,
        "confirmedY": 199,
        "positionSource": "contributor-confirmed",
        "reason": "spacing",
        **overrides,
    }


def jpeg(size=(400, 200), orientation=None, colours=("red", "blue")):
    """Left half / right half coloured image, optionally with an EXIF orientation tag."""
    image = Image.new("RGB", size, colours[1])
    image.paste(Image.new("RGB", (size[0] // 2, size[1]), colours[0]), (0, 0))
    buffer = io.BytesIO()
    if orientation:
        exif = Image.Exif()
        exif[0x0112] = orientation
        image.save(buffer, "JPEG", quality=95, exif=exif)
    else:
        image.save(buffer, "JPEG", quality=95)
    return buffer.getvalue()


SLOT_ANGLES = {"forward": 0, "right": 90, "backward": 180, "left": 270, "extra": 45}


def upload(client, point_id, photo_id, data, slot="forward", **meta):
    metadata = {
        "slot": slot,
        "viewingAngleDeg": SLOT_ANGLES.get(slot, 0),
        "directionSource": "manual-confirmed",
        "positionSource": "contributor-confirmed",
        "capturedAt": "2026-10-17T12:00:00Z",
        "clientSha256": hashlib.sha256(data).hexdigest(),
        **meta,
    }
    body = encode_multipart(
        BOUNDARY,
        {
            "image": SimpleUploadedFile("photo.jpg", data, content_type="image/jpeg"),
            "metadata": json.dumps(metadata),
        },
    )
    return client.put(
        f"{API}/points/{point_id}/photos/{photo_id}", data=body, content_type=MULTIPART_CONTENT
    )


@pytest.fixture
def started(world):
    """A volunteer session on floor-1 with one point."""
    client = login(world.volunteer)
    session_id, point_id = uuid.uuid4(), uuid.uuid4()
    assert (
        put_json(client, f"{API}/sessions/{session_id}", session_body(world.floor1)).status_code
        == 201
    )
    response = put_json(client, f"{API}/sessions/{session_id}/points/{point_id}", point_body())
    assert response.status_code == 201, response.content
    return SimpleNamespace(client=client, session_id=session_id, point_id=point_id)


def test_me_sets_csrf_cookie_and_reports_login_url(world):
    anonymous = Client()
    response = anonymous.get(f"{API}/me")
    assert response.status_code == 200
    assert response.json() == {
        "authenticated": False,
        "username": None,
        "loginUrl": "/accounts/login/?next=/capture",
        "targets": [],
    }
    assert "XSRF-TOKEN" in response.cookies
    me = login(world.volunteer).get(f"{API}/me").json()
    assert me["authenticated"] and me["username"] == "volunteer"
    assert me["targets"] == [
        {
            "id": str(world.floor1.id),
            "title": "Fixture floor-1",
            "role": "volunteer",
            "mapBuildingId": "fixture-building",
            "mapFloorId": "floor-1",
        }
    ]
    assert login(world.revoked).get(f"{API}/me").json()["targets"] == []


def test_authentication_required(world):
    anonymous = Client()
    session_id = uuid.uuid4()
    assert anonymous.get(f"{API}/sessions").status_code == 401
    assert (
        put_json(anonymous, f"{API}/sessions/{session_id}", session_body(world.floor1)).status_code
        == 401
    )
    assert anonymous.get(f"{API}/photos/{uuid.uuid4()}/thumbnail").status_code == 401


def test_writes_require_csrf_token(world):
    client = Client(enforce_csrf_checks=True)
    client.force_login(world.volunteer)
    url = f"{API}/sessions/{uuid.uuid4()}"
    assert put_json(client, url, session_body(world.floor1)).status_code == 403
    client.get(f"{API}/me")
    token = client.cookies["XSRF-TOKEN"].value
    response = client.put(
        url,
        data=json.dumps(session_body(world.floor1)),
        content_type="application/json",
        HTTP_X_XSRF_TOKEN=token,
    )
    assert response.status_code == 201


def test_anonymous_me_points_to_the_shared_sign_in(world):
    # Capture signs in through the app's allauth (Google) sign-in, not its own page.
    body = Client().get(f"{API}/me?next=/capture").json()
    assert body["authenticated"] is False
    assert body["loginUrl"].startswith("/accounts/login/?next=")
    assert "capture" in body["loginUrl"]


@pytest.mark.parametrize("who", ["outsider", "revoked"])
def test_non_member_and_revoked_member_are_forbidden(world, started, who):
    client = login(getattr(world, who))
    assert (
        put_json(client, f"{API}/sessions/{uuid.uuid4()}", session_body(world.floor1)).status_code
        == 403
    )
    assert client.get(f"{API}/sessions/{started.session_id}").status_code == 403
    assert client.get(f"{API}/sessions?targetId={world.floor1.id}").status_code == 403
    point_url = f"{API}/sessions/{started.session_id}/points/{uuid.uuid4()}"
    assert put_json(client, point_url, point_body()).status_code == 403
    assert upload(client, started.point_id, uuid.uuid4(), jpeg()).status_code == 403


def test_revoking_membership_blocks_existing_contributor(world, started):
    Membership.objects.filter(user=world.volunteer).update(revoked_at=timezone.now())
    assert started.client.get(f"{API}/sessions/{started.session_id}").status_code == 403
    assert started.client.get(f"{API}/sessions").json() == {"sessions": []}


def test_archived_target_is_forbidden(world, started):
    MapTarget.objects.filter(id=world.floor1.id).update(
        status="archived", archived_at=timezone.now()
    )
    assert started.client.get(f"{API}/sessions/{started.session_id}").status_code == 403


def test_floor_isolation(world, started):
    photo_id = uuid.uuid4()
    assert upload(started.client, started.point_id, photo_id, jpeg()).status_code == 201
    other = login(world.other)  # member of floor-2 only
    assert other.get(f"{API}/sessions/{started.session_id}").status_code == 403
    assert other.get(f"{API}/photos/{photo_id}/thumbnail").status_code == 403
    assert other.get(f"{API}/photos/{photo_id}/display").status_code == 403
    assert other.get(f"{API}/sessions").json() == {"sessions": []}
    assert other.get(f"{API}/sessions?targetId={world.floor1.id}").status_code == 403
    # A floor-1 member cannot open a session on floor-2, nor relabel floor-1 as floor-2.
    volunteer = started.client
    response = put_json(
        volunteer, f"{API}/sessions/{uuid.uuid4()}", session_body(world.floor2, "floor-2")
    )
    assert response.status_code == 403
    response = put_json(
        volunteer, f"{API}/sessions/{uuid.uuid4()}", session_body(world.floor1, "floor-2")
    )
    assert response.status_code == 400
    # Moving an existing session to another floor is a conflict.
    Membership.objects.create(
        target=world.floor2, user=world.volunteer, role="volunteer", granted_by=world.admin
    )
    response = put_json(
        volunteer, f"{API}/sessions/{started.session_id}", session_body(world.floor2, "floor-2")
    )
    assert response.status_code == 409


def test_other_contributor_cannot_write_but_target_admin_can_read(world, started):
    Membership.objects.create(
        target=world.floor1, user=world.other, role="volunteer", granted_by=world.admin
    )
    other = login(world.other)
    assert other.get(f"{API}/sessions/{started.session_id}").status_code == 403
    point_url = f"{API}/sessions/{started.session_id}/points/{uuid.uuid4()}"
    assert put_json(other, point_url, point_body()).status_code == 403
    admin = login(world.admin)
    assert admin.get(f"{API}/sessions/{started.session_id}").status_code == 200
    assert put_json(admin, point_url, point_body()).status_code == 403


def test_session_put_is_idempotent_and_listed(world, started):
    url = f"{API}/sessions/{started.session_id}"
    response = put_json(started.client, url, session_body(world.floor1, mapRevision=4))
    assert response.status_code == 200 and response.json()["mapRevision"] == 4
    listed = started.client.get(f"{API}/sessions?targetId={world.floor1.id}&mapFloorId=floor-1")
    assert [s["id"] for s in listed.json()["sessions"]] == [str(started.session_id)]
    assert started.client.get(f"{API}/sessions?mapFloorId=floor-9").json() == {"sessions": []}
    changed = put_json(started.client, url, session_body(world.floor1, corridorId="corridor-b"))
    assert changed.status_code == 409


def test_input_validation(world, started):
    url = f"{API}/sessions/{started.session_id}/points/{uuid.uuid4()}"
    for bad in [
        {"forwardAngleDeg": 360},
        {"forwardAngleDeg": -1},
        {"fraction": 1.5},
        {"positionSource": "gps"},
        {"confirmedX": 3, "confirmedY": None},
    ]:
        assert put_json(started.client, url, point_body(**bad)).status_code == 400, bad
    point = started.point_id
    assert (
        upload(
            started.client, point, uuid.uuid4(), jpeg(), slot="forward", viewingAngleDeg=400
        ).status_code
        == 400
    )
    assert upload(started.client, point, uuid.uuid4(), jpeg(), slot="up").status_code == 400
    assert (
        upload(
            started.client, point, uuid.uuid4(), jpeg(), slot="right", viewingAngleDeg=180
        ).status_code
        == 400
    )
    assert (
        upload(started.client, point, uuid.uuid4(), jpeg(), directionSource="compass").status_code
        == 400
    )
    assert (
        upload(started.client, point, uuid.uuid4(), jpeg(), clientSha256="0" * 64).status_code
        == 400
    )
    assert upload(started.client, point, uuid.uuid4(), b"GIF89a not really").status_code == 400
    gif = io.BytesIO()
    Image.new("RGB", (10, 10)).save(gif, "GIF")
    assert upload(started.client, point, uuid.uuid4(), gif.getvalue()).status_code == 400
    truncated = jpeg()[:200]
    assert upload(started.client, point, uuid.uuid4(), truncated).status_code == 400
    assert not CapturePhoto.objects.exists() and not Asset.objects.exists()


def test_upload_size_cap(settings, world, started):
    settings.CAPTURE_MAX_UPLOAD_BYTES = 1000
    assert upload(started.client, started.point_id, uuid.uuid4(), jpeg()).status_code == 413


def test_idempotent_retry_and_conflicting_retry(world, started):
    photo_id, data = uuid.uuid4(), jpeg()
    first = upload(started.client, started.point_id, photo_id, data)
    assert first.status_code == 201, first.content
    retry = upload(started.client, started.point_id, photo_id, data)
    assert retry.status_code == 200 and retry.json()["id"] == str(photo_id)
    assert CapturePhoto.objects.count() == 1 and Asset.objects.count() == 3
    different = upload(started.client, started.point_id, photo_id, jpeg(colours=("green", "white")))
    assert different.status_code == 409
    assert CapturePhoto.objects.get().sha256 == hashlib.sha256(data).hexdigest()
    assert Asset.objects.count() == 3


def test_new_photo_in_occupied_slot_replaces_older(world, started):
    first_id, second_id = uuid.uuid4(), uuid.uuid4()
    assert upload(started.client, started.point_id, first_id, jpeg()).status_code == 201
    second = upload(started.client, started.point_id, second_id, jpeg(colours=("white", "black")))
    assert second.status_code == 201
    first = CapturePhoto.objects.get(id=first_id)
    assert first.review_status == "replaced" and first.replaced_by_id == second_id
    assert CapturePhoto.objects.get(id=second_id).review_status == "pending"
    # Extra photos never replace each other.
    assert (
        upload(started.client, started.point_id, uuid.uuid4(), jpeg(), slot="extra").status_code
        == 201
    )
    assert (
        upload(started.client, started.point_id, uuid.uuid4(), jpeg(), slot="extra").status_code
        == 201
    )
    detail = started.client.get(f"{API}/sessions/{started.session_id}").json()
    assert {p["id"]: p["reviewStatus"] for p in detail["photos"]}[str(first_id)] == "replaced"
    assert detail["points"][0]["status"] == "partial"


def test_exif_rotated_image_is_stored_upright(world, started):
    photo_id = uuid.uuid4()
    raw = jpeg(size=(400, 200), orientation=6)  # camera held upright: rotate 90 deg clockwise
    response = upload(started.client, started.point_id, photo_id, raw)
    assert response.status_code == 201, response.content
    body = response.json()
    assert (body["width"], body["height"]) == (200, 400)
    photo = CapturePhoto.objects.select_related("original_asset", "display_asset").get(id=photo_id)
    assert photo.original_asset.sha256 == hashlib.sha256(raw).hexdigest()
    # original bytes kept as uploaded (unrotated)
    assert photo_store().open(photo.original_asset.storage_key) == raw
    assert (photo.original_asset.width, photo.original_asset.height) == (400, 200)
    display = started.client.get(f"{API}/photos/{photo_id}/display")
    assert display.status_code == 200 and display["Content-Type"] == "image/jpeg"
    with Image.open(io.BytesIO(display.content)) as image:
        assert image.size == (200, 400)
        top, bottom = image.getpixel((100, 20)), image.getpixel((100, 380))
    assert top[0] > 200 and top[2] < 60  # raw left (red) is now the top
    assert bottom[2] > 200 and bottom[0] < 60
    assert photo.display_asset.source_asset_id == photo.original_asset_id
    assert {a.kind for a in Asset.objects.all()} == {"photo"}
    assert all(a.storage_key.startswith("r2:") for a in Asset.objects.all())


def test_photos_are_never_written_to_local_disk(world, started, settings):
    response = upload(started.client, started.point_id, uuid.uuid4(), jpeg())
    assert response.status_code == 201, response.content
    assert not Path(settings.MEDIA_ROOT).exists() or not any(Path(settings.MEDIA_ROOT).rglob("*.*"))


def test_upload_without_r2_config_is_refused(world, started, settings, monkeypatch):
    settings.CAPTURE_PHOTO_STORE = "r2"
    monkeypatch.setattr("capture.photo_store.resolve_s3_options", lambda: None)
    photo_id = uuid.uuid4()
    response = upload(started.client, started.point_id, photo_id, jpeg())
    assert response.status_code == 503
    assert "R2_BUCKET_NAME" in response.json()["detail"]
    assert not CapturePhoto.objects.filter(id=photo_id).exists()


def test_display_and_thumbnail_sizes(world, started):
    photo_id = uuid.uuid4()
    assert (
        upload(started.client, started.point_id, photo_id, jpeg(size=(3000, 1000))).status_code
        == 201
    )
    thumb = started.client.get(f"{API}/photos/{photo_id}/thumbnail")
    assert thumb.status_code == 200 and thumb["Cache-Control"].startswith("private")
    with Image.open(io.BytesIO(thumb.content)) as image:
        assert max(image.size) == 320 and image.size == (320, 107)
    display = started.client.get(f"{API}/photos/{photo_id}/display")
    with Image.open(io.BytesIO(display.content)) as image:
        assert image.size == (2560, 853)
    small_id = uuid.uuid4()
    assert (
        upload(
            started.client, started.point_id, small_id, jpeg(size=(1600, 1200)), slot="right"
        ).status_code
        == 201
    )
    display = started.client.get(f"{API}/photos/{small_id}/display")
    with Image.open(io.BytesIO(display.content)) as image:
        assert image.size == (1600, 1200)  # no unnecessary downscale
    photo = CapturePhoto.objects.select_related("thumbnail_asset").get(id=photo_id)
    assert (photo.thumbnail_asset.width, photo.thumbnail_asset.height) == (320, 107)
    assert not photo.thumbnail_asset.storage_key.startswith("/")


def test_point_status_transitions(world, started):
    def status():
        return CapturePoint.objects.get(id=started.point_id).status

    assert status() == "empty"
    for index, slot in enumerate(["forward", "right", "backward"]):
        assert (
            upload(started.client, started.point_id, uuid.uuid4(), jpeg(), slot=slot).status_code
            == 201
        )
        assert status() == "partial", index
    assert (
        upload(started.client, started.point_id, uuid.uuid4(), jpeg(), slot="left").status_code
        == 201
    )
    assert status() == "complete"
    # Replacing a slot keeps the point complete.
    assert (
        upload(started.client, started.point_id, uuid.uuid4(), jpeg(), slot="left").status_code
        == 201
    )
    assert status() == "complete"


def test_point_put_is_idempotent_and_move_with_photos_conflicts(world, started):
    url = f"{API}/sessions/{started.session_id}/points/{started.point_id}"
    assert put_json(started.client, url, point_body()).status_code == 200
    # Without photos a point may still be adjusted.
    moved = put_json(
        started.client, url, point_body(confirmedX=120, positionSource="contributor-adjusted")
    )
    assert moved.status_code == 200 and moved.json()["confirmedX"] == 120
    assert (
        upload(
            started.client,
            started.point_id,
            uuid.uuid4(),
            jpeg(),
            positionSource="contributor-adjusted",
        ).status_code
        == 201
    )
    body = point_body(confirmedX=120, positionSource="contributor-adjusted")
    assert put_json(started.client, url, body).status_code == 200  # same values: retry
    assert (
        put_json(started.client, url, {**body, "order": 5}).status_code == 200
    )  # order may change
    conflict = put_json(started.client, url, {**body, "plannedX": 150})
    assert conflict.status_code == 409 and conflict.json()["fields"] == ["plannedX"]
    assert started.client.delete(url).status_code == 409
    assert CapturePoint.objects.filter(id=started.point_id).exists()


def test_delete_point_without_photos(world, started):
    url = f"{API}/sessions/{started.session_id}/points/{started.point_id}"
    assert started.client.delete(url).status_code == 204
    assert started.client.delete(url).status_code == 204  # retry
    assert not CapturePoint.objects.exists()


def test_revision_check_flags_and_keeps_coordinates(world, started):
    photo_id = uuid.uuid4()
    assert upload(started.client, started.point_id, photo_id, jpeg()).status_code == 201
    new_point = uuid.uuid4()
    url = f"{API}/sessions/{started.session_id}/points/{new_point}"
    assert put_json(started.client, url, point_body(order=1, mapRevision=4)).status_code == 201
    check_url = f"{API}/sessions/{started.session_id}/revision-check"
    response = started.client.post(
        check_url, data=json.dumps({"currentRevision": 4}), content_type="application/json"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["flaggedPoints"] == 1 and body["flaggedPhotos"] == 1
    points = {p["id"]: p for p in body["session"]["points"]}
    old = points[str(started.point_id)]
    assert old["status"] == "needs-review" and old["reviewReason"] == "map revision changed"
    assert (old["mapRevision"], old["plannedX"], old["plannedY"], old["confirmedX"]) == (
        3,
        100,
        200,
        101,
    )
    assert points[str(new_point)]["status"] == "empty"
    photo = CapturePhoto.objects.get(id=photo_id)
    assert photo.review_status == "needs-review" and photo.map_revision == 3
    assert (photo.position_x, photo.position_y) == (101, 199)
    # Repeating the check is a no-op; status stays needs-review after more uploads.
    again = started.client.post(
        check_url, data=json.dumps({"currentRevision": 4}), content_type="application/json"
    )
    assert again.json()["flaggedPoints"] == 0
    assert (
        upload(started.client, started.point_id, uuid.uuid4(), jpeg(), slot="right").status_code
        == 201
    )
    assert CapturePoint.objects.get(id=started.point_id).status == "needs-review"
    bad = started.client.post(
        check_url, data=json.dumps({"currentRevision": "4"}), content_type="application/json"
    )
    assert bad.status_code == 400


def test_seed_capture_demo_is_idempotent(world, settings, tmp_path, monkeypatch):
    from capture.management.commands import seed_capture_demo

    credentials = tmp_path / "creds.json"
    monkeypatch.setattr(seed_capture_demo, "CREDENTIALS", credentials)
    monkeypatch.setattr(seed_capture_demo, "ROOT", tmp_path)
    output = io.StringIO()
    call_command("seed_capture_demo", "demo-building", "floor-a", "floor-b", stdout=output)
    first = json.loads(credentials.read_text())
    call_command("seed_capture_demo", "demo-building", "floor-a", "floor-b", stdout=io.StringIO())
    assert json.loads(credentials.read_text()) == first
    for user in first["users"]:
        assert user["password"] not in output.getvalue()
    assert CaptureMapLink.objects.filter(map_building_id="demo-building").count() == 2
    demo = get_user_model().objects.get(username="capture-demo")
    assert Membership.objects.filter(user=demo, role="volunteer", revoked_at=None).count() == 2
    client = Client()
    password = next(u["password"] for u in first["users"] if u["username"] == "capture-demo")
    assert client.login(username="capture-demo", password=password)
    assert {t["mapFloorId"] for t in client.get(f"{API}/me").json()["targets"]} == {
        "floor-a",
        "floor-b",
    }
    call_command(
        "seed_capture_demo",
        "demo-building",
        "floor-a",
        "--unjoined-floor",
        "floor-b",
        stdout=io.StringIO(),
    )
    assert CaptureMapLink.objects.filter(map_building_id="demo-building").count() == 2
    assert [t["mapFloorId"] for t in client.get(f"{API}/me").json()["targets"]] == ["floor-a"]
    floor_b = CaptureMapLink.objects.get(map_floor_id="floor-b").target_id
    assert client.get(f"{API}/sessions?targetId={floor_b}").status_code == 403
    outsider = get_user_model().objects.get(username="capture-outsider")
    assert not Membership.objects.filter(user=outsider).exists()


@pytest.mark.skipif(connection.vendor != "postgresql", reason="PostgreSQL scope keys and triggers")
def test_postgresql_guards_capture_photo_assets(world, started):
    photo_id = uuid.uuid4()
    assert upload(started.client, started.point_id, photo_id, jpeg()).status_code == 201
    common = {"uploaded_by": world.volunteer, "content_type": "image/jpeg", "byte_size": 1}
    wrong_kind = Asset.objects.create(
        target=world.floor1, kind="capture", storage_key="x/kind", sha256="a" * 64, **common
    )
    other_target = Asset.objects.create(
        target=world.floor2, kind="photo", storage_key="x/target", sha256="b" * 64, **common
    )
    for asset in (wrong_kind, other_target):
        with pytest.raises(IntegrityError), transaction.atomic():
            CapturePhoto.objects.filter(id=photo_id).update(display_asset=asset)


def test_r2_signing_key_matches_the_aws_sigv4_example():
    # AWS's published Signature Version 4 example (IAM, us-east-1, 2012-02-15).
    key = signing_key("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam")
    assert key.hex() == "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
