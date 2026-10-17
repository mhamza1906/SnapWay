"""Mobile matching API for the SnapWay iOS app (IOS_AGENT_PROMPT.md §4).

Separate from the local UI server (``placematch.server``, port 8777), which lists runs and
serves dataset images and must never be tunnelled. Run with
``uv run placematch serve-mobile`` (127.0.0.1:8790).

Every endpoint needs ``Authorization: Bearer <MOBILE_API_TOKEN>``. Uploaded frames are kept
in a temporary directory for the request only (unless ``MOBILE_STORE_FRAMES=1``); query
vectors go to a per-process temporary cache. Tokens, images and EXIF are never logged.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import tempfile
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Literal

import numpy as np
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from placematch.backends.base import EmbeddingIndex, EmbedStats, RequestBudget
from placematch.catalog_index import GlobalCatalog, cross_target_uncertain
from placematch.env import RUNS_DIR, load_env
from placematch.mobile_decide import (
    BackendOutcome,
    Mode,
    NoBackendAvailable,
    combine,
    decide_backend,
    search,
    thresholds_for,
)
from placematch.reference_sets import ReferenceSet
from placematch.schemas import FrameQuality, ThresholdSet

#: Cosine margin below which different-floor top-2 forces uncertain (when uncalibrated).
CROSS_TARGET_MARGIN_DEFAULT = 0.05

API_VERSION = "v1"
MAX_UPLOAD_BYTES = 3 * 1024 * 1024
MAX_SIDE = 4096
TOP_K = 5
THUMB_SIDE = 320


class FrameMeta(BaseModel):
    """Client metadata sent with each frame; echoed back, never trusted for decisions."""

    model_config = ConfigDict(extra="forbid")
    client_frame_id: int = Field(ge=0)
    timestamp_s: float | None = Field(default=None, ge=0)
    captured_at: str | None = Field(default=None, max_length=40)
    orientation: (
        Literal["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight", "unknown"]
        | None
    ) = None
    app_version: str | None = Field(default=None, max_length=32)
    source: Literal["camera", "video"] | None = None


@dataclass
class BackendSlot:
    """A loaded backend + its reference index, or the reason it is unavailable."""

    name: Literal["megaloc", "vertex"]
    backend: object | None = None
    index: EmbeddingIndex | None = None
    error: str | None = None

    @property
    def ready(self) -> bool:
        return self.backend is not None and self.index is not None and self.error is None


@dataclass
class MobileSettings:
    token: str
    reference_set: str = "default"
    rate_per_minute: int = 60
    store_frames: bool = False
    enable_vertex: bool = True

    @classmethod
    def from_env(cls) -> MobileSettings:
        load_env()
        # Legacy process alias remains supported; the shared file has one token.
        token = os.environ.get("MOBILE_API_TOKEN") or os.environ.get("PLACEMATCH_ENGINE_TOKEN", "")
        if len(token) < 24:
            raise RuntimeError(
                "PLACEMATCH_ENGINE_TOKEN is missing or shorter than 24 characters; create one with "
                "`uv run placematch mobile-token --create` (stored in repository local/.env)"
            )
        return cls(
            token=token,
            reference_set=os.environ.get("MOBILE_REFERENCE_SET", "default"),
            rate_per_minute=int(os.environ.get("MOBILE_RATE_LIMIT_PER_MIN", "60")),
            store_frames=os.environ.get("MOBILE_STORE_FRAMES", "0") == "1",
            enable_vertex=os.environ.get("MOBILE_ENABLE_VERTEX", "1") == "1",
        )


class RateLimiter:
    """Sliding one-minute window per token digest."""

    def __init__(self, per_minute: int):
        self.per_minute = max(1, per_minute)
        self.events: dict[str, deque[float]] = {}
        self.lock = threading.Lock()

    def check(self, who: str) -> float | None:
        """Return seconds to wait when over the limit, else ``None`` (and record the hit)."""
        now = time.monotonic()
        with self.lock:
            q = self.events.setdefault(who, deque())
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= self.per_minute:
                return max(0.0, 60 - (now - q[0]))
            q.append(now)
            return None


def thresholds_id(path: Path | None, thresholds: ThresholdSet | None) -> str:
    if thresholds is None:
        return "uncalibrated"
    raw = path.read_bytes() if path and path.is_file() else thresholds.model_dump_json().encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()[:12]


@dataclass
class MobileEngine:
    """Loaded state: thresholds, one reference set and the backend slots."""

    reference_set: ReferenceSet | None
    thresholds: ThresholdSet | None
    thresholds_id: str
    slots: dict[str, BackendSlot]
    verify_fn: object | None = (
        None  # (query: Path, reference: Path, thresholds) -> VerificationResult
    )
    quality_fn: object | None = None  # (path: Path) -> FrameQuality
    lock: threading.Lock = field(default_factory=threading.Lock)
    global_catalog: GlobalCatalog = field(default_factory=GlobalCatalog)

    # ------------------------------------------------------------------ construction

    @classmethod
    def from_env(cls, settings: MobileSettings) -> MobileEngine:
        from placematch.app import DEFAULT_THRESHOLDS
        from placematch.backends import get_backend

        try:
            ref_set: ReferenceSet | None = ReferenceSet.load(settings.reference_set)
        except FileNotFoundError:
            ref_set = None
        thresholds = None
        if DEFAULT_THRESHOLDS.is_file():
            thresholds = ThresholdSet.model_validate_json(
                DEFAULT_THRESHOLDS.read_text(encoding="utf-8")
            )
        query_cache = Path(tempfile.mkdtemp(prefix="placematch-mobile-cache-"))
        slots: dict[str, BackendSlot] = {}
        names = ["megaloc"] + (["vertex"] if settings.enable_vertex else [])
        for name in names:
            slot = BackendSlot(name)
            try:
                backend = get_backend(name, cache_root=query_cache)
                index = ref_set.load_index(backend.key) if ref_set is not None else None
                if index is None:
                    if name == "megaloc":
                        from placematch.backends.megaloc import load_model

                        load_model()  # needed for catalog / match-global even without default set
                        slot.backend = backend
                        slot.index = None
                        slot.error = (
                            None
                            if ref_set is None
                            else (
                                f"no {name} index for reference set {ref_set.name!r}; run "
                                f"`placematch build-references --name {ref_set.name} "
                                f"--backend {name}` (catalog match-global still available)"
                            )
                        )
                    else:
                        slot.error = (
                            f"no {name} index for reference set "
                            f"{settings.reference_set!r}; catalog uses MegaLoc only"
                        )
                else:
                    if name == "megaloc":
                        from placematch.backends.megaloc import load_model

                        load_model()  # once at startup (~8 s), not on the first frame
                    slot.backend, slot.index = backend, index
            except Exception as exc:  # unavailable backends stay listed with the reason
                slot.error = f"{type(exc).__name__}: {exc}"[:300]
            slots[name] = slot
        return cls(ref_set, thresholds, thresholds_id(DEFAULT_THRESHOLDS, thresholds), slots)

    # ------------------------------------------------------------------ public operations

    def health(self) -> dict:
        backends = {}
        for name, slot in self.slots.items():
            key = getattr(slot.backend, "key", None) or (
                slot.index.backend_key if slot.index else None
            )
            bt, label = thresholds_for(self.thresholds, key) if key else (None, "uncalibrated")
            backends[name] = {
                "ready": slot.ready or (name == "megaloc" and slot.backend is not None),
                "backend_key": key,
                "references": len(slot.index.image_ids) if slot.index else 0,
                "calibrated": bt is not None,
                "error": slot.error,
            }
        catalog = self.global_catalog.snapshot()
        return {
            "api_version": API_VERSION,
            "reference_set": self.reference_set.name if self.reference_set else None,
            "locations": sorted(
                {
                    e.location_id
                    for e in (self.reference_set.manifest.entries if self.reference_set else [])
                    if e.location_id
                }
            ),
            "catalog": catalog,
            "thresholds_id": self.thresholds_id,
            "backends": backends,
            "default_order": ["megaloc", "vertex (fallback or second opinion)"],
        }

    def match(
        self, path: Path, *, mode: Mode, verify: bool, second_opinion: bool
    ) -> tuple[dict, dict]:
        """Return (response body, timings_ms)."""
        timings: dict[str, float] = {}
        t_total = time.perf_counter()
        quality = None
        if self.quality_fn is not None:
            t = time.perf_counter()
            quality = self.quality_fn(path)
            timings["quality"] = _ms(t)

        def run(name: Literal["megaloc", "vertex"], force_verify: bool) -> BackendOutcome:
            slot = self.slots.get(name)
            if slot is None or not slot.ready or self.reference_set is None:
                reason = slot.error if slot else f"{name} is disabled on this server"
                if self.reference_set is None and (reason is None or not reason):
                    reason = "default reference set not loaded; use /v1/match-global"
                return BackendOutcome(name, None, error=reason or f"{name} unavailable")
            try:
                with self.lock:
                    t = time.perf_counter()
                    vec = slot.backend.embed_paths(
                        [path],
                        budget=RequestBudget(limit=1 if slot.backend.remote else None),
                        stats=EmbedStats(),
                    )
                    timings[f"embed_{name}"] = _ms(t)
                    t = time.perf_counter()
                    locations = {i: self.reference_set.location_of(i) for i in slot.index.image_ids}
                    cands = search(slot.index, vec[0], locations, TOP_K)
                    timings[f"search_{name}"] = _ms(t)
                    ran = False
                    if (verify or force_verify) and cands and self.verify_fn is not None:
                        bt, _ = thresholds_for(self.thresholds, slot.backend.key)
                        t = time.perf_counter()
                        cands[0].verification = self.verify_fn(
                            path,
                            self.reference_set.image_path(cands[0].reference_id),
                            bt.verify if bt else None,
                        )
                        timings[f"verify_{name}"] = _ms(t)
                        ran = True
                decision = decide_backend(
                    name,
                    slot.backend.key,
                    cands,
                    self.thresholds,
                    verification_ran=ran,
                    quality=quality,
                )
                return BackendOutcome(name, slot.backend.key, cands, decision)
            except Exception as exc:
                return BackendOutcome(name, None, error=f"{type(exc).__name__}: {exc}"[:300])

        megaloc = vertex = None
        if mode in ("auto", "megaloc"):
            megaloc = run("megaloc", force_verify=False)
        if mode == "vertex":
            vertex = run("vertex", force_verify=verify)
        elif mode == "auto":
            need_fallback = megaloc is not None and not megaloc.ok
            need_second = (
                second_opinion
                and megaloc is not None
                and megaloc.ok
                and megaloc.decision.outcome == "uncertain"
            )
            if need_fallback or need_second:
                # Vertex can only accept with geometric verification, so it always runs here.
                vertex = run("vertex", force_verify=True)
        combined = combine(mode, megaloc, vertex)
        timings["total"] = _ms(t_total)
        primary = combined.primary
        body = {
            "api_version": API_VERSION,
            "reference_set": self.reference_set.name,
            "decision": {
                "outcome": combined.decision.outcome,
                "reference_id": combined.decision.reference_id,
                "location_id": combined.location_id,
                "reasons": combined.decision.reasons,
            },
            "candidates": [_cand(c) for c in primary.candidates],
            "candidates_backend": primary.key,
            "verification": _verification(primary),
            "secondary": None,
            "backend_used": combined.backend_used,
            "fallback_used": combined.fallback_used,
            "second_opinion_used": combined.second_opinion_used,
            "thresholds_id": self.thresholds_id,
            "quality": quality.model_dump() if isinstance(quality, FrameQuality) else None,
            "score_kind": "raw cosine similarity (not a percentage or probability)",
        }
        if combined.secondary is not None:
            s = combined.secondary
            body["secondary"] = {
                "backend": s.name,
                "backend_key": s.key,
                "error": s.error,
                "decision": s.decision.model_dump() if s.decision else None,
                "candidates": [_cand(c) for c in s.candidates],
                "verification": _verification(s),
            }
        return body, timings

    def match_global(self, path: Path) -> tuple[dict, dict]:
        """MegaLoc cosine search over the synced multi-floor catalog (no Vertex)."""
        timings: dict[str, float] = {}
        t_total = time.perf_counter()
        slot = self.slots.get("megaloc")
        if slot is None or slot.backend is None:
            raise NoBackendAvailable(slot.error if slot else "megaloc unavailable")
        catalog = self.global_catalog
        with catalog.lock:
            index = catalog.index
            rows_by_id = catalog.rows_by_union_id()
            n_sets = len(catalog.loaded)
        if index is None or not rows_by_id:
            raise NoBackendAvailable("global catalog is empty; sync revision indexes first")

        quality = None
        if self.quality_fn is not None:
            t = time.perf_counter()
            quality = self.quality_fn(path)
            timings["quality"] = _ms(t)

        with self.lock:
            t = time.perf_counter()
            vec = slot.backend.embed_paths(
                [path],
                budget=RequestBudget(limit=None),
                stats=EmbedStats(),
            )
            timings["embed_megaloc"] = _ms(t)
            t = time.perf_counter()
            locations = {uid: rows_by_id[uid].node_id for uid in index.image_ids}
            cands = search(index, vec[0], locations, TOP_K)
            timings["search_megaloc"] = _ms(t)

        key = getattr(slot.backend, "key", None) or index.backend_key
        decision = decide_backend(
            "megaloc",
            key,
            cands,
            self.thresholds,
            verification_ran=False,
            quality=quality,
        )
        bt, _ = thresholds_for(self.thresholds, key)
        min_margin = (
            max(float(bt.min_margin), CROSS_TARGET_MARGIN_DEFAULT)
            if bt is not None
            else CROSS_TARGET_MARGIN_DEFAULT
        )
        if decision.outcome == "likely_match" and cross_target_uncertain(
            cands, rows_by_id, min_margin=min_margin
        ):
            decision.outcome = "uncertain"
            decision.reference_id = None
            decision.reasons.append(
                f"top-2 are different map targets with cosine margin < {min_margin:.4f}"
            )

        top_row = rows_by_id.get(cands[0].reference_id) if cands else None
        accepted_row = None
        if decision.reference_id:
            accepted_row = rows_by_id.get(decision.reference_id)

        def _enrich(c) -> dict:
            row = rows_by_id.get(c.reference_id)
            base = _cand(c)
            if row is None:
                return base
            return {
                **base,
                "reference_id": row.reference_id,
                "union_id": c.reference_id,
                "node_id": row.node_id,
                "revision_id": row.revision_id,
                "target_id": row.target_id,
            }

        body = {
            "api_version": API_VERSION,
            "mode": "global_catalog",
            "catalog_sets": n_sets,
            "decision": {
                "outcome": decision.outcome,
                "reference_id": (
                    accepted_row.reference_id if accepted_row else decision.reference_id
                ),
                "location_id": accepted_row.node_id if accepted_row else None,
                "node_id": accepted_row.node_id if accepted_row else None,
                "revision_id": accepted_row.revision_id if accepted_row else None,
                "target_id": accepted_row.target_id if accepted_row else None,
                "reasons": decision.reasons,
            },
            "top_candidate": _enrich(cands[0]) if cands else None,
            "candidates": [_enrich(c) for c in cands],
            "candidates_backend": key,
            "backend_used": "megaloc",
            "fallback_used": False,
            "second_opinion_used": False,
            "thresholds_id": self.thresholds_id,
            "quality": quality.model_dump() if isinstance(quality, FrameQuality) else None,
            "score_kind": "raw cosine similarity (not a percentage or probability)",
            "hint_top": (
                {
                    "node_id": top_row.node_id,
                    "revision_id": top_row.revision_id,
                    "target_id": top_row.target_id,
                }
                if top_row
                else None
            ),
        }
        timings["total"] = _ms(t_total)
        return body, timings

    def thumbnail(self, reference_id: str) -> bytes:
        if self.reference_set is None or reference_id not in self.reference_set.by_id:
            raise KeyError(reference_id)
        from placematch.frames import load_upright

        im = load_upright(self.reference_set.image_path(reference_id))
        im.thumbnail((THUMB_SIDE, THUMB_SIDE))
        out = io.BytesIO()
        im.save(out, "JPEG", quality=80)
        return out.getvalue()

    def megaloc_index(self) -> dict:
        slot = self.slots.get("megaloc")
        if slot is None or slot.index is None or self.reference_set is None:
            raise KeyError("megaloc index not loaded")
        index = slot.index
        bt, label = thresholds_for(self.thresholds, index.backend_key)
        vectors = np.asarray(index.vectors, dtype=np.float16)
        return {
            "api_version": API_VERSION,
            "reference_set": self.reference_set.name,
            "backend_key": index.backend_key,
            "dtype": "float16",
            "shape": list(vectors.shape),
            "vectors_b64": base64.b64encode(vectors.tobytes()).decode("ascii"),
            "reference_ids": index.image_ids,
            "location_ids": [self.reference_set.location_of(i) for i in index.image_ids],
            "thresholds": bt.model_dump() if bt else None,
            "thresholds_label": label,
            "thresholds_id": self.thresholds_id,
        }


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 1)


def _cand(c) -> dict:
    return {
        "rank": c.rank,
        "reference_id": c.reference_id,
        "location_id": c.location_id,
        "cosine": round(c.cosine, 6),
    }


def _verification(outcome: BackendOutcome) -> dict | None:
    v = outcome.verification
    if v is None:
        return None
    return v.model_dump(exclude={"overlay_path"})


def _check_jpeg(data: bytes) -> tuple[int, int]:
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"image larger than {MAX_UPLOAD_BYTES} bytes")
    if not data.startswith(b"\xff\xd8"):
        raise HTTPException(415, "image must be a JPEG")
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.format != "JPEG":
                raise HTTPException(415, "image must be a JPEG")
            width, height = im.size
            im.verify()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, "image could not be decoded") from exc
    if max(width, height) > MAX_SIDE:
        raise HTTPException(413, f"image larger than {MAX_SIDE} px on its longest side")
    return width, height


def authorise(request: Request) -> str:
    """Bearer-token check plus the per-token rate limit (state lives on ``app.state``)."""
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    expected = request.app.state.expected_token
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.encode(), expected):
        raise HTTPException(401, "missing or invalid token", {"WWW-Authenticate": "Bearer"})
    who = hashlib.sha256(token.encode()).hexdigest()[:16]
    wait = request.app.state.limiter.check(who)
    if wait is not None:
        raise HTTPException(429, "rate limit exceeded", {"Retry-After": str(int(wait) + 1)})
    return who


Authorised = Annotated[str, Depends(authorise)]


def create_app(engine: MobileEngine | None = None, settings: MobileSettings | None = None):
    """Build the FastAPI app. Tests inject ``engine`` and ``settings``."""
    settings = settings or MobileSettings.from_env()
    state: dict[str, MobileEngine | None] = {"engine": engine}
    limiter = RateLimiter(settings.rate_per_minute)
    expected = settings.token.encode()

    def get_engine() -> MobileEngine:
        if state["engine"] is None:
            from placematch.quality import assess
            from placematch.verify import verify_pair

            loaded = MobileEngine.from_env(settings)
            loaded.quality_fn = assess
            loaded.verify_fn = lambda q, r, th: verify_pair(q, r, thresholds=th)
            state["engine"] = loaded
        return state["engine"]

    @asynccontextmanager
    async def lifespan(_app):
        get_engine()  # load models and the index once, before the first request
        yield

    app = FastAPI(
        title="placematch mobile API",
        version=API_VERSION,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    app.state.expected_token = expected
    app.state.limiter = limiter

    @app.get("/v1/health")
    def health(_: Authorised) -> dict:
        return get_engine().health()

    @app.post("/v1/match")
    def match(
        image: Annotated[UploadFile, File()],
        meta: Annotated[str, Form()],
        _: Authorised,
        backend: Annotated[Mode, Query()] = "auto",
        verify: Annotated[bool, Query()] = False,
        second_opinion: Annotated[bool, Query()] = False,
    ) -> JSONResponse:
        t0 = time.perf_counter()
        if (image.content_type or "").lower() != "image/jpeg":
            raise HTTPException(415, "image must be sent as image/jpeg")
        try:
            frame = FrameMeta.model_validate(json.loads(meta))
        except (ValueError, ValidationError) as exc:
            raise HTTPException(422, "meta must be valid frame metadata JSON") from exc
        data = image.file.read(MAX_UPLOAD_BYTES + 1)
        width, height = _check_jpeg(data)
        decode_ms = _ms(t0)
        engine_ = get_engine()
        with tempfile.TemporaryDirectory(prefix="placematch-frame-") as tmp:
            path = Path(tmp) / "frame.jpg"
            path.write_bytes(data)
            stored = False
            if settings.store_frames:  # development flag only
                out = RUNS_DIR / "mobile-frames" / time.strftime("%Y%m%d")
                out.mkdir(parents=True, exist_ok=True)
                (out / f"{int(time.time())}-{frame.client_frame_id}.jpg").write_bytes(data)
                stored = True
            try:
                body, timings = engine_.match(
                    path, mode=backend, verify=verify, second_opinion=second_opinion
                )
            except NoBackendAvailable as exc:
                return JSONResponse(
                    {
                        "api_version": API_VERSION,
                        "error": "no_backend_available",
                        "detail": str(exc),
                    },
                    status_code=503,
                )
        timings = {"decode": decode_ms, **timings, "total": _ms(t0)}
        body.update(
            frame={**frame.model_dump(), "width": width, "height": height},
            timings_ms=timings,
            stored=stored,
        )
        return JSONResponse(body)

    @app.get("/v1/references/{set_name}/thumb/{reference_id:path}")
    def thumb(set_name: str, reference_id: str, _: Authorised) -> Response:
        engine_ = get_engine()
        if engine_.reference_set is None or set_name != engine_.reference_set.name:
            raise HTTPException(404, "unknown reference set")
        try:
            data = engine_.thumbnail(reference_id)
        except KeyError as exc:
            raise HTTPException(404, "unknown reference id") from exc
        return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private"})

    @app.get("/v1/references/{set_name}/megaloc-index")
    def megaloc_index(set_name: str, _: Authorised) -> dict:
        engine_ = get_engine()
        if engine_.reference_set is None or set_name != engine_.reference_set.name:
            raise HTTPException(404, "unknown reference set")
        try:
            return engine_.megaloc_index()
        except KeyError as exc:
            raise HTTPException(404, "MegaLoc index not available") from exc

    @app.get("/v1/catalog")
    def catalog_get(_: Authorised) -> dict:
        engine_ = get_engine()
        return {"api_version": API_VERSION, **engine_.global_catalog.snapshot()}

    @app.post("/v1/catalog/sync")
    async def catalog_sync(_: Authorised, request: Request) -> dict:
        """Sync desired revision index zips into the global catalog.

        Form field ``meta`` is JSON ``{"sets":[{set_key, content_hash, revision_id, target_id}]}``.
        For each set whose hash is new/changed, include a file field named ``zip_<set_key>``.
        Sets not listed are dropped from the catalog.
        """
        engine_ = get_engine()
        form = await request.form()
        meta_raw = form.get("meta")
        if meta_raw is None:
            raise HTTPException(422, "meta form field is required")
        if hasattr(meta_raw, "read"):
            meta_raw = (await meta_raw.read()).decode("utf-8")
        try:
            payload = json.loads(str(meta_raw))
            desired = payload["sets"]
            if not isinstance(desired, list):
                raise ValueError("sets must be a list")
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise HTTPException(422, "meta must be JSON with a sets array") from exc
        zips: dict[str, bytes] = {}
        for key in form:
            if not str(key).startswith("zip_"):
                continue
            set_key = str(key)[4:]
            upload = form[key]
            if hasattr(upload, "read"):
                data = await upload.read()
            else:
                data = bytes(upload)
            zips[set_key] = data
        try:
            snapshot = engine_.global_catalog.sync(desired, zips)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"api_version": API_VERSION, **snapshot}

    @app.post("/v1/match-global")
    def match_global(
        image: Annotated[UploadFile, File()],
        meta: Annotated[str, Form()],
        _: Authorised,
    ) -> JSONResponse:
        t0 = time.perf_counter()
        if (image.content_type or "").lower() != "image/jpeg":
            raise HTTPException(415, "image must be sent as image/jpeg")
        try:
            frame = FrameMeta.model_validate(json.loads(meta))
        except (ValueError, ValidationError) as exc:
            raise HTTPException(422, "meta must be valid frame metadata JSON") from exc
        data = image.file.read(MAX_UPLOAD_BYTES + 1)
        width, height = _check_jpeg(data)
        decode_ms = _ms(t0)
        engine_ = get_engine()
        with tempfile.TemporaryDirectory(prefix="placematch-frame-") as tmp:
            path = Path(tmp) / "frame.jpg"
            path.write_bytes(data)
            try:
                body, timings = engine_.match_global(path)
            except NoBackendAvailable as exc:
                return JSONResponse(
                    {
                        "api_version": API_VERSION,
                        "error": "no_backend_available",
                        "detail": str(exc),
                    },
                    status_code=503,
                )
        timings = {"decode": decode_ms, **timings, "total": _ms(t0)}
        body.update(
            frame={**frame.model_dump(), "width": width, "height": height},
            timings_ms=timings,
            stored=False,
        )
        return JSONResponse(body)

    return app


def app_factory():
    """Entry point for ``uvicorn --factory placematch.mobile_api:app_factory``."""
    return create_app()
