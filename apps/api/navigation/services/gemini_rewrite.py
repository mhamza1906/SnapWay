"""Optional Vertex Gemini rewrite of template route instructions (topology stays Dijkstra).

Uses the same Vertex AI generateContent transport as the map-authoring pipeline
(``VERTEX_API_KEY`` + ``VERTEX_PROJECT`` + ``VERTEX_MODEL``), not the Gemini Developer API.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

from django.conf import settings

log = logging.getLogger(__name__)

_MAX_CHARS = 2000
_TIMEOUT_S = 60


def _vertex_endpoint(project: str, location: str, model: str) -> str:
    host = (
        "aiplatform.googleapis.com"
        if location == "global"
        else f"{location}-aiplatform.googleapis.com"
    )
    return (
        f"https://{host}/v1/projects/{project}/locations/{location}"
        f"/publishers/google/models/{model}:generateContent"
    )


def _extract_text(payload: dict) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        return ""
    parts = ((candidates[0].get("content") or {}).get("parts")) or []
    chunks = [p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought")]
    return "".join(chunks).strip()


def rewrite_instructions(steps: list[dict], template_text: str) -> str | None:
    """Return rewritten prose via Vertex, or None to keep templates."""
    if not getattr(settings, "ROUTE_GEMINI_REWRITE", False):
        return None
    api_key = (getattr(settings, "VERTEX_API_KEY", None) or "").strip()
    project = (getattr(settings, "VERTEX_PROJECT", None) or "").strip()
    if not api_key or not project:
        log.warning("ROUTE_GEMINI_REWRITE on but VERTEX_API_KEY/VERTEX_PROJECT missing")
        return None
    location = (getattr(settings, "VERTEX_LOCATION", None) or "global").strip() or "global"
    model = (getattr(settings, "VERTEX_MODEL", None) or "gemini-4-argon").strip()
    compact = [
        {
            "turn": s.get("turn"),
            "to_label": s.get("to_label"),
            "to_kind": s.get("to_kind"),
            "distance_metres": s.get("distance_metres"),
            "instruction": s.get("instruction"),
        }
        for s in steps
    ]
    prompt = (
        "Rewrite these indoor walking directions for a visitor. "
        "Keep the same order and landmarks. Do not add places that are not listed. "
        "Use short plain sentences. No markdown.\n\n"
        f"Template:\n{template_text}\n\n"
        f"Steps JSON:\n{json.dumps(compact)}"
    )
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": 1024},
    }
    request = urllib.request.Request(
        _vertex_endpoint(project, location, model),
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as response:
            payload = json.loads(response.read().decode())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        log.exception("route vertex rewrite failed; keeping templates")
        return None
    text = _extract_text(payload)
    if not text or len(text) > _MAX_CHARS:
        return None
    return text
