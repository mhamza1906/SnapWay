"""Client for the place-match mobile engine (``apps/place-match``, ``serve-mobile``).

The engine runs MegaLoc locally and calls Vertex AI with server-side credentials. This API
only validates, authorises and forwards frames; it never stores them or logs their bytes.
Standard library HTTP keeps the API's dependency set unchanged.
"""

from __future__ import annotations

import json
import secrets
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from django.conf import settings

MAX_UPLOAD_BYTES = 3 * 1024 * 1024
#: Engine statuses passed through to the client unchanged (validation and capacity).
PASS_THROUGH = {400, 404, 413, 415, 422, 429, 503}


class EngineError(Exception):
    def __init__(self, status: int, code: str, detail: str):
        super().__init__(detail)
        self.status, self.code, self.detail = status, code, detail


@dataclass(frozen=True)
class EngineResponse:
    status: int
    content_type: str
    body: bytes

    def json(self) -> dict:
        return json.loads(self.body.decode("utf-8"))


def configured() -> bool:
    return bool(settings.PLACEMATCH_ENGINE_URL and settings.PLACEMATCH_ENGINE_TOKEN)


def _url(path: str, query: dict | None = None) -> str:
    if not configured():
        raise EngineError(503, "not_configured", "Localization service is not configured.")
    base = settings.PLACEMATCH_ENGINE_URL.rstrip("/")
    q = f"?{urllib.parse.urlencode(query)}" if query else ""
    return f"{base}{path}{q}"


def _send(request: urllib.request.Request) -> EngineResponse:
    if not configured():
        raise EngineError(503, "not_configured", "Localization service is not configured.")
    request.add_header("Authorization", f"Bearer {settings.PLACEMATCH_ENGINE_TOKEN}")
    try:
        with urllib.request.urlopen(  # noqa: S310 - configured private engine URL only
            request, timeout=settings.PLACEMATCH_ENGINE_TIMEOUT_S
        ) as resp:
            return EngineResponse(resp.status, resp.headers.get("Content-Type", ""), resp.read())
    except urllib.error.HTTPError as exc:
        body = exc.read()
        detail = "Localization service error."
        try:
            payload = json.loads(body.decode("utf-8"))
            detail = str(payload.get("detail") or payload.get("error") or detail)[:300]
        except (ValueError, UnicodeDecodeError, AttributeError):
            pass
        if exc.code in PASS_THROUGH:
            raise EngineError(exc.code, "engine_rejected", detail) from None
        # 401/403 mean this API's engine token is wrong: a server problem, not the client's.
        raise EngineError(
            502, "engine_error", "Localization service rejected the request."
        ) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise EngineError(503, "unavailable", "Localization service is unavailable.") from None


def health() -> dict:
    return _send(urllib.request.Request(_url("/v1/health"))).json()


def match(image: bytes, meta: dict, *, backend: str, verify: bool, second_opinion: bool) -> dict:
    boundary = f"snapway-{secrets.token_hex(12)}"
    parts = [
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="meta"\r\n'
        "Content-Type: application/json\r\n\r\n".encode()
        + json.dumps(meta).encode()
        + b"\r\n",
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="image"; filename="frame.jpg"\r\n'
        "Content-Type: image/jpeg\r\n\r\n".encode()
        + image
        + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    query = {
        "backend": backend,
        "verify": str(verify).lower(),
        "second_opinion": str(second_opinion).lower(),
    }
    request = urllib.request.Request(
        _url("/v1/match", query),
        data=b"".join(parts),
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    return _send(request).json()


def thumbnail(reference_set: str, reference_id: str) -> EngineResponse:
    path = (
        f"/v1/references/{urllib.parse.quote(reference_set, safe='')}"
        f"/thumb/{urllib.parse.quote(reference_id, safe='/:')}"
    )
    return _send(urllib.request.Request(_url(path)))


def megaloc_index(reference_set: str) -> dict:
    path = f"/v1/references/{urllib.parse.quote(reference_set, safe='')}/megaloc-index"
    return _send(urllib.request.Request(_url(path))).json()


def catalog_get() -> dict:
    return _send(urllib.request.Request(_url("/v1/catalog"))).json()


def catalog_sync(desired: list[dict], zips: dict[str, bytes]) -> dict:
    """Push desired catalog sets; ``zips`` only for new/changed ``set_key`` values."""
    import base64

    payload = {
        "sets": desired,
        "zips": {key: base64.b64encode(raw).decode("ascii") for key, raw in zips.items()},
    }
    request = urllib.request.Request(
        _url("/v1/catalog/sync"),
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    return _send(request).json()


def match_global(image: bytes, meta: dict) -> dict:
    boundary = f"snapway-{secrets.token_hex(12)}"
    parts = [
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="meta"\r\n'
            "Content-Type: application/json\r\n\r\n"
        ).encode()
        + json.dumps(meta).encode()
        + b"\r\n",
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="image"; filename="frame.jpg"\r\n'
            "Content-Type: image/jpeg\r\n\r\n"
        ).encode()
        + image
        + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    request = urllib.request.Request(
        _url("/v1/match-global"),
        data=b"".join(parts),
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    return _send(request).json()


def ensure_catalog_synced(entries: list) -> dict:
    """Compare engine catalog hashes and upload missing/stale index zips."""
    from maps.services.media_store import read_bytes

    remote = catalog_get()
    remote_by_key = {s["set_key"]: s.get("content_hash") for s in remote.get("sets", [])}
    desired = [
        {
            "set_key": e.set_key,
            "content_hash": e.content_hash,
            "revision_id": e.revision_id,
            "target_id": e.target_id,
        }
        for e in entries
    ]
    zips: dict[str, bytes] = {}
    for e in entries:
        if remote_by_key.get(e.set_key) != e.content_hash:
            zips[e.set_key] = read_bytes(e.storage_key)
    return catalog_sync(desired, zips)
