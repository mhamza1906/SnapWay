"""FloorConnector model + workspace read API for cross-floor stair/lift links."""

import pytest
from django.contrib.auth import get_user_model
from maps.models import FloorConnector
from maps.services.workspace import create_map
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db


@pytest.fixture
def author():
    return get_user_model().objects.create_user(username="erfang", email="erfang@example.com")


def _developer_client(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user)
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    return client


def test_building_connectors_lists_stair_and_lift_endpoints(author):
    contribution = create_map(
        author,
        {
            "building_name": "IA Test",
            "floor_code": "1",
            "floor_name": "Level 1",
            "latitude": 43.788195,
            "longitude": -79.190593,
        },
    )
    building = contribution.target.floor.building
    FloorConnector.objects.create(
        building=building,
        code="stair-a",
        kind="stairs",
        label="Stair A",
        endpoints=[
            {
                "floor_code": "1",
                "target_id": str(contribution.target_id),
                "node_id": "11111111-1111-4111-8111-111111111111",
                "node_stable_id": "aaaaaaaa-0001-4000-8000-0000000000a1",
                "label": "Stair A",
            }
        ],
    )
    response = _developer_client(author).get(
        f"/api/maps/workspace/buildings/{building.id}/connectors/"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["building_id"] == str(building.id)
    assert len(body["connectors"]) == 1
    assert body["connectors"][0]["code"] == "stair-a"
    assert body["connectors"][0]["kind"] == "stairs"
    assert body["connectors"][0]["endpoints"][0]["floor_code"] == "1"
