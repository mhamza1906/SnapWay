"""Build and persist RoutePlan on the first successful session localize."""

from __future__ import annotations

from django.db import transaction
from django.utils import timezone
from maps.models import Node

from navigation.models import NavigationSession, RoutePlan
from navigation.services.directions import path_payload
from navigation.services.gemini_rewrite import rewrite_instructions
from navigation.services.routing import node_on_revision, shortest_path


def active_plan(session: NavigationSession) -> RoutePlan | None:
    return (
        RoutePlan.objects.filter(
            session=session,
            context_version=session.context_version,
            invalidated_at__isnull=True,
        )
        .select_related("start_node", "destination")
        .first()
    )


def plan_to_dict(plan: RoutePlan) -> dict:
    return {
        "ok": not bool(plan.error),
        "error": plan.error or "",
        "route_plan_id": str(plan.id),
        "context_version": plan.context_version,
        "start_node_id": str(plan.start_node_id),
        "start_stable_id": str(plan.start_node.stable_id),
        "destination_node_id": str(plan.destination_id),
        "destination_stable_id": str(plan.destination.stable_id),
        "steps": plan.steps,
        "edge_ids": plan.edge_ids,
        "instructions_text": plan.instructions_text,
        "instructions_source": plan.instructions_source,
    }


@transaction.atomic
def ensure_route_for_localize(
    session: NavigationSession,
    *,
    start_node_id,
) -> dict | None:
    """If session has a destination and no active plan, compute and store one.

    ``start_node_id`` is the MegaLoc / localize Node **primary key** string.
    Destination on the session is already a Node PK (resolved from stable_id at create).
    """
    if session.destination_id is None:
        return None

    existing = active_plan(session)
    if existing is not None:
        return plan_to_dict(existing)

    start = node_on_revision(session.revision, start_node_id)
    if start is None:
        return {
            "ok": False,
            "error": "start_node_not_on_revision",
            "start_node_id": str(start_node_id) if start_node_id else None,
            "start_stable_id": None,
            "destination_node_id": str(session.destination_id),
            "destination_stable_id": str(session.destination.stable_id),
            "steps": [],
            "edge_ids": [],
            "instructions_text": "",
            "instructions_source": "template",
        }

    destination = (
        Node.objects.select_related("room")
        .filter(pk=session.destination_id, revision_id=session.revision_id)
        .first()
    )
    if destination is None:
        return {
            "ok": False,
            "error": "destination_not_on_revision",
            "start_node_id": str(start.id),
            "start_stable_id": str(start.stable_id),
            "destination_node_id": str(session.destination_id),
            "destination_stable_id": None,
            "steps": [],
            "edge_ids": [],
            "instructions_text": "",
            "instructions_source": "template",
        }

    path = shortest_path(revision=session.revision, start=start, goal=destination)
    payload = path_payload(path, start=start, destination=destination)

    source = RoutePlan.InstructionsSource.TEMPLATE
    if payload["ok"] and payload["steps"]:
        rewritten = rewrite_instructions(payload["steps"], payload["instructions_text"])
        if rewritten:
            payload["instructions_text"] = rewritten
            payload["instructions_source"] = "gemini"
            source = RoutePlan.InstructionsSource.GEMINI

    plan = RoutePlan.objects.create(
        session=session,
        revision_id=session.revision_id,
        start_node=start,
        destination=destination,
        context_version=session.context_version,
        steps=payload["steps"],
        instructions_text=payload["instructions_text"],
        instructions_source=source,
        edge_ids=payload["edge_ids"],
        error=payload.get("error") or "",
    )
    out = plan_to_dict(plan)
    out["total_cost"] = payload.get("total_cost")
    return out


def invalidate_plans(session: NavigationSession) -> None:
    RoutePlan.objects.filter(session=session, invalidated_at__isnull=True).update(
        invalidated_at=timezone.now()
    )
