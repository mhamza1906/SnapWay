"""Idempotent local demo data for photo capture (docs/photo-capture.md).

Creates a contributor with a volunteer Membership on one MapTarget per given
pipeline floor, linked by CaptureMapLink, plus an outsider account without any
membership for authorization checks. Passwords are random and written only to
the git-ignored local/capture-demo-credentials.json; they are never printed.
"""

import json
import os
import secrets

from config.environment import ROOT
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from django.utils.text import slugify
from maps.models import Building, Floor, MapTarget, Membership

from capture.models import CaptureMapLink

CREDENTIALS = ROOT / "local" / "capture-demo-credentials.json"
CONTRIBUTOR = "capture-demo"
OUTSIDER = "capture-outsider"


class Command(BaseCommand):
    help = "Create demo capture users and map targets for pipeline building/floor IDs."

    def add_arguments(self, parser):
        parser.add_argument("map_building_id", help="Pipeline building ID")
        parser.add_argument("map_floor_ids", nargs="+", help="Pipeline floor ID(s)")
        parser.add_argument("--building-name", help="Display name (default: building ID)")
        parser.add_argument(
            "--role", choices=["volunteer", "admin"], default="volunteer", help="Demo role"
        )
        parser.add_argument(
            "--unjoined-floor",
            action="append",
            default=[],
            metavar="FLOOR_ID",
            help="Also create and link this floor's target WITHOUT a demo membership "
            "(floor-isolation checks; revokes an earlier demo membership). Repeatable.",
        )

    def handle(
        self, *args, map_building_id, map_floor_ids, building_name, role, unjoined_floor, **options
    ):
        overlap = set(map_floor_ids) & set(unjoined_floor)
        if overlap:
            raise CommandError(f"Floors cannot be both joined and unjoined: {sorted(overlap)}")
        credentials = self._load_credentials()
        with transaction.atomic():
            contributor = self._user(CONTRIBUTOR, credentials)
            self._user(OUTSIDER, credentials)
            building = self._building(map_building_id, building_name, contributor)
            floors = [(f, True) for f in map_floor_ids] + [(f, False) for f in unjoined_floor]
            for order, (floor_id, joined) in enumerate(floors):
                target = self._target(building, map_building_id, floor_id, order, contributor)
                membership = Membership.objects.filter(target=target, user=contributor).first()
                if joined:
                    if membership is None:
                        Membership.objects.create(
                            target=target, user=contributor, role=role, granted_by=contributor
                        )
                    elif membership.revoked_at is not None or membership.role != role:
                        membership.revoked_at = None
                        membership.role = role
                        membership.save(update_fields=["revoked_at", "role"])
                elif membership is not None and membership.revoked_at is None:
                    membership.revoked_at = timezone.now()
                    membership.save(update_fields=["revoked_at"])
                access = role if joined else "no demo membership"
                self.stdout.write(
                    f"  {map_building_id}/{floor_id} -> target {target.id} ({access})"
                )
        self._write_credentials(credentials)
        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded users {CONTRIBUTOR!r} and {OUTSIDER!r}; credentials are in "
                f"{CREDENTIALS.relative_to(ROOT)} (git-ignored)."
            )
        )

    def _load_credentials(self):
        if CREDENTIALS.exists():
            try:
                data = json.loads(CREDENTIALS.read_text(encoding="utf-8"))
            except json.JSONDecodeError as error:
                raise CommandError(f"{CREDENTIALS} is not valid JSON") from error
            return {user["username"]: user["password"] for user in data.get("users", [])}
        return {}

    def _write_credentials(self, credentials):
        CREDENTIALS.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "note": "Local demo accounts for /capture. Do not commit or share.",
            "loginUrl": "/accounts/login/?next=/capture",
            "users": [
                {
                    "username": CONTRIBUTOR,
                    "password": credentials[CONTRIBUTOR],
                    "memberships": True,
                },
                {"username": OUTSIDER, "password": credentials[OUTSIDER], "memberships": False},
            ],
        }
        descriptor = os.open(CREDENTIALS, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")

    def _user(self, username, credentials):
        password = credentials.get(username) or secrets.token_urlsafe(18)
        credentials[username] = password
        user, _ = get_user_model().objects.get_or_create(username=username)
        if not user.check_password(password) or not user.is_active:
            user.set_password(password)
            user.is_active = True
            user.save()
        return user

    def _building(self, map_building_id, name, creator):
        slug = slugify(f"capture-{map_building_id}")[:200]
        building, created = Building.objects.get_or_create(
            slug=slug, defaults={"name": name or map_building_id, "created_by": creator}
        )
        if name and not created and building.name != name:
            building.name = name
            building.save(update_fields=["name"])
        return building

    def _target(self, building, map_building_id, floor_id, order, creator):
        link = (
            CaptureMapLink.objects.filter(map_building_id=map_building_id, map_floor_id=floor_id)
            .select_related("target")
            .first()
        )
        if link is not None:
            if link.target.status != MapTarget.Status.OPEN:
                raise CommandError(f"Target for {map_building_id}/{floor_id} is archived")
            return link.target
        if len(floor_id) > 50:
            raise CommandError(f"Floor ID {floor_id!r} is longer than 50 characters")
        floor, _ = Floor.objects.get_or_create(
            building=building, code=floor_id, defaults={"name": floor_id, "sort_order": order}
        )
        target, _ = MapTarget.objects.get_or_create(
            floor=floor,
            defaults={"title": f"{building.name} - {floor_id}", "created_by": creator},
        )
        CaptureMapLink.objects.create(
            target=target, map_building_id=map_building_id, map_floor_id=floor_id
        )
        return target
