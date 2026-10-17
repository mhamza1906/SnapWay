"""Bootstrap or adjust map Membership rows (controlled setup; not Google auto-grant)."""

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from maps.models import MapTarget, Membership
from maps.services.membership import grant_membership, revoke_membership

User = get_user_model()


class Command(BaseCommand):
    help = (
        "Grant or revoke a map Membership. Staff may bootstrap the first admin "
        "on a target; afterward prefer an existing map admin as --granted-by."
    )

    def add_arguments(self, parser):
        parser.add_argument("--email", required=True, help="Target user email")
        parser.add_argument("--target-id", required=True, help="MapTarget UUID")
        parser.add_argument(
            "--role",
            choices=[Membership.Role.ADMIN, Membership.Role.VOLUNTEER],
            default=Membership.Role.ADMIN,
        )
        parser.add_argument(
            "--granted-by-email",
            default="",
            help="Actor email (defaults to the same user when staff bootstraps)",
        )
        parser.add_argument(
            "--revoke",
            action="store_true",
            help="Revoke the membership instead of granting",
        )

    def handle(self, *args, **options):
        user = User.objects.filter(email__iexact=options["email"]).first()
        if user is None:
            raise CommandError(f"No user with email {options['email']!r}")
        try:
            target = MapTarget.objects.get(pk=options["target_id"])
        except MapTarget.DoesNotExist as exc:
            raise CommandError(f"MapTarget {options['target_id']} not found") from exc

        actor_email = options["granted_by_email"] or options["email"]
        actor = User.objects.filter(email__iexact=actor_email).first()
        if actor is None:
            raise CommandError(f"No actor user with email {actor_email!r}")

        try:
            if options["revoke"]:
                membership = revoke_membership(target=target, user=user, actor=actor)
                self.stdout.write(
                    self.style.SUCCESS(f"Revoked {membership.role} for {user.email} on {target.id}")
                )
            else:
                membership = grant_membership(
                    target=target,
                    user=user,
                    role=options["role"],
                    granted_by=actor,
                )
                self.stdout.write(
                    self.style.SUCCESS(f"Granted {membership.role} to {user.email} on {target.id}")
                )
        except Exception as exc:
            raise CommandError(str(exc)) from exc
