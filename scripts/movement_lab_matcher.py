"""Opt-in, local CPU MegaLoc matching against immutable original reference embeddings.

No reference recomputation, incoming-frame cache, DB writes, provider calls or video retention.
"""

from __future__ import annotations

import json
import secrets
import tempfile
import threading
import time
from pathlib import Path


class LabMatcher:
    def __init__(self, run: Path, model_cache: Path):
        import numpy as np
        import torch
        from placematch.backends import megaloc
        from placematch.causal_tracking import CausalGraphTracker
        from placematch.ops.point_video_tracking import (
            aggregate_point_scores,
            graph_point_distances,
            validate_vectors,
        )

        torch.set_num_threads(8)
        megaloc.MODEL_DIR = model_cache
        megaloc.CODE_PATH = model_cache / ("repo-" + megaloc.COMMIT) / "megaloc_model.py"
        megaloc.WEIGHTS_PATH = model_cache / ("hf-" + megaloc.HF_REVISION) / "model.safetensors"
        megaloc.device_name = lambda: "cpu"
        self.refs = json.loads((run / "reference-rows.json").read_text())
        self.vectors = np.load(run / "embeddings/reference-vectors.npy")
        validate_vectors(self.vectors, len(self.refs))
        self.node_ids, _ = aggregate_point_scores(
            np.zeros((1, len(self.refs))), [r["node_id"] for r in self.refs]
        )
        manifest = json.loads((run / "reference-manifest.json").read_text())
        nodes = [n for w in manifest["walks"] for n in w["graph"]["nodes"]]
        edges = [e for w in manifest["walks"] for e in w["graph"]["edges"]]
        self.distances = graph_point_distances(nodes, edges, self.node_ids)
        self.metadata = {r["node_id"]: r for r in self.refs}
        self.indices = [
            [i for i, r in enumerate(self.refs) if r["node_id"] == n] for n in self.node_ids
        ]
        self.make_tracker = lambda: CausalGraphTracker(self.node_ids, self.distances)
        self.model = megaloc.load_model()
        self.backend = megaloc.MegaLocBackend(
            image_size=322,
            batch_size=1,
            cache_root=Path(tempfile.gettempdir()) / "snapway-lab-unused-cache",
        )
        self.sessions = {}
        self.guard = threading.Lock()
        self.inference = threading.Lock()

    def session(self):
        now = time.monotonic()
        with self.guard:
            self.sessions = {k: v for k, v in self.sessions.items() if now - v["seen"] < 300}
            if len(self.sessions) >= 32:
                raise RuntimeError("Too many active test sessions; retry later.")
            key = secrets.token_urlsafe(24)
            self.sessions[key] = {
                "tracker": self.make_tracker(),
                "start": now,
                "seen": now,
                "request": 0.0,
                "clock": None,
                "capture_start": None,
                "capture_last": None,
            }
            return key

    def match(self, key: str, jpeg: bytes, *, capture_timestamp: float | None = None):
        import numpy as np
        import torch
        from PIL import Image
        from placematch.quality import assess

        now = time.monotonic()
        with self.guard:
            session = self.sessions.get(key)
            if not session or now - session["seen"] > 300:
                raise PermissionError("Start a fresh live matching session.")
            if now - session["request"] < 1:
                raise BlockingIOError("Frames are limited to one per second.")
            clock = "capture" if capture_timestamp is not None else "server"
            if session["clock"] is not None and session["clock"] != clock:
                raise ValueError("Start a new session before changing capture clock.")
            session["clock"] = clock
            if capture_timestamp is not None:
                if not np.isfinite(capture_timestamp) or capture_timestamp < 0:
                    raise ValueError("Capture timestamp must be finite and nonnegative.")
                if (
                    session["capture_last"] is not None
                    and capture_timestamp <= session["capture_last"]
                ):
                    raise ValueError("Capture timestamps must increase.")
                if session["capture_start"] is None:
                    session["capture_start"] = capture_timestamp
                session["capture_last"] = capture_timestamp
            session["request"] = now
            session["seen"] = now
        if not self.inference.acquire(blocking=False):
            raise BlockingIOError("The local CPU matcher is busy; retry after a pause.")
        try:
            started = time.perf_counter()
            with tempfile.TemporaryDirectory(prefix="snapway-live-frame-") as tmp:
                path = Path(tmp) / "frame.jpg"
                path.write_bytes(jpeg)
                with Image.open(path) as image:
                    if (
                        image.format != "JPEG"
                        or max(image.size) > 4096
                        or image.width * image.height > 6_000_000
                    ):
                        raise ValueError("Send a JPEG up to 4096 pixels and 6 megapixels.")
                    image.verify()
                quality = assess(path)
                tensor = self.backend._tensor(path)
                with torch.inference_mode():
                    vector = self.model(tensor.unsqueeze(0)).float().cpu().numpy()[0]
                norm = np.linalg.norm(vector)
                if not np.isfinite(vector).all() or not np.isfinite(norm) or norm < 1e-8:
                    raise ValueError("The descriptor was invalid.")
                vector /= norm
                similarities = self.vectors @ vector
                scores = np.array([similarities[ix].max() for ix in self.indices])
                result = session["tracker"].update(
                    scores,
                    (capture_timestamp - session["capture_start"])
                    if capture_timestamp is not None
                    else time.monotonic() - session["start"],
                    quality.flags,
                )
            node = self.metadata[result["candidate_node_id"]]
            return {
                "timeSeconds": result["timestamp_s"],
                "nodeId": result["node_id"],
                "candidateNodeId": result["candidate_node_id"],
                "label": f"Point {node['point_number']}",
                "status": "candidate" if not result["uncertain"] else "uncertain",
                "similarity": result["candidate_score"],
                "margin": result["margin"],
                "note": result["reason"],
                "qualityFlags": quality.flags,
                "topk": [
                    {
                        "nodeId": r["node_id"],
                        "label": f"Point {self.metadata[r['node_id']]['point_number']}",
                        "similarity": r["score"],
                    }
                    for r in result["topk"]
                ],
                "inferenceMs": round((time.perf_counter() - started) * 1000, 1),
                "stored": False,
                "captureMonotonicSeconds": capture_timestamp,
                "futureContext": False,
            }
        finally:
            self.inference.release()
