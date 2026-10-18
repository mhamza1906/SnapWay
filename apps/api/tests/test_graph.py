import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from maps.models import Node
from maps.services.draft import ensure_demo_draft
from maps.services.graph import GraphError, add_edge, add_node, freeze_revision, remove_node
from rest_framework.test import APIClient

User = get_user_model()


@pytest.fixture
def actors(db):
    staff = User.objects.create_user(
        username="staff", email="staff@example.com", password="x", is_staff=True
    )
    member = User.objects.create_user(username="member", email="member@example.com", password="x")
    stranger = User.objects.create_user(
        username="stranger", email="stranger@example.com", password="x"
    )
    return {"staff": staff, "member": member, "stranger": stranger}


@pytest.fixture
def draft(actors):
    return ensure_demo_draft(actors["member"])


@pytest.mark.django_db
def test_ensure_creates_target_for_authenticated_user(actors):
    client = APIClient()
    client.force_login(actors["member"])
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    response = client.post(reverse("map-draft-ensure"), {}, format="json")
    assert response.status_code == 200
    body = response.json()
    assert body["target_id"]
    assert body["revision_id"]


@pytest.mark.django_db
def test_ensure_resumes_same_draft_without_target_id(actors):
    from maps.models import Revision

    first = ensure_demo_draft(actors["member"])
    revision = Revision.objects.get(pk=first["revision_id"])
    add_node(revision, x=11, y=22, label="Keep", actor=actors["member"])
    second = ensure_demo_draft(actors["member"])
    assert str(second["target_id"]) == str(first["target_id"])
    assert str(second["revision_id"]) == str(first["revision_id"])
    client = APIClient()
    client.force_login(actors["member"])
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    graph = client.get(reverse("map-revision-graph", kwargs={"revision_id": second["revision_id"]}))
    assert graph.status_code == 200
    assert len(graph.json()["nodes"]) == 1
    assert graph.json()["nodes"][0]["label"] == "Keep"


@pytest.mark.django_db
def test_ensure_force_new_creates_separate_target(actors):
    first = ensure_demo_draft(actors["member"])
    second = ensure_demo_draft(actors["member"], force_new=True)
    assert str(second["target_id"]) != str(first["target_id"])


@pytest.mark.django_db
def test_stranger_cannot_read_graph(actors, draft):
    client = APIClient()
    client.force_login(actors["stranger"])
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    url = reverse("map-revision-graph", kwargs={"revision_id": draft["revision_id"]})
    assert client.get(url).status_code == 403


@pytest.mark.django_db
def test_add_remove_node_and_edge(actors, draft):
    from maps.models import Revision

    revision = Revision.objects.get(pk=draft["revision_id"])
    a = add_node(revision, x=10, y=20, label="A", actor=actors["member"])
    b = add_node(revision, x=40, y=60, label="B", actor=actors["member"])
    edge = add_edge(revision, from_id=a.id, to_id=b.id, actor=actors["member"])
    assert float(edge.cost) > 0
    with pytest.raises(GraphError):
        add_edge(revision, from_id=a.id, to_id=b.id, actor=actors["member"])
    remove_node(revision, node_id=a.id, actor=actors["member"])
    assert not Node.objects.filter(pk=a.id).exists()
    assert not revision.edges.filter(pk=edge.id).exists()


@pytest.mark.django_db
def test_frozen_revision_rejects_writes(actors, draft):
    from maps.models import Revision

    revision = Revision.objects.get(pk=draft["revision_id"])
    freeze_revision(revision)
    with pytest.raises(GraphError, match="Frozen"):
        add_node(revision, x=1, y=2, actor=actors["member"])


@pytest.mark.django_db
def test_api_node_edge_roundtrip(actors, draft):
    client = APIClient()
    client.force_login(actors["member"])
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    rev = draft["revision_id"]
    n1 = client.post(
        reverse("map-revision-nodes", kwargs={"revision_id": rev}),
        {"x": 100, "y": 120, "label": "Lab"},
        format="json",
    )
    assert n1.status_code == 201
    n2 = client.post(
        reverse("map-revision-nodes", kwargs={"revision_id": rev}),
        {"x": 200, "y": 220, "label": "Hall"},
        format="json",
    )
    assert n2.status_code == 201
    edge = client.post(
        reverse("map-revision-edges", kwargs={"revision_id": rev}),
        {"from_node_id": n1.json()["id"], "to_node_id": n2.json()["id"]},
        format="json",
    )
    assert edge.status_code == 201
    dup = client.post(
        reverse("map-revision-edges", kwargs={"revision_id": rev}),
        {"from_node_id": n1.json()["id"], "to_node_id": n2.json()["id"]},
        format="json",
    )
    assert dup.status_code == 400
    graph = client.get(reverse("map-revision-graph", kwargs={"revision_id": rev}))
    assert graph.status_code == 200
    assert len(graph.json()["nodes"]) == 2
    assert len(graph.json()["edges"]) == 1
    deleted = client.delete(
        reverse(
            "map-revision-edge-detail",
            kwargs={"revision_id": rev, "edge_id": edge.json()["id"]},
        )
    )
    assert deleted.status_code == 204


@pytest.mark.django_db
def test_underlay_upload(actors, draft):
    client = APIClient()
    client.force_login(actors["member"])
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    png = SimpleUploadedFile(
        "plan.png",
        _tiny_png(),
        content_type="image/png",
    )
    response = client.post(
        reverse("map-revision-underlay", kwargs={"revision_id": draft["revision_id"]}),
        {"file": png},
        format="multipart",
    )
    assert response.status_code == 201
    assert response.json()["underlay_url"].startswith("/media/")


def _tiny_png() -> bytes:
    # 1x1 PNG
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f"
        b"\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
    )
