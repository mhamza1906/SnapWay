"""Thread-safe request/latency/usage counters, memory and hardware notes.

Logical requests (one per image, ``EmbedStats.api_requests``) are counted by the backend;
``http_attempts`` counts every HTTP request the SDK actually sent (including retries),
observed through an httpx event hook. Hooks record only the destination host and the
status code: never headers, URLs with query strings, bodies or credentials.
"""

from __future__ import annotations

import platform
import resource
import subprocess
import sys
import threading
import time
from collections import Counter

import numpy as np


def percentiles(values: list[float]) -> dict:
    """p50/p95/mean/max/n of a list of seconds (empty -> {"n": 0})."""
    if not values:
        return {"n": 0}
    a = np.asarray(values, dtype=float)
    return {
        "n": int(a.size),
        "p50": round(float(np.percentile(a, 50)), 4),
        "p95": round(float(np.percentile(a, 95)), 4),
        "mean": round(float(a.mean()), 4),
        "max": round(float(a.max()), 4),
    }


def peak_rss_mb() -> float:
    """Peak resident set size of this process (macOS reports bytes, Linux KiB)."""
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(peak / (1 << 20) if sys.platform == "darwin" else peak / 1024, 1)


def current_rss_mb(pid: int | None = None) -> float | None:
    """Current RSS via ``ps`` (no psutil dependency)."""
    import os

    try:
        out = subprocess.run(
            ["ps", "-o", "rss=", "-p", str(pid or os.getpid())],
            capture_output=True, text=True, check=True, timeout=10,
        )  # fmt: skip
        return round(int(out.stdout.strip()) / 1024, 1)
    except Exception:
        return None


def mps_memory_mb() -> dict:
    """MPS allocator numbers when torch is already imported and MPS is available."""
    torch = sys.modules.get("torch")
    if torch is None or not torch.backends.mps.is_available():
        return {}
    return {
        "mps_current_allocated_mb": round(torch.mps.current_allocated_memory() / (1 << 20), 1),
        "mps_driver_allocated_mb": round(torch.mps.driver_allocated_memory() / (1 << 20), 1),
    }


def _sysctl(name: str) -> str | None:
    try:
        return subprocess.run(
            ["sysctl", "-n", name], capture_output=True, text=True, check=True, timeout=5
        ).stdout.strip()
    except Exception:
        return None


def concurrent_workload(min_cpu: float = 20.0, limit: int = 8) -> list[dict]:
    """Other processes using noticeable CPU right now (command names only, no arguments)."""
    import os

    try:
        out = subprocess.run(
            ["ps", "-Ao", "pid=,pcpu=,rss=,comm="], capture_output=True, text=True, timeout=10
        ).stdout
    except Exception:
        return []
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4 or int(parts[0]) == os.getpid():
            continue
        cpu = float(parts[1])
        if cpu >= min_cpu:
            rows.append(
                {
                    "pid": int(parts[0]),
                    "cpu_percent": cpu,
                    "rss_mb": round(int(parts[2]) / 1024, 1),
                    "command": parts[3].rsplit("/", 1)[-1][:60],
                }
            )
    return sorted(rows, key=lambda r: -r["cpu_percent"])[:limit]


def hardware(note: str | None = None) -> dict:
    """Chip, RAM, accelerator and a snapshot of concurrent CPU load."""
    mem = _sysctl("hw.memsize")
    accel = "unknown"
    torch = sys.modules.get("torch")
    if torch is not None:
        accel = "mps" if torch.backends.mps.is_available() else "cpu"
    load = None
    try:
        import os

        load = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        pass
    out = {
        "chip": _sysctl("machdep.cpu.brand_string") or platform.processor(),
        "ram_gb": round(int(mem) / (1 << 30), 1) if mem and mem.isdigit() else None,
        "cpu_count": _sysctl("hw.ncpu"),
        "os": platform.platform(),
        "python": platform.python_version(),
        "accelerator": accel,
        "load_average_1_5_15": load,
        "concurrent_workload": concurrent_workload(),
    }
    if note:
        out["note"] = note
    return out


class Telemetry:
    """Counters shared by a backend's worker threads. ``mark()``/``since()`` give per-run deltas."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.http_attempts = 0
        self.http_by_host: Counter = Counter()
        self.http_status: Counter = Counter()
        self.usage: Counter = Counter()
        self.embed_latency_s: list[float] = []  # per successful logical request / image
        self.attempt_latency_s: list[float] = []  # per HTTP attempt (success or failure)
        self.per_sha_s: dict[str, float] = {}
        self.events: dict[str, float] = {}  # e.g. client_create_s, model_load_s
        self.model_versions: set[str] = set()
        self._t_req: dict[int, float] = {}

    # httpx hooks (sync client) ------------------------------------------------------
    def on_request(self, request) -> None:
        with self._lock:
            self.http_attempts += 1
            self.http_by_host[request.url.host] += 1
            self._t_req[id(request)] = time.perf_counter()

    def on_response(self, response) -> None:
        with self._lock:
            self.http_status[str(response.status_code)] += 1
            t = self._t_req.pop(id(response.request), None)
            if t is not None:
                self.attempt_latency_s.append(time.perf_counter() - t)

    def hooks(self) -> dict:
        return {"request": [self.on_request], "response": [self.on_response]}

    # backend-side records -----------------------------------------------------------
    def record_embed(self, sha: str, seconds: float, usage: dict | None = None) -> None:
        with self._lock:
            self.embed_latency_s.append(seconds)
            self.per_sha_s[sha] = seconds
            for k, v in (usage or {}).items():
                if isinstance(v, int | float):
                    self.usage[k] += v

    def record_event(self, name: str, seconds: float) -> None:
        with self._lock:
            self.events[name] = round(seconds, 4)

    def mark(self) -> dict:
        with self._lock:
            return {
                "http": self.http_attempts,
                "hosts": Counter(self.http_by_host),
                "status": Counter(self.http_status),
                "usage": Counter(self.usage),
                "lat": len(self.embed_latency_s),
                "att": len(self.attempt_latency_s),
                "events": dict(self.events),
            }

    def since(self, mark: dict | None = None) -> dict:
        m = mark or {
            "http": 0, "hosts": Counter(), "status": Counter(), "usage": Counter(),
            "lat": 0, "att": 0, "events": {},
        }  # fmt: skip
        with self._lock:
            return {
                "http_attempts": self.http_attempts - m["http"],
                "http_by_host": dict(self.http_by_host - m["hosts"]),
                "http_status": dict(self.http_status - m["status"]),
                "usage": {k: v for k, v in (self.usage - m["usage"]).items()},
                "embed_latency_s": list(self.embed_latency_s[m["lat"] :]),
                "attempt_latency_s": list(self.attempt_latency_s[m["att"] :]),
                "events": {k: v for k, v in self.events.items() if m["events"].get(k) != v},
                "model_versions": sorted(self.model_versions),
            }
