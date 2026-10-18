"""Image 2.5 optimize chain and demo vectorize (OpenAI mocked)."""

import io
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from maps.models import Asset
from maps.services import image_optimize as optimize_svc
from maps.services.workspace import create_map, start_edit
from PIL import Image
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db
ROOT = Path(__file__).resolve().parents[3]
FIGMA_SVG = ROOT / "docs/audits/assets/2026-10-17-figma-vectorization/figma-vector.svg"


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(username="opt", is_staff=True)


def client_for(user):
    client = APIClient()
    client.force_login(user)
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    return client


def png_file(name="floor.png", size=(64, 48), color="white"):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return SimpleUploadedFile(name, buf.getvalue(), content_type="image/png")


@pytest.fixture(autouse=True)
def fake_image_edit(monkeypatch):
    def _edit(*, image_bytes, content_type, prompt):
        assert image_bytes and prompt
        out = io.BytesIO()
        Image.new("RGB", (1536, 1024), "lightgrey").save(out, format="PNG")
        return out.getvalue()

    monkeypatch.setattr(optimize_svc, "edit_floor_image", _edit)


def test_optimize_upload_stores_source_and_standardized(user):
    contribution = create_map(
        user,
        {
            "building_name": "Optimize Lab",
            "floor_code": "2",
            "latitude": 43.788195,
            "longitude": -79.190593,
        },
    )
    client = client_for(user)
    response = client.post(
        f"/api/maps/workspace/targets/{contribution.target_id}/optimize/upload/",
        {"file": png_file()},
        format="multipart",
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["stage"] == "image_optimize"
    assert body["optimized_url"]
    assert body["source_url"]
    revision = start_edit(user, contribution.target_id).head_revision
    # Optimized raster is SoT; append-only Asset rows may leave an unused upload orphan.
    assert revision.source_asset_id == revision.standardized_asset_id
    assert revision.standardized_asset.kind == Asset.Kind.STANDARDIZED
    assert revision.standardized_asset.width == 1536
    listed = client.get("/api/maps/workspace/").json()["maps"]
    card = next(row for row in listed if row["target_id"] == str(contribution.target_id))
    assert card["authoring_stage"] == "image_optimize"
    assert card["edit_path"] == "/map-optimize"
    assert card["preview_kind"] == "optimize"


def test_regenerate_and_vectorize_demo(user):
    contribution = create_map(
        user,
        {
            "building_name": "Optimize Lab B",
            "floor_code": "9",
            "latitude": 43.1,
            "longitude": -79.1,
        },
    )
    client = client_for(user)
    target = contribution.target_id
    assert (
        client.post(
            f"/api/maps/workspace/targets/{target}/optimize/upload/",
            {"file": png_file()},
            format="multipart",
        ).status_code
        == 201
    )
    regen = client.post(f"/api/maps/workspace/targets/{target}/optimize/regenerate/", {}, format="json")
    assert regen.status_code == 200
    assert regen.json()["stage"] == "image_optimize"
    assert FIGMA_SVG.is_file()
    vector = client.post(f"/api/maps/workspace/targets/{target}/vectorize-demo/", {}, format="json")
    assert vector.status_code == 200, vector.content
    body = vector.json()
    assert body["mock"] is True
    assert body["floorId"] == "ia-4"
    assert body["stage"] == "vectorized_demo"
    assert "have not paid" in body["disclosure"]
    assert body["svg_url"]
