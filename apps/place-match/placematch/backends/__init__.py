"""Backend registry. Each backend keeps its own cache and index; vectors are never mixed.

- ``vertex``: Vertex AI ``gemini-embedding-2`` (ADC, project/location from the env).
- ``gemini``: Gemini **Developer API** ``gemini-embedding-2`` (API key; bench-v1 only).
- ``megaloc``: local MegaLoc descriptors (no requests).

There is no automatic fallback between backends.
"""

from __future__ import annotations

from placematch.backends.base import EmbeddingBackend

BACKENDS = ("vertex", "gemini", "megaloc")


def get_backend(name: str, **options) -> EmbeddingBackend:
    """Return a configured backend by name (see :data:`BACKENDS`)."""
    if name == "vertex":
        from placematch.backends.vertex import VertexBackend

        return VertexBackend(**options)
    if name == "gemini":
        from placematch.backends.gemini import GeminiBackend

        return GeminiBackend(**options)
    if name == "megaloc":
        from placematch.backends.megaloc import MegaLocBackend

        return MegaLocBackend(**options)
    raise ValueError(f"unknown backend {name!r}; choose from {BACKENDS}")
