"""Unit tests for Dijkstra routing and template directions."""

from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from maps.models import Edge, Node
from navigation.services.directions import path_payload
from navigation.services.routing import shortest_path
from test_google_integration import publish

pytestmark = pytest.mark.django_db


def _graph(user):
    def populate(revision):
        a = Node.objects.create(
            revision=revision,
            kind=Node.Kind.JUNCTION,
            x=0,
            y=0,
            label="Start",
            stable_id=uuid.uuid4(),
        )
        b = Node.objects.create(
            revision=revision,
            kind=Node.Kind.JUNCTION,
            x=10,
            y=0,
            label="Mid",
            stable_id=uuid.uuid4(),
        )
        c = Node.objects.create(
            revision=revision,
            kind=Node.Kind.JUNCTION,
            x=20,
            y=0,
            label="End",
            stable_id=uuid.uuid4(),
        )
        d = Node.objects.create(
            revision=revision,
            kind=Node.Kind.JUNCTION,
            x=10,
            y=10,
            label="Detour",
            stable_id=uuid.uuid4(),
        )
        Edge.objects.create(
            revision=revision, from_node=a, to_node=b, cost=1, distance_metres=10, is_open=True
        )
        Edge.objects.create(
            revision=revision, from_node=b, to_node=c, cost=1, distance_metres=10, is_open=True
        )
        Edge.objects.create(
            revision=revision, from_node=a, to_node=d, cost=5, distance_metres=50, is_open=True
        )
        Edge.objects.create(
            revision=revision, from_node=d, to_node=c, cost=5, distance_metres=50, is_open=True
        )
        revision._test_nodes = (a, b, c, d)  # type: ignore[attr-defined]

    publication = publish(user, populate_revision=populate)
    a, b, c, d = publication.revision._test_nodes  # type: ignore[attr-defined]
    return publication, a, b, c, d


def test_dijkstra_prefers_cheaper_corridor():
    user = get_user_model().objects.create_user(username="route-u")
    publication, a, _b, c, _d = _graph(user)
    path = shortest_path(revision=publication.revision, start=a, goal=c)
    assert path.error == ""
    assert len(path.hops) == 2
    assert path.total_cost == 2.0
    payload = path_payload(path, start=a, destination=c)
    assert payload["ok"]
    assert payload["steps"][0]["from_stable_id"] == str(a.stable_id)
    assert payload["steps"][-1]["to_stable_id"] == str(c.stable_id)
    assert "Head toward" in payload["instructions_text"]


def test_dijkstra_unreachable():
    user = get_user_model().objects.create_user(username="route-u2")
    publication, a, _b, _c, _d = _graph(user)
    isolated = Node.objects.create(
        revision=publication.revision,
        kind=Node.Kind.JUNCTION,
        x=99,
        y=99,
        label="Island",
        stable_id=uuid.uuid4(),
    )
    path = shortest_path(revision=publication.revision, start=a, goal=isolated)
    assert path.error == "unreachable"
    payload = path_payload(path, start=a, destination=isolated)
    assert payload["ok"] is False
    assert payload["error"] == "unreachable"


def test_same_node_is_empty_path():
    user = get_user_model().objects.create_user(username="route-u3")
    publication, a, *_ = _graph(user)
    path = shortest_path(revision=publication.revision, start=a, goal=a)
    assert path.error == ""
    assert path.hops == []
    payload = path_payload(path, start=a, destination=a)
    assert payload["instructions_text"] == "You are already at your destination."
