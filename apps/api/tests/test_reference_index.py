import io
import json
import zipfile
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from maps.models import Asset, Revision, RevisionArtifact
from maps.services.draft import ensure_demo_draft
from maps.services.graph import add_node
from maps.services.reference_index import BACKEND_NAME, build_reference_index, compute_input_hash
from rest_framework.test import APIClient

User = get_user_model()


@pytest.fixture
def actors(db):
    member = User.objects.create_user(username="member", email="member@example.com", password="x")
    stranger = User.objects.create_user(
        username="stranger", email="stranger@example.com", password="x"
    )
    return {"member": member, "stranger": stranger}


@pytest.fixture
def draft(actors):
    return ensure_demo_draft(actors["member"])


def _tiny_png() -> bytes:
    import io

    from PIL import Image

    raw = io.BytesIO()
    Image.new("RGB", (1, 1), "white").save(raw, format="PNG")
    return raw.getvalue()


def _fake_run_build(*, references_dir: Path, work_root: Path, set_name: str) -> dict:
    photos = sorted(p for p in references_dir.rglob("*") if p.is_file())
    assert photos, "expected materialized photos"
    index_dir = work_root / set_name / "index" / "megaloc_fake"
    index_dir.mkdir(parents=True)
    image_ids = []
    for path in photos:
        rel = path.relative_to(references_dir).as_posix()
        image_ids.append(f"reference:{rel}")
    (index_dir / "vectors.npy").write_bytes(b"FAKE_MEGALOC_VECTORS")
    (index_dir / "index.txt").write_text(
        "megaloc:test\n" + "\n".join(image_ids) + "\n", encoding="utf-8"
    )
    meta = {
        "backend_key": "megaloc:test",
        "n_references": len(image_ids),
        "n_locations": len({p.parent.name for p in photos}),
        "dim": 8,
        "built_at": "2026-10-17T00:00:00Z",
    }
    (index_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return {"built": True, "index": str(index_dir), **meta, "backend": "megaloc"}


def _developer_client(user) -> APIClient:
    client = APIClient()
    client.force_login(user)
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    return client


def _attach_photo(client, revision_id, node_id):
    url = reverse(
        "map-revision-node-photos",
        kwargs={"revision_id": revision_id, "node_id": node_id},
    )
    response = client.post(
        url,
        {"file": SimpleUploadedFile("ref.png", _tiny_png(), content_type="image/png")},
        format="multipart",
    )
    assert response.status_code == 201
    return response.json()


@pytest.mark.django_db
def test_compute_input_hash_stable_order():
    a = [("b", "sha2", "n1"), ("a", "sha1", "n2")]
    b = [("a", "sha1", "n2"), ("b", "sha2", "n1")]
    assert compute_input_hash(a) == compute_input_hash(b)
    assert compute_input_hash(a) != compute_input_hash(a, backend_name="other")


@pytest.mark.django_db
def test_build_index_ready_and_skip(actors, draft, settings, tmp_path, monkeypatch):
    settings.MEDIA_ROOT = tmp_path
    monkeypatch.setattr(
        "maps.services.reference_index.run_megaloc_build",
        _fake_run_build,
    )
    revision = Revision.objects.get(pk=draft["revision_id"])
    n1 = add_node(revision, x=1, y=1, label="A", actor=actors["member"])
    n2 = add_node(revision, x=2, y=2, label="B", actor=actors["member"])
    client = _developer_client(actors["member"])
    _attach_photo(client, draft["revision_id"], n1.id)
    _attach_photo(client, draft["revision_id"], n2.id)

    first = build_reference_index(revision, actor=actors["member"])
    assert first["state"] == "ready"
    assert first["skipped"] is False
    assert first["asset_id"]
    assert first["profile"]["backend_name"] == BACKEND_NAME

    artifact = RevisionArtifact.objects.get(revision=revision, kind="index")
    assert artifact.asset.kind == Asset.Kind.INDEX
    raw = Path(settings.MEDIA_ROOT, artifact.asset.storage_key).read_bytes()
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = set(zf.namelist())
    assert {"vectors.npy", "index.txt", "meta.json", "locations.json"} <= names

    second = build_reference_index(revision, actor=actors["member"])
    assert second["skipped"] is True
    assert second["asset_id"] == first["asset_id"]


@pytest.mark.django_db
def test_build_index_api(actors, draft, settings, tmp_path, monkeypatch):
    settings.MEDIA_ROOT = tmp_path
    monkeypatch.setattr(
        "maps.services.reference_index.run_megaloc_build",
        _fake_run_build,
    )
    revision = Revision.objects.get(pk=draft["revision_id"])
    node = add_node(revision, x=3, y=4, actor=actors["member"])
    client = _developer_client(actors["member"])
    _attach_photo(client, draft["revision_id"], node.id)

    url = reverse("map-revision-index", kwargs={"revision_id": draft["revision_id"]})
    empty = client.get(url)
    assert empty.status_code == 200
    assert empty.json()["state"] is None

    built = client.post(url)
    assert built.status_code == 200
    body = built.json()
    assert body["state"] == "ready"
    assert body["skipped"] is False

    status = client.get(url)
    assert status.status_code == 200
    assert status.json()["state"] == "ready"


@pytest.mark.django_db
def test_stranger_cannot_build_index(actors, draft, settings, tmp_path, monkeypatch):
    settings.MEDIA_ROOT = tmp_path
    monkeypatch.setattr(
        "maps.services.reference_index.run_megaloc_build",
        _fake_run_build,
    )
    revision = Revision.objects.get(pk=draft["revision_id"])
    node = add_node(revision, x=1, y=1, actor=actors["member"])
    member = _developer_client(actors["member"])
    _attach_photo(member, draft["revision_id"], node.id)

    stranger = _developer_client(actors["stranger"])
    response = stranger.post(
        reverse("map-revision-index", kwargs={"revision_id": draft["revision_id"]})
    )
    assert response.status_code == 403


@pytest.mark.django_db
def test_build_index_fails_without_photos(actors, draft):
    client = _developer_client(actors["member"])
    response = client.post(
        reverse("map-revision-index", kwargs={"revision_id": draft["revision_id"]})
    )
    assert response.status_code == 400
