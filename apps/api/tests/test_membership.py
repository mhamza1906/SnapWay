import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied
from django.core.management import call_command
from django.urls import reverse
from django.utils import timezone
from maps.models import Building, Floor, MapTarget, Membership
from maps.services.membership import (
    get_active_membership,
    grant_membership,
    revoke_membership,
    user_has_role,
)
from rest_framework.test import APIClient

User = get_user_model()


@pytest.fixture
def world(db):
    staff = User.objects.create_user(
        username="staff", email="staff@example.com", password="x", is_staff=True
    )
    admin_user = User.objects.create_user(
        username="mapadmin", email="admin@example.com", password="x"
    )
    volunteer = User.objects.create_user(
        username="volunteer", email="vol@example.com", password="x"
    )
    stranger = User.objects.create_user(
        username="stranger", email="other@example.com", password="x"
    )
    building = Building.objects.create(name="Lab", slug="lab", created_by=staff)
    floor = Floor.objects.create(building=building, code="1", name="Floor 1")
    target = MapTarget.objects.create(floor=floor, title="Lab L1", created_by=staff)
    other_floor = Floor.objects.create(building=building, code="2", name="Floor 2")
    other_target = MapTarget.objects.create(floor=other_floor, title="Lab L2", created_by=staff)
    return {
        "staff": staff,
        "admin_user": admin_user,
        "volunteer": volunteer,
        "stranger": stranger,
        "target": target,
        "other_target": other_target,
    }


@pytest.mark.django_db
def test_active_vs_revoked_membership(world):
    grant_membership(
        target=world["target"],
        user=world["admin_user"],
        role=Membership.Role.ADMIN,
        granted_by=world["staff"],
    )
    assert user_has_role(world["admin_user"], world["target"], {Membership.Role.ADMIN})
    revoke_membership(target=world["target"], user=world["admin_user"], actor=world["staff"])
    assert get_active_membership(world["admin_user"], world["target"]) is None


@pytest.mark.django_db
def test_volunteer_denied_admin_helper(world):
    grant_membership(
        target=world["target"],
        user=world["admin_user"],
        role=Membership.Role.ADMIN,
        granted_by=world["staff"],
    )
    grant_membership(
        target=world["target"],
        user=world["volunteer"],
        role=Membership.Role.VOLUNTEER,
        granted_by=world["admin_user"],
    )
    assert user_has_role(world["volunteer"], world["target"], {Membership.Role.VOLUNTEER})
    assert not user_has_role(world["volunteer"], world["target"], {Membership.Role.ADMIN})


@pytest.mark.django_db
def test_cross_target_isolation(world):
    grant_membership(
        target=world["target"],
        user=world["admin_user"],
        role=Membership.Role.ADMIN,
        granted_by=world["staff"],
    )
    assert get_active_membership(world["admin_user"], world["other_target"]) is None


@pytest.mark.django_db
def test_non_staff_cannot_bootstrap_first_admin(world):
    with pytest.raises(PermissionDenied):
        grant_membership(
            target=world["target"],
            user=world["admin_user"],
            role=Membership.Role.ADMIN,
            granted_by=world["stranger"],
        )


@pytest.mark.django_db
def test_access_endpoint_admin_vs_volunteer_vs_stranger(world):
    grant_membership(
        target=world["target"],
        user=world["admin_user"],
        role=Membership.Role.ADMIN,
        granted_by=world["staff"],
    )
    grant_membership(
        target=world["target"],
        user=world["volunteer"],
        role=Membership.Role.VOLUNTEER,
        granted_by=world["admin_user"],
    )
    url = reverse("map-target-access", kwargs={"target_id": world["target"].id})
    client = APIClient()

    client.force_login(world["admin_user"])
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    response = client.get(url)
    assert response.status_code == 200
    assert response.json()["role"] == "admin"

    client.force_login(world["volunteer"])
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    response = client.get(url)
    assert response.status_code == 200
    assert response.json()["role"] == "volunteer"

    client.force_login(world["stranger"])
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    assert client.get(url).status_code == 403

    assert (
        client.get(
            reverse("map-target-access", kwargs={"target_id": world["other_target"].id})
        ).status_code
        == 403
    )


@pytest.mark.django_db
def test_access_endpoint_requires_authentication(world):
    url = reverse("map-target-access", kwargs={"target_id": world["target"].id})
    assert APIClient().get(url).status_code in (401, 403)


@pytest.mark.django_db
def test_me_lists_active_memberships(world):
    grant_membership(
        target=world["target"],
        user=world["admin_user"],
        role=Membership.Role.ADMIN,
        granted_by=world["staff"],
    )
    Membership.objects.create(
        target=world["other_target"],
        user=world["admin_user"],
        role=Membership.Role.VOLUNTEER,
        granted_by=world["staff"],
        revoked_at=timezone.now(),
    )
    client = APIClient()
    client.force_login(world["admin_user"])
    session = client.session
    session["snapway_mode"] = "developer"
    session.save()
    payload = client.get(reverse("auth-me")).json()
    assert payload["authenticated"] is True
    assert payload["memberships"] == [{"target_id": str(world["target"].id), "role": "admin"}]


@pytest.mark.django_db
def test_grant_map_membership_command(world):
    call_command(
        "grant_map_membership",
        email="admin@example.com",
        target_id=str(world["target"].id),
        role="admin",
        granted_by_email="staff@example.com",
    )
    assert user_has_role(world["admin_user"], world["target"], {Membership.Role.ADMIN})
    call_command(
        "grant_map_membership",
        email="admin@example.com",
        target_id=str(world["target"].id),
        granted_by_email="staff@example.com",
        revoke=True,
    )
    assert get_active_membership(world["admin_user"], world["target"]) is None
