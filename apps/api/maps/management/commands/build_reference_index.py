"""Build MegaLoc embeddings for a revision's node reference photos."""

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from maps.models import Revision
from maps.services.graph import GraphError
from maps.services.reference_index import build_reference_index

User = get_user_model()


class Command(BaseCommand):
    help = "Embed reference photos for a revision and store RevisionArtifact(kind=index)."

    def add_arguments(self, parser):
        parser.add_argument("revision_id", help="Revision UUID")
        parser.add_argument(
            "--email",
            required=True,
            help="User email used for writable-membership checks and asset provenance",
        )

    def handle(self, *args, **options):
        email = options["email"].strip().lower()
        try:
            user = User.objects.get(email__iexact=email)
        except User.DoesNotExist as exc:
            raise CommandError(f"No user with email {email}") from exc
        try:
            revision = Revision.objects.select_related("target").get(pk=options["revision_id"])
        except Revision.DoesNotExist as exc:
            raise CommandError("Revision not found.") from exc
        try:
            payload = build_reference_index(revision, actor=user)
        except (GraphError, PermissionError) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(self.style.SUCCESS(str(payload)))
