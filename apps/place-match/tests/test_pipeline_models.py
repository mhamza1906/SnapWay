"""Local models. Skipped when weights are absent; MegaLoc inference only with PLACEMATCH_SLOW=1."""

from __future__ import annotations

import json
import os
import struct

import numpy as np
import pytest
from PIL import Image

from placematch.backends import megaloc
from placematch.verify import coverage, verify_pair, weights_present


def test_coverage_grid():
    pts = np.array([[1.0, 1.0], [99.0, 99.0], [2.0, 2.0]])
    assert coverage(pts, (100, 100), grid=8) == 2 / 64
    assert coverage(np.zeros((0, 2)), (10, 10)) == 0.0


def test_safetensors_reader(tmp_path):
    arr = np.arange(6, dtype=np.float32).reshape(2, 3)
    header = json.dumps({"w": {"dtype": "F32", "shape": [2, 3], "data_offsets": [0, 24]}}).encode()
    p = tmp_path / "t.safetensors"
    p.write_bytes(struct.pack("<Q", len(header)) + header + arr.tobytes())
    assert np.array_equal(megaloc.load_safetensors(p)["w"].numpy(), arr)


@pytest.mark.skipif(not weights_present(), reason="SuperPoint/LightGlue weights not downloaded")
def test_verify_true_and_unrelated(tmp_path):
    rng = np.random.default_rng(0)
    base = Image.fromarray(rng.integers(0, 255, (60, 80, 3), dtype=np.uint8)).resize(
        (640, 480), Image.Resampling.BICUBIC
    )
    base.crop((0, 0, 560, 420)).save(tmp_path / "a.png")
    base.crop((60, 40, 620, 460)).save(tmp_path / "b.png")
    Image.fromarray(np.random.default_rng(1).integers(0, 255, (60, 80, 3), dtype=np.uint8)).resize(
        (560, 420), Image.Resampling.BICUBIC
    ).save(tmp_path / "c.png")
    ok = verify_pair(tmp_path / "a.png", tmp_path / "b.png", overlay_path=tmp_path / "o.png")
    assert ok.status == "verified" and ok.n_inliers > 40 and (tmp_path / "o.png").is_file()
    bad = verify_pair(tmp_path / "a.png", tmp_path / "c.png")
    assert bad.status == "inconclusive"
    err = verify_pair(tmp_path / "missing.png", tmp_path / "c.png")
    assert err.status == "error"


@pytest.mark.skipif(
    not (megaloc.weights_present() and os.environ.get("PLACEMATCH_SLOW")),
    reason="MegaLoc weights absent or PLACEMATCH_SLOW unset",
)
def test_megaloc_embeds(tmp_path):
    from placematch.backends.base import EmbedStats, RequestBudget

    p = tmp_path / "x.png"
    Image.new("RGB", (100, 80), (90, 120, 30)).save(p)
    b = megaloc.MegaLocBackend(cache_root=tmp_path / "c")
    v = b.embed_paths([p], budget=RequestBudget(0), stats=EmbedStats())
    assert v.shape == (1, 8448) and abs(float(np.linalg.norm(v)) - 1) < 1e-4


def test_oom_retries_on_cpu_then_errors(monkeypatch, tmp_path):
    from placematch import verify as V
    from placematch.schemas import VerificationResult

    devices = []

    def fake_extract(path, device=None):
        devices.append(device)
        if device is None or always_oom:
            raise RuntimeError("MPS backend out of memory (test)")
        return {}, np.zeros((4, 4, 3), np.uint8)

    monkeypatch.setattr(V, "default_device", lambda: "mps")
    monkeypatch.setattr(V, "empty_cache", lambda: None)
    monkeypatch.setattr(V, "extract", fake_extract)
    monkeypatch.setattr(V, "_verify", lambda *a: VerificationResult(status="inconclusive"))
    always_oom = False
    r = V.verify_pair(tmp_path / "a.png", tmp_path / "b.png")
    assert r.status == "inconclusive" and "retried on CPU" in r.message
    assert devices == [None, "cpu", "cpu"]
    always_oom = True
    r = V.verify_pair(tmp_path / "c.png", tmp_path / "d.png")
    assert r.status == "error" and "out of memory" in r.message
