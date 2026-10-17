"""Vertex AI ``gemini-embedding-2`` image embeddings (Application Default Credentials).

Verified 2026-10-17 (see ``VERTEX.md`` for the full record):
- https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-multimodal-embeddings
- https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/embedding-2
- https://cloud.google.com/vertex-ai/generative-ai/pricing

Model ``gemini-embedding-2`` (GA 2026-04-22; ``-preview`` is a separate model). Locations:
``global``, ``us``, ``eu`` (multi-region). Max 8,192 input tokens; an image counts as 258
tokens; at most 6 images per request (we send exactly one image per request, because the
parts of one ``Content`` are aggregated into ONE embedding and the Vertex ``embedContent``
method accepts a single content). Image MIME types: PNG, JPEG, WebP, BMP, HEIC, HEIF, AVIF;
max 16384x16384 px. Output 3072-d by default, smaller via ``output_dimensionality`` (MRL;
already L2-normalised for non-default sizes; we re-normalise anyway). ``task_type`` is not
supported; no task instruction is sent for images. Quotas are global, shared across
locations. SDK: ``genai.Client(vertexai=True, project=..., location=...)`` +
``client.models.embed_content`` (google-genai routes ``gemini-*`` to ``:embedContent``).

Preprocessing is identical to the Developer API backend (upright RGB, longest side <= 1024,
JPEG q90 4:4:4), so the only difference between the two backends is the provider. Vectors
from the two providers live in separate caches and indexes and are never mixed.
"""

from __future__ import annotations

import os
import time

from placematch.backends.gemini import (
    MODEL,
    GoogleEmbeddingBackend,
    _preprocessing,
    sdk_endpoint,
)

#: Locations listed for gemini-embedding-2 on the Vertex AI model page (2026-10-17).
DOCUMENTED_LOCATIONS = ("global", "us", "eu")
SCOPES = ("https://www.googleapis.com/auth/cloud-platform",)


class VertexBackend(GoogleEmbeddingBackend):
    """Vertex AI ``embedContent`` with ADC. Never falls back to another provider or model."""

    provider = "vertex-ai"

    def __init__(
        self,
        project: str | None = None,
        location: str | None = None,
        model: str = MODEL,
        dims: int = 3072,
        max_side: int = 1024,
        jpeg_quality: int = 90,
        concurrency: int = 4,
        max_attempts: int = 6,
        base_delay_s: float = 2.0,
        timeout_s: float = 60.0,
        cache_root=None,
        client=None,
        credentials=None,
    ):
        from placematch.env import load_env

        load_env()
        self.project = project or os.environ.get("VERTEX_PROJECT", "")
        self.location = location or os.environ.get("VERTEX_LOCATION", "")
        if not self.project:
            raise RuntimeError("VERTEX_PROJECT is not set (environment or repository local/.env)")
        if not self.location:
            raise RuntimeError("VERTEX_LOCATION is not set (environment or repository local/.env)")
        if self.location not in DOCUMENTED_LOCATIONS:
            raise ValueError(
                f"location {self.location!r} is not documented for {model} on Vertex AI "
                f"(documented: {', '.join(DOCUMENTED_LOCATIONS)})"
            )
        self._credentials = credentials
        self.auth = None
        self.endpoint = sdk_endpoint(True, self.project, self.location)
        super().__init__(
            model=model, dims=dims, max_side=max_side, jpeg_quality=jpeg_quality,
            concurrency=concurrency, max_attempts=max_attempts, base_delay_s=base_delay_s,
            timeout_s=timeout_s, cache_root=cache_root, client=client,
        )  # fmt: skip

    def _make_key(self) -> str:
        return (
            f"vertex:{self.model}@{self.location}:d{self.dims}"
            f":max{self.max_side}:jpg{self.jpeg_quality}"
        )

    def _cache_config(self) -> dict:
        """Everything that can change the vectors (not runtime observations)."""
        return {
            "provider": self.provider,
            "project": self.project,
            "location": self.location,
            "model": self.model,
            "output_dimensionality": self.dims,
            "task_type": None,
            "images_per_request": 1,
            "api_method": "embedContent",
            "endpoint_host": self.endpoint["endpoint_host"],
            "preprocessing": _preprocessing(self.max_side, self.jpeg_quality),
            "normalisation": "l2",
        }

    def config(self) -> dict:
        cfg = self._cache_config()
        cfg.update(
            dims=self.dims,
            api_version=self.endpoint["api_version"],
            model_version=(sorted(self.telemetry.model_versions) or [None])[-1],
            auth=self.auth or "application_default_credentials (not loaded yet)",
            hosts_contacted=dict(self.telemetry.http_by_host),
            docs="https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-multimodal-embeddings",
            pricing=self.cost_estimate(1),
        )
        return cfg

    def cost_estimate(self, n_images: int = 0, usage: dict | None = None) -> dict:
        from placematch.ops.pricing import vertex_cost

        tokens = None
        if usage and usage.get("responses_with_usage") == usage.get("responses"):
            tokens = usage.get("tokens_image", usage.get("prompt_tokens"))
        return vertex_cost(n_images, tokens)

    def _new_client(self):
        import google.auth
        from google import genai

        creds = self._credentials
        if creds is None:
            t = time.perf_counter()
            creds, _ = google.auth.default(scopes=list(SCOPES))
            self.telemetry.record_event("adc_load_s", time.perf_counter() - t)
        self.auth = (
            f"application_default_credentials ({type(creds).__module__}.{type(creds).__name__})"
        )
        client = genai.Client(
            vertexai=True,
            project=self.project,
            location=self.location,
            credentials=creds,
            http_options=self._http_options(),
        )
        base = client._api_client._http_options.base_url
        if self.endpoint["base_url"] != base:  # never send to an unexpected host
            raise RuntimeError(f"unexpected Vertex base URL {base!r}")
        return client
