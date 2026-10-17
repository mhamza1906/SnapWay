"""Seed a draft contribution + membership for local graph editor smoke tests."""

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from maps.services.draft import ensure_demo_draft

User = get_user_model()


class Command(BaseCommand):
    help = "Ensure a graph draft for --email (creates target + admin membership if needed)."

    def add_arguments(self, parser):
        parser.add_argument("--email", required=True, help="User email to own the draft")
        parser.add_argument(
            "--target-id",
            default=None,
            help="Optional existing MapTarget UUID",
        )

    def handle(self, *args, **options):
        email = options["email"].strip().lower()
        try:
            user = User.objects.get(email__iexact=email)
        except User.DoesNotExist as exc:
            raise CommandError(f"No user with email {email}") from exc
        try:
            payload = ensure_demo_draft(user, target_id=options["target_id"])
        except Exception as exc:  # noqa: BLE001
            raise CommandError(str(exc)) from exc
        self.stdout.write(
            self.style.SUCCESS(
                "target={target_id} contribution={contribution_id} revision={revision_id}".format(
                    **{k: payload[k] for k in ("target_id", "contribution_id", "revision_id")}
                )
            )
        )
