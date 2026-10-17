"""Durable application jobs; broker messages carry these IDs, not authoritative state."""

from django.conf import settings
from django.db import models
from django.db.models import F, Q
from maps.models import Record, enum_check, scope_key


class Job(Record):
    class State(models.TextChoices):
        PENDING = "pending", "Awaiting dispatch"
        QUEUED = "queued", "Queued"
        RUNNING = "running", "Running"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Cancelled"
        EXPIRED = "expired", "Expired"

    target = models.ForeignKey("maps.MapTarget", on_delete=models.PROTECT)
    revision = models.ForeignKey("maps.Revision", null=True, blank=True, on_delete=models.PROTECT)
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT
    )
    session = models.ForeignKey(
        "navigation.NavigationSession", null=True, blank=True, on_delete=models.PROTECT
    )
    operation = models.CharField(max_length=80)
    queue = models.CharField(
        max_length=12, choices=[("authoring", "Authoring"), ("localization", "Localization")]
    )
    # A server-generated namespace: e.g. user:<pk>:target:<uuid> or session:<uuid>.
    idempotency_scope = models.CharField(max_length=200)
    idempotency_key = models.CharField(max_length=100)
    state = models.CharField(max_length=12, choices=State, default=State.PENDING)
    input_content_hash = models.CharField(max_length=64, blank=True)
    input_payload = models.JSONField(default=dict)
    result_payload = models.JSONField(default=dict, blank=True)
    error_code = models.CharField(max_length=80, blank=True)
    deadline_at = models.DateTimeField()
    next_attempt_at = models.DateTimeField()
    dispatched_at = models.DateTimeField(null=True, blank=True)
    lease_token = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    max_attempts = models.PositiveSmallIntegerField(default=3)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            scope_key("revision", "job_revision_key"),
            scope_key("session", "job_session_key"),
            models.UniqueConstraint(
                fields=["idempotency_scope", "idempotency_key"], name="job_idempotency_uq"
            ),
            enum_check("queue", ["authoring", "localization"], "job_queue_ck"),
            enum_check(
                "state",
                ["pending", "queued", "running", "succeeded", "failed", "cancelled", "expired"],
                "job_state_ck",
            ),
            models.CheckConstraint(
                condition=Q(requested_by__isnull=False) | Q(session__isnull=False),
                name="job_principal_ck",
            ),
            models.CheckConstraint(
                condition=Q(queue="authoring", requested_by__isnull=False, session__isnull=True)
                | Q(queue="localization", session__isnull=False, revision__isnull=False),
                name="job_queue_principal_ck",
            ),
            models.CheckConstraint(condition=Q(max_attempts__gt=0), name="job_attempt_limit_ck"),
            models.CheckConstraint(
                condition=Q(lease_token__isnull=True, lease_expires_at__isnull=True)
                | Q(lease_token__isnull=False, lease_expires_at__isnull=False),
                name="job_lease_pair_ck",
            ),
            models.CheckConstraint(
                condition=~Q(state="running")
                | Q(lease_token__isnull=False, lease_expires_at__isnull=False),
                name="job_running_lease_ck",
            ),
            models.CheckConstraint(
                condition=Q(state__in=["pending", "queued", "running"], finished_at__isnull=True)
                | Q(
                    state__in=["succeeded", "failed", "cancelled", "expired"],
                    finished_at__isnull=False,
                ),
                name="job_terminal_time_ck",
            ),
        ]
        indexes = [
            models.Index(fields=["state", "next_attempt_at"], name="job_dispatch_idx"),
            models.Index(fields=["state", "lease_expires_at"], name="job_lease_idx"),
            models.Index(fields=["queue", "state", "created_at"], name="job_queue_idx"),
        ]


class JobAttempt(Record):
    job = models.ForeignKey(Job, on_delete=models.PROTECT, related_name="attempts")
    number = models.PositiveSmallIntegerField()
    lease_token = models.UUIDField(unique=True)
    started_at = models.DateTimeField()
    finished_at = models.DateTimeField(null=True, blank=True)
    provider = models.CharField(max_length=80, blank=True)
    model = models.CharField(max_length=100, blank=True)
    prompt_version = models.CharField(max_length=100, blank=True)
    provider_request_id = models.CharField(max_length=200, blank=True)
    outcome = models.CharField(max_length=80, blank=True)
    usage = models.JSONField(default=dict, blank=True)
    error_code = models.CharField(max_length=80, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["job", "number"], name="attempt_number_uq"),
            models.CheckConstraint(condition=Q(number__gt=0), name="attempt_number_ck"),
            models.CheckConstraint(
                condition=Q(finished_at__isnull=True) | Q(finished_at__gte=F("started_at")),
                name="attempt_time_ck",
            ),
        ]
