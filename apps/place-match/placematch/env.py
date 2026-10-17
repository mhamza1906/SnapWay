"""Load process settings with the shared ignored repository local/.env as fallback."""

from __future__ import annotations

import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
PRIVATE_ENV = APP_DIR.parents[1] / "local" / ".env"
DATA_DIR = APP_DIR / "data"
RUNS_DIR = APP_DIR / "runs"
ENGINE_KEYS = {
    "GEMINI_API_KEY",
    "VERTEX_PROJECT",
    "VERTEX_LOCATION",
    "PLACEMATCH_ENGINE_TOKEN",
    "MOBILE_REFERENCE_SET",
    "MOBILE_RATE_LIMIT_PER_MIN",
    "MOBILE_STORE_FRAMES",
    "MOBILE_ENABLE_VERTEX",
}


def load_env(path: Path | None = None) -> None:
    """Set variables from a simple KEY=VALUE file without overriding existing ones."""
    path = PRIVATE_ENV if path is None else path
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() not in ENGINE_KEYS:
            continue
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def require(name: str) -> str:
    load_env()
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} is not set (process environment or repository local/.env)")
    return value
