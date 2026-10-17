"""Load credentials from the environment, falling back to the app's ignored ``.env``."""

from __future__ import annotations

import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = APP_DIR / "data"
RUNS_DIR = APP_DIR / "runs"


def load_env(path: Path = APP_DIR / ".env") -> None:
    """Set variables from a simple KEY=VALUE file without overriding existing ones."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def require(name: str) -> str:
    load_env()
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} is not set (environment or apps/place-match/.env)")
    return value
