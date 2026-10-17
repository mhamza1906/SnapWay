"""Cost *estimates* for embedding requests. Not a bill: always cite the source and date.

Vertex AI, ``gemini-embedding-2``, checked 2026-10-17 on
https://cloud.google.com/vertex-ai/generative-ai/pricing (now served from
cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing), table
"MultiModal Embeddings", row "Gemini Embedding 2 (Unified Multimodal, Preview)":
input image USD 0.45 per 1M tokens (online), USD 0.225 (batch); no output-token charge.
Token count per image: 258 (``Get multimodal embeddings`` page, API limits table).
The pricing row is labelled "Preview" while the model page lists ``gemini-embedding-2`` as
GA (2026-04-22); we use that row as the best published figure and say so.
"""

from __future__ import annotations

VERTEX_GEMINI_EMBEDDING_2 = {
    "provider": "vertex-ai",
    "model": "gemini-embedding-2",
    "usd_per_1m_image_tokens_online": 0.45,
    "usd_per_1m_image_tokens_batch": 0.225,
    "tokens_per_image_documented": 258,
    "pricing_source": "https://cloud.google.com/vertex-ai/generative-ai/pricing",
    "token_source": (
        "https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-multimodal-embeddings"
    ),
    "pricing_checked_utc": "2026-10-17",
    "pricing_note": (
        "table row is labelled 'Gemini Embedding 2 (Unified Multimodal, Preview)'; the model "
        "page lists gemini-embedding-2 as GA. Online (pay-as-you-go) requests only."
    ),
}

LOCAL = {
    "provider": "local",
    "pricing_source": "local model: no per-request charge (electricity/hardware not counted)",
    "pricing_checked_utc": None,
}

#: Developer API pricing was not re-verified in the v2 phase (no further requests allowed).
GEMINI_DEVELOPER_API = {
    "provider": "gemini-developer-api",
    "pricing_source": None,
    "pricing_checked_utc": None,
    "pricing_note": "not re-verified in the v2 phase; no further Developer API requests",
}


def vertex_cost(n_images: int = 0, image_tokens: int | None = None, *, batch: bool = False) -> dict:
    """Estimated USD for ``n_images`` single-image requests (or measured ``image_tokens``)."""
    p = VERTEX_GEMINI_EMBEDDING_2
    rate = p["usd_per_1m_image_tokens_batch" if batch else "usd_per_1m_image_tokens_online"]
    if image_tokens is None:
        tokens = n_images * p["tokens_per_image_documented"]
        basis = "documented_258_tokens_per_image"
    else:
        tokens, basis = int(image_tokens), "usage_metadata_token_count"
    return {
        "usd": round(tokens * rate / 1e6, 6),
        "tokens": tokens,
        "basis": basis,
        "usd_per_1m_image_tokens": rate,
        "pricing_source": p["pricing_source"],
        "pricing_checked_utc": p["pricing_checked_utc"],
        "note": "estimate from the published price list; actual billing may differ",
    }
