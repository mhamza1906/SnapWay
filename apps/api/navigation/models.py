"""Persistence foundations for later N0 navigation; no localization/routing API yet."""

from django.db import models
from django.db.models import Q
from maps.models import Record, enum_check, scope_key


class NavigationSession(Record):
    publication = models.ForeignKey("maps.Publication", on_delete=models.PROTECT)
    # Redundant revision key enables revision-scoped database foreign keys.
    revision = models.ForeignKey("maps.Revision", on_delete=models.PROTECT)
    # Store a digest of a random scoped secret; UUID identifiers are not authorization.
    token_hash = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    invalidated_at = models.DateTimeField(null=True, blank=True)
    destination = models.ForeignKey(
        "maps.Node",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="destination_sessions",
    )
    context_version = models.PositiveIntegerField(default=0)
    latest_capture_sequence = models.PositiveIntegerField(default=0)
    confirmed_result = models.ForeignKey(
        "LocalizationResult",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="confirmed_sessions",
    )

    class Meta:
        constraints = [scope_key("revision", "session_revision_key")]
        indexes = [models.Index(fields=["expires_at"], name="session_expiry_idx")]


class Capture(Record):
    session = models.ForeignKey(
        NavigationSession, on_delete=models.PROTECT, related_name="captures"
    )
    revision = models.ForeignKey("maps.Revision", on_delete=models.PROTECT)
    asset = models.OneToOneField("maps.Asset", on_delete=models.PROTECT)
    job = models.OneToOneField("jobs.Job", on_delete=models.PROTECT)
    sequence = models.PositiveIntegerField()
    context_version = models.PositiveIntegerField()
    captured_at = models.DateTimeField()
    idempotency_key = models.CharField(max_length=100)
    capture_context = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            scope_key("revision", "capture_revision_key"),
            scope_key("session", "capture_session_key"),
            models.UniqueConstraint(fields=["session", "sequence"], name="capture_sequence_uq"),
            models.UniqueConstraint(
                fields=["session", "idempotency_key"], name="capture_idempotency_uq"
            ),
            models.CheckConstraint(condition=Q(sequence__gt=0), name="capture_sequence_ck"),
        ]


class LocalizationResult(Record):
    class Outcome(models.TextChoices):
        ACCEPTED = "accepted", "Accepted"
        AMBIGUOUS = "ambiguous", "Ambiguous"
        REJECTED = "rejected", "Rejected"
        ERROR = "error", "Service error"

    capture = models.OneToOneField(Capture, on_delete=models.PROTECT, related_name="result")
    session = models.ForeignKey(NavigationSession, on_delete=models.PROTECT)
    revision = models.ForeignKey("maps.Revision", on_delete=models.PROTECT)
    outcome = models.CharField(max_length=12, choices=Outcome)
    node = models.ForeignKey("maps.Node", on_delete=models.PROTECT, null=True, blank=True)
    heading_degrees = models.DecimalField(max_digits=6, decimal_places=3, null=True, blank=True)
    heading_confirmed = models.BooleanField(default=False)
    reason_code = models.CharField(max_length=80, blank=True)
    evidence = models.JSONField(default=dict)
    # Exact artifact/model/profile identities used, including an unknown/rejection result.
    retrieval_profile = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            scope_key("session", "result_session_key"),
            scope_key("revision", "result_revision_key"),
            enum_check(
                "outcome", ["accepted", "ambiguous", "rejected", "error"], "result_outcome_ck"
            ),
            models.CheckConstraint(
                condition=Q(outcome="accepted", node__isnull=False)
                | (~Q(outcome="accepted") & Q(node__isnull=True)),
                name="result_node_ck",
            ),
            models.CheckConstraint(
                condition=Q(heading_degrees__isnull=True)
                | Q(heading_degrees__gte=0, heading_degrees__lt=360),
                name="result_heading_ck",
            ),
            models.CheckConstraint(
                condition=Q(heading_confirmed=False) | Q(heading_degrees__isnull=False),
                name="result_heading_confirmation_ck",
            ),
        ]


class Route(Record):
    session = models.ForeignKey(NavigationSession, on_delete=models.PROTECT, related_name="routes")
    revision = models.ForeignKey("maps.Revision", on_delete=models.PROTECT)
    localization = models.ForeignKey(LocalizationResult, on_delete=models.PROTECT)
    destination = models.ForeignKey("maps.Node", on_delete=models.PROTECT)
    context_version = models.PositiveIntegerField()
    # Ordered edge IDs and landmark instructions are derived from the pinned graph.
    steps = models.JSONField(default=list)
    restrictions = models.JSONField(default=dict, blank=True)
    invalidated_at = models.DateTimeField(null=True, blank=True)
    arrived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["session", "created_at"], name="route_history_idx")]
