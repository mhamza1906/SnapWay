"""Published graph routing, scoped localization handoff and cross-floor permissions."""

from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.core import signing
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from maps.models import (
    Asset,
    Building,
    Contribution,
    Edge,
    Floor,
    FloorConnection,
    MapObject,
    MapTarget,
    Membership,
    Node,
    Publication,
    ReferencePhoto,
    Review,
    Revision,
    RevisionArtifact,
    Room,
)
from navigation.models import NavigationSession
from navigation.services.routing import RouteUnavailable, relative_angle, shortest_path
from navigation.views_routing import LOCATION_SALT
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db


@pytest.fixture
def graph():
    user = get_user_model().objects.create_user(username="route-author")
    building = Building.objects.create(name="Route building", slug="route", created_by=user)
    floors = []
    for number in (1, 2):
        floor = Floor.objects.create(building=building, code=str(number), name=f"Floor {number}")
        target = MapTarget.objects.create(floor=floor, title=f"Floor {number}", created_by=user)
        Membership.objects.create(target=target, user=user, granted_by=user, role="admin")
        contribution = Contribution.objects.create(target=target, author=user, title="Route map")
        revision = Revision.objects.create(
            target=target,
            contribution=contribution,
            created_by=user,
            coordinate_frame={"origin": "top-left", "y_axis": "down"},
        )
        nodes = {}
        for kind, x, y in [("checkpoint", 0, 100), ("stairs", 100, 0), ("lift", 0, 0)]:
            nodes[kind] = Node.objects.create(revision=revision, kind=kind, x=x, y=y, label=kind)
        obj = MapObject.objects.create(revision=revision, kind="room")
        room = Room.objects.create(revision=revision, map_object=obj, number="201")
        nodes["room"] = Node.objects.create(
            revision=revision, kind="room", room=room, x=100, y=100, label="Room 201"
        )
        for kind, cost in [("stairs", 1), ("lift", 4)]:
            for source, dest in [(nodes["checkpoint"], nodes[kind]), (nodes[kind], nodes["room"])]:
                Edge.objects.create(
                    revision=revision,
                    from_node=source,
                    to_node=dest,
                    cost=cost,
                    is_verified=True,
                )
        asset = Asset.objects.create(
            target=target,
            uploaded_by=user,
            kind="photo",
            storage_key=f"route/{number}.jpg",
            sha256="a" * 64,
            content_type="image/jpeg",
            byte_size=100,
        )
        ReferencePhoto.objects.create(
            revision=revision,
            node=nodes["checkpoint"],
            asset=asset,
            status="reviewed",
            reviewed_by=user,
            reviewed_at=timezone.now(),
            capture_context={"direction": "front", "heading_frame": "plan_up_clockwise"},
        )
        ReferencePhoto.objects.create(
            revision=revision,
            node=nodes["checkpoint"],
            asset=asset,
            status="proposed",
            heading_degrees=45,
            capture_context={"direction": "front", "heading_frame": "plan_up_clockwise"},
        )
        revision.content_hash = "a" * 64
        revision.frozen_at = timezone.now()
        revision.save(update_fields=["content_hash", "frozen_at"])
        Contribution.objects.filter(pk=contribution.pk).update(
            head_revision=revision, status="submitted"
        )
        review = Review.objects.create(revision=revision, reviewer=user, decision="approved")
        svg = Asset.objects.create(
            target=target,
            uploaded_by=user,
            kind="svg",
            storage_key=f"route/{number}.svg",
            sha256="a" * 64,
            content_type="image/svg+xml",
            byte_size=100,
        )
        RevisionArtifact.objects.create(
            revision=revision, kind="svg", state="ready", asset=svg, input_content_hash="a" * 64
        )
        publication = Publication.objects.create(
            target=target,
            revision=revision,
            approval=review,
            published_by=user,
            sequence=1,
            is_current=True,
        )
        floors.append(SimpleNamespace(nodes=nodes, revision=revision, publication=publication))
    for kind, cost in [("stairs", 2), ("lift", 1)]:
        FloorConnection.objects.create(
            from_node=floors[0].nodes[kind],
            to_node=floors[1].nodes[kind],
            cost=cost,
            created_by=user,
            is_verified=True,
        )
    return SimpleNamespace(user=user, floors=floors)


def route_body(graph, *, floor=0, preference="any"):
    start = graph.floors[0]
    destination = graph.floors[floor]
    return {
        "publication_id": str(destination.publication.id),
        "destination_id": str(destination.nodes["room"].stable_id),
        "preference": preference,
        "localization_token": signing.dumps(
            {
                "node_id": str(start.nodes["checkpoint"].id),
                "revision_id": str(start.revision.id),
            },
            salt=LOCATION_SALT,
        ),
    }


def test_weighted_route_and_photo_angle(graph):
    response = APIClient().post("/api/navigation/photo-route/", route_body(graph), format="json")
    assert response.status_code == 200
    body = response.json()
    assert body["total_cost"] == 2
    assert [row["label"] for row in body["frames"]] == ["checkpoint", "stairs", "Room 201"]
    assert body["frames"][0]["next_angle"] == 45
    assert body["frames"][0]["image_url"].startswith("/media/")
    assert body["frames"][1]["image_url"] is None
    assert body["frames"][1]["next_angle"] is None
    assert response["Cache-Control"] == "no-store"


@pytest.mark.parametrize(
    "preference,kind,cost",
    [("any", "stairs", 4), ("avoid_stairs", "lift", 9), ("avoid_elevators", "stairs", 4)],
)
def test_cross_floor_shortest_path_and_preferences(graph, preference, kind, cost):
    response = APIClient().post(
        "/api/navigation/photo-route/",
        route_body(graph, floor=1, preference=preference),
        format="json",
    )
    assert response.status_code == 200
    assert response.data["total_cost"] == cost
    assert response.data["frames"][1]["label"] == kind
    assert response.data["frames"][1]["transition"] is True
    assert response.data["frames"][1]["next_angle"] is None
    assert "Floor 2" in response.data["frames"][1]["instruction"]


def test_closed_unverified_and_reverse_connections_are_not_routed(graph):
    FloorConnection.objects.update(is_open=False)
    response = APIClient().post(
        "/api/navigation/photo-route/", route_body(graph, floor=1), format="json"
    )
    assert response.status_code == 409
    FloorConnection.objects.update(is_open=True, is_verified=False)
    assert (
        APIClient()
        .post("/api/navigation/photo-route/", route_body(graph, floor=1), format="json")
        .status_code
        == 409
    )
    nodes = {"a": SimpleNamespace(kind="checkpoint"), "b": SimpleNamespace(kind="room")}
    with pytest.raises(RouteUnavailable):
        shortest_path(nodes, [("a", "b", 1)], "b", "a")


def test_rejects_untrusted_handoff_invalid_preferences_and_retired_maps(graph):
    body = route_body(graph)
    body["localization_token"] = "forged"
    assert APIClient().post("/api/navigation/photo-route/", body, format="json").status_code == 400
    body = route_body(graph, preference="avoid_both")
    assert APIClient().post("/api/navigation/photo-route/", body, format="json").status_code == 400
    Publication.objects.filter(pk=graph.floors[0].publication.id).update(is_current=False)
    assert (
        APIClient()
        .post("/api/navigation/photo-route/", route_body(graph), format="json")
        .status_code
        == 409
    )


def test_guest_session_stores_only_digest_and_accepts_published_map(graph):
    response = APIClient().post(
        "/api/navigation/sessions/",
        {"publication_id": str(graph.floors[0].publication.id)},
        format="json",
    )
    assert response.status_code == 201
    session = NavigationSession.objects.get()
    assert session.token_hash != response.data["token"]
    assert len(session.token_hash) == 64
    assert response["Cache-Control"] == "no-store"


def test_connection_creation_requires_both_floor_admin_roles(graph):
    client = APIClient()
    body = {
        "from_node_id": str(graph.floors[1].nodes["lift"].id),
        "to_node_id": str(graph.floors[0].nodes["lift"].id),
        "cost": 3,
    }
    assert client.post("/api/navigation/floor-connections/", body).status_code == 403
    client.force_authenticate(graph.user)
    Membership.objects.filter(target=graph.floors[0].revision.target).update(role="volunteer")
    assert client.post("/api/navigation/floor-connections/", body).status_code == 403
    Membership.objects.update(role="admin")
    assert client.post("/api/navigation/floor-connections/", body).status_code == 201
    body["to_node_id"] = str(graph.floors[0].nodes["stairs"].id)
    assert client.post("/api/navigation/floor-connections/", body).status_code == 400


def test_photo_relative_angles():
    assert relative_angle(90, 0) == -90
    assert relative_angle(270, 0) == 90
    assert relative_angle(None, 45) is None


def test_expired_location_requires_recapture(graph, monkeypatch):
    import time

    body = route_body(graph)
    future = time.time() + 1900
    monkeypatch.setattr(signing.time, "time", lambda: future)
    response = APIClient().post("/api/navigation/photo-route/", body, format="json")
    assert response.status_code == 400
    assert "expired" in response.data["detail"]


def test_visitor_catalog_excludes_other_floors_drafts_and_buildings(graph):
    from navigation.views import _visitor_entries

    session = NavigationSession(publication=graph.floors[0].publication)
    entries = [SimpleNamespace(revision_id=str(floor.revision.id)) for floor in graph.floors]
    entries.append(SimpleNamespace(revision_id="private-or-unpublished-revision"))
    assert _visitor_entries(SimpleNamespace(auth=session), entries) == entries[:2]


def test_postgresql_rejects_invalid_cross_floor_link(graph):
    if connection.vendor != "postgresql":
        pytest.skip("PostgreSQL trigger enforcement")
    with pytest.raises(IntegrityError), transaction.atomic():
        FloorConnection.objects.create(
            from_node=graph.floors[0].nodes["checkpoint"],
            to_node=graph.floors[1].nodes["checkpoint"],
            cost=1,
            created_by=graph.user,
        )
