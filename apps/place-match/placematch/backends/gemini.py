"""Google ``gemini-embedding-2`` image embeddings: shared client logic + Developer API backend.

Provider identity (verified 2026-10-17 from google-genai 2.31 ``_api_client.BaseApiClient``):
``genai.Client(api_key=...)`` without ``vertexai=True`` (and without
``GOOGLE_GENAI_USE_VERTEXAI``) is the **Gemini Developer API**: base URL
``https://generativelanguage.googleapis.com/``, API version ``v1beta``, key sent in the
``x-goog-api-key`` header. It is not Vertex AI (``backends/vertex.py`` is). bench-v1 used this
backend; its key ``gemini:gemini-embedding-2:d3072:max1024:jpg90`` and cache directory
(hash of :data:`LEGACY_CACHE_CONFIG`) are kept unchanged so its cache and results stay valid.

Developer API docs verified 2026-10-17:
- https://ai.google.dev/gemini-api/docs/embeddings
- https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2
- https://ai.google.dev/gemini-api/docs/rate-limits

``gemini-embedding-2`` accepts PNG/JPEG inline, up to 6 images and 8,192 input tokens per
request; output dimensionality 128..3072 (default 3072). ``task_type`` is not supported, and
no task prefix is sent for images. Parts inside one ``Content`` are aggregated into ONE
embedding, so every image is sent as its own request. 429 => wait and retry.
"""

from __future__ import annotations

import functools
import io
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import numpy as np

from placematch.backends.base import EmbedStats, RequestBudget
from placematch.cache import EmbeddingCache, embed_with_cache
from placematch.frames import InvalidImage, load_upright
from placematch.ops.telemetry import Telemetry

MODEL = "gemini-embedding-2"
TRANSIENT_HTTP = {408, 429, 500, 502, 503, 504}
FATAL_HTTP = {401, 403, 404}  # auth / API disabled / unknown model: stop sending requests


def preprocess(path: Path, max_side: int, quality: int) -> bytes:
    """Upright RGB, downscale (never upscale) to ``max_side``, JPEG re-encode; deterministic."""
    im = load_upright(path)
    scale = max_side / max(im.size)
    if scale < 1:
        from PIL import Image

        im = im.resize(
            (max(1, round(im.width * scale)), max(1, round(im.height * scale))),
            Image.Resampling.LANCZOS,
        )
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality, subsampling=0, optimize=False)
    return buf.getvalue()


def is_transient(exc: BaseException) -> bool:
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        return code in TRANSIENT_HTTP
    name = type(exc).__name__.lower()
    return any(s in name for s in ("timeout", "connect", "remoteprotocol", "readerror"))


def _preprocessing(max_side: int, jpeg_quality: int) -> dict:
    return {
        "exif_transpose": True,
        "color": "RGB",
        "max_side": max_side,
        "resample": "lanczos",
        "upscale": False,
        "format": "jpeg",
        "jpeg_quality": jpeg_quality,
        "subsampling": "4:4:4",
    }


def legacy_cache_config(model: str, dims: int, max_side: int, jpeg_quality: int) -> dict:
    """The config dict bench-v1 hashed into its cache directory name. Never change it."""
    return {
        "provider": "google-gemini-api",
        "model": model,
        "output_dimensionality": dims,
        "task_type": None,
        "images_per_request": 1,
        "preprocessing": _preprocessing(max_side, jpeg_quality),
        "normalisation": "l2",
        "docs": "https://ai.google.dev/gemini-api/docs/embeddings",
    }


@functools.cache
def sdk_endpoint(vertexai: bool, project: str | None = None, location: str | None = None) -> dict:
    """Base URL the installed SDK configures for these settings (offline: nothing is sent).

    Builds a throwaway client with a placeholder key / anonymous credentials and reads its
    configured ``base_url``; no real credentials are loaded or used.
    """
    from google import genai

    if vertexai:
        from google.auth.credentials import AnonymousCredentials

        c = genai.Client(
            vertexai=True, project=project, location=location, credentials=AnonymousCredentials()
        )
    else:
        c = genai.Client(vertexai=False, api_key="placeholder-not-a-key")
    opts = c._api_client._http_options
    out = {
        "base_url": opts.base_url,
        "endpoint_host": urlparse(opts.base_url).hostname,
        "api_version": opts.api_version,
        "sdk_vertexai_flag": bool(c._api_client.vertexai),
    }
    c.close()
    return out


class GoogleEmbeddingBackend:
    """One image per ``embed_content`` request, own retry loop, telemetry, content cache."""

    remote = True
    provider = "google"

    def __init__(
        self,
        model: str = MODEL,
        dims: int = 3072,
        max_side: int = 1024,
        jpeg_quality: int = 90,
        concurrency: int = 4,
        max_attempts: int = 6,
        base_delay_s: float = 2.0,
        timeout_s: float = 60.0,
        cache_root: Path | None = None,
        client=None,
    ):
        if not 128 <= dims <= 3072:
            raise ValueError("gemini-embedding-2 output_dimensionality must be in 128..3072")
        self.model, self.dims = model, dims
        self.max_side, self.jpeg_quality = max_side, jpeg_quality
        self.concurrency, self.max_attempts = max(1, concurrency), max(1, max_attempts)
        self.base_delay_s, self.timeout_s = base_delay_s, timeout_s
        self.telemetry = Telemetry()
        self.key = self._make_key()
        self.cache = EmbeddingCache(self.key, self._cache_config(), cache_root)
        self._client = client
        self._lock = threading.Lock()
        self._abort = threading.Event()
        self._client_lock = threading.Lock()

    # subclass hooks ------------------------------------------------------------------
    def _make_key(self) -> str:
        raise NotImplementedError

    def _cache_config(self) -> dict:
        raise NotImplementedError

    def _new_client(self):
        raise NotImplementedError

    def config(self) -> dict:
        raise NotImplementedError

    def cost_estimate(self, n_images: int = 0, usage: dict | None = None) -> dict:
        raise NotImplementedError

    # shared ----------------------------------------------------------------------------
    def requests_for(self, n_images: int) -> int:
        return n_images

    def release(self) -> None:
        """Nothing local to free (remote model); present for interface symmetry."""

    def is_cold(self) -> bool:
        """True until the SDK client (and, for Vertex, credentials) has been created."""
        return self._client is None

    def _http_options(self):
        from google.genai import types

        return types.HttpOptions(
            timeout=int(self.timeout_s * 1000),
            retry_options=types.HttpRetryOptions(attempts=1),  # we retry ourselves
            client_args={"event_hooks": self.telemetry.hooks()},
        )

    def client(self):
        with self._client_lock:  # one shared client; concurrent creation closes losers
            if self._client is None:
                t = time.perf_counter()
                self._client = self._new_client()
                self.telemetry.record_event("client_create_s", time.perf_counter() - t)
            return self._client

    def _request(self, data: bytes) -> tuple[np.ndarray, dict]:
        from google.genai import types

        res = self.client().models.embed_content(
            model=self.model,
            contents=[
                types.Content(parts=[types.Part.from_bytes(data=data, mime_type="image/jpeg")])
            ],
            config=types.EmbedContentConfig(output_dimensionality=self.dims),
        )
        if not res.embeddings or len(res.embeddings) != 1:
            raise RuntimeError(f"expected 1 embedding, got {len(res.embeddings or [])}")
        vec = np.asarray(res.embeddings[0].values, dtype=np.float32)
        if vec.shape != (self.dims,):
            raise RuntimeError(f"unexpected embedding shape {vec.shape}")
        return vec, usage_of(res)

    def _embed_one(self, path: Path, sha: str, budget: RequestBudget, stats: EmbedStats) -> None:
        try:
            data = preprocess(path, self.max_side, self.jpeg_quality)
        except Exception as exc:  # unreadable/unsupported: no request is sent
            with self._lock:
                stats.failed.append(failure_message(path, exc))
            return
        with self._lock:
            if self._abort.is_set():
                stats.failed.append(f"{path}: not sent (previous fatal error)")
                return
            budget.take(1)
            stats.api_requests += 1
        t0 = time.perf_counter()
        for attempt in range(self.max_attempts):
            try:
                vec, usage = self._request(data)
                self.cache.put(sha, vec / max(float(np.linalg.norm(vec)), 1e-12))
                self.telemetry.record_embed(sha, time.perf_counter() - t0, usage)
                return
            except Exception as exc:
                if getattr(exc, "code", None) in FATAL_HTTP:
                    self._abort.set()
                if not is_transient(exc) or attempt == self.max_attempts - 1:
                    with self._lock:
                        stats.failed.append(f"{path}: {type(exc).__name__}: {str(exc)[:200]}")
                    return
                with self._lock:
                    stats.retries += 1
                    budget.retries += 1
                delay = min(60.0, self.base_delay_s * 2**attempt)
                time.sleep(delay * (0.5 + random.random()))

    def embed_paths(
        self, paths: list[Path], *, budget: RequestBudget, stats: EmbedStats
    ) -> np.ndarray:
        t0 = time.perf_counter()
        self._abort.clear()

        def run(todo: list[Path], shas: list[str]) -> None:
            self.client()  # create before the worker threads start
            with ThreadPoolExecutor(self.concurrency) as pool:
                for f in [
                    pool.submit(self._embed_one, p, s, budget, stats)
                    for p, s in zip(todo, shas, strict=True)
                ]:
                    f.result()

        try:
            return embed_with_cache(
                [Path(p) for p in paths],
                cache=self.cache,
                requests_for=self.requests_for,
                embed_uncached=run,
                budget=budget,
                stats=stats,
                remote=True,
            )
        finally:
            stats.elapsed_s += time.perf_counter() - t0


def failure_message(path: Path, exc: BaseException) -> str:
    """'<path>: <reason>' (InvalidImage messages already start with the path)."""
    if isinstance(exc, InvalidImage):
        return str(exc)[:500]
    return f"{path}: {type(exc).__name__}: {str(exc)[:300]}"


def _get(obj, name):
    return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)


def usage_of(res) -> dict:
    """Sum-able usage numbers from an EmbedContentResponse (whatever the provider returned)."""
    out: dict = {"responses": 1}
    st = _get(res.embeddings[0], "statistics")
    if st is not None:
        tc = _get(st, "token_count")
        if tc is not None:
            out["responses_with_usage"] = 1
            out["prompt_tokens"] = int(tc)
        if _get(st, "truncated"):
            out["truncated"] = 1
        for d in _get(st, "tokens_details") or []:
            modality = _get(d, "modality")
            modality = getattr(modality, "value", modality)
            n = _get(d, "token_count") or _get(d, "tokenCount")
            if modality and n is not None:
                out[f"tokens_{str(modality).lower()}"] = int(n)
    meta = _get(res, "metadata")
    if meta is not None and _get(meta, "billable_character_count") is not None:
        out["billable_character_count"] = int(_get(meta, "billable_character_count"))
    return out


class GeminiBackend(GoogleEmbeddingBackend):
    """Gemini **Developer API** (API key). Kept for the bench-v1 comparison only."""

    provider = "gemini-developer-api"

    def _make_key(self) -> str:
        return f"gemini:{self.model}:d{self.dims}:max{self.max_side}:jpg{self.jpeg_quality}"

    def _cache_config(self) -> dict:
        return legacy_cache_config(self.model, self.dims, self.max_side, self.jpeg_quality)

    def config(self) -> dict:
        ep = sdk_endpoint(False)
        cfg = legacy_cache_config(self.model, self.dims, self.max_side, self.jpeg_quality)
        cfg.update(
            provider=self.provider,
            endpoint_host=ep["endpoint_host"],
            api_version=ep["api_version"],
            project=None,
            location=None,
            dims=self.dims,
            auth="api_key (GEMINI_API_KEY, x-goog-api-key header)",
            cache_namespace_provider_label="google-gemini-api",  # bench-v1 label, unchanged
        )
        return cfg

    def cost_estimate(self, n_images: int = 0, usage: dict | None = None) -> dict:
        from placematch.ops.pricing import GEMINI_DEVELOPER_API

        return {"usd": None, **GEMINI_DEVELOPER_API}

    def _new_client(self):
        from google import genai

        from placematch.env import require

        return genai.Client(
            vertexai=False, api_key=require("GEMINI_API_KEY"), http_options=self._http_options()
        )
