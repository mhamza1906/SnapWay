# Geometry boundary

This package is reserved for pure map normalization, validation, restricted SVG
import/export and deterministic graph functions. It must not depend on HTTP
requests, Django permissions or provider SDK response objects. Structured map
geometry will be authoritative; generated SVG is a derived artifact.

No map schema or algorithms are implemented by this scaffold. Install this
profile with `uv sync --locked --extra geometry`; ordinary team bootstrap
includes it. Reuse provenance and tests accompany any later source extraction.
