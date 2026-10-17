"""MegaLoc global descriptors (local, no API requests; provider "local").

Source: https://github.com/gmberton/MegaLoc at commit 5fe0dd697c4a70ba3e23607f6716ab3c606b16db.
``hubconf.get_trained_model`` builds ``megaloc_model.MegaLoc()`` and loads
``model.safetensors`` from https://huggingface.co/gberton/MegaLoc. We do exactly that without
torch.hub / huggingface_hub: the pinned ``megaloc_model.py`` and the weights (HF revision
a0f34722c4297ff787e022433799250180860af7) live under ``data/models/megaloc/`` and are
checked by sha256. Preprocessing follows the README (same as VPR-methods-evaluation):
ToTensor, ImageNet mean/std normalisation, resize to 322x322 (antialias). Output: 8448-d,
L2-normalised.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import struct
import time
from pathlib import Path

import numpy as np

from placematch.backends.base import EmbedStats, RequestBudget
from placematch.backends.gemini import failure_message
from placematch.cache import EmbeddingCache, embed_with_cache
from placematch.env import DATA_DIR
from placematch.frames import load_upright
from placematch.ops.telemetry import Telemetry

REPO = "https://github.com/gmberton/MegaLoc"
COMMIT = "5fe0dd697c4a70ba3e23607f6716ab3c606b16db"
HF_REPO = "gberton/MegaLoc"
HF_REVISION = "a0f34722c4297ff787e022433799250180860af7"
MODEL_DIR = DATA_DIR / "models" / "megaloc"
CODE_PATH = MODEL_DIR / f"repo-{COMMIT}" / "megaloc_model.py"
WEIGHTS_PATH = MODEL_DIR / f"hf-{HF_REVISION}" / "model.safetensors"
CODE_URL = f"https://raw.githubusercontent.com/gmberton/MegaLoc/{COMMIT}/megaloc_model.py"
WEIGHTS_URL = f"https://huggingface.co/{HF_REPO}/resolve/{HF_REVISION}/model.safetensors"
CODE_SHA256 = "e3a66ae823abbbbc5e7975c649419a33036400eaa9fa5a955dd97eaa37f46c75"
WEIGHTS_SHA256 = "d4f9f2bcb60018f91eb6a8e061ed054fd55654e10c2569cf13841ea986ffb4f8"
MEAN, STD = (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)

_MODEL = None


def weights_present() -> bool:
    return CODE_PATH.is_file() and WEIGHTS_PATH.is_file()


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def download() -> None:
    """Fetch the pinned code and weights from the official repos (curl-free, via httpx)."""
    import httpx

    for url, dest in ((CODE_URL, CODE_PATH), (WEIGHTS_URL, WEIGHTS_PATH)):
        if dest.is_file():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        with httpx.stream("GET", url, follow_redirects=True, timeout=120) as r:
            r.raise_for_status()
            with open(tmp, "wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
        tmp.rename(dest)


def load_safetensors(path: Path) -> dict:
    """Minimal safetensors reader (format: u64 header length, JSON header, raw tensors)."""
    import torch

    dtypes = {"F32": np.float32, "F16": np.float16, "I64": np.int64, "I32": np.int32}
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        header = json.loads(f.read(n))
        blob = np.memmap(path, dtype=np.uint8, mode="r", offset=8 + n)
    out = {}
    for name, meta in header.items():
        if name == "__metadata__":
            continue
        a, b = meta["data_offsets"]
        arr = np.frombuffer(blob[a:b], dtype=dtypes[meta["dtype"]]).reshape(meta["shape"])
        out[name] = torch.from_numpy(arr.copy())
    return out


def device_name() -> str:
    import torch

    return "mps" if torch.backends.mps.is_available() else "cpu"


def is_loaded() -> bool:
    return _MODEL is not None


def load_model(telemetry: Telemetry | None = None):
    """Load (once) the pretrained MegaLoc model, verifying file hashes."""
    global _MODEL
    if _MODEL is None:
        t0 = time.perf_counter()
        if not weights_present():
            raise FileNotFoundError(f"MegaLoc files missing under {MODEL_DIR}; run download()")
        for path, want in ((CODE_PATH, CODE_SHA256), (WEIGHTS_PATH, WEIGHTS_SHA256)):
            if _sha256(path) != want:
                raise RuntimeError(f"sha256 mismatch for {path}")
        spec = importlib.util.spec_from_file_location("megaloc_model_pinned", CODE_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        model = module.MegaLoc()
        model.load_state_dict(load_safetensors(WEIGHTS_PATH))
        # MPS conv2d rejects the backbone's permuted (non-contiguous) feature map; making it
        # contiguous before the aggregator changes memory layout only, not values.
        model.aggregator.register_forward_pre_hook(
            lambda _m, args: (tuple(t.contiguous() for t in args[0]),)
        )
        _MODEL = model.eval().to(device_name())
        if telemetry is not None:
            telemetry.record_event("model_load_s", time.perf_counter() - t0)
    return _MODEL


def release() -> None:
    """Free the loaded model (about 0.9 GB) and cached MPS memory; reloads on next use."""
    global _MODEL
    _MODEL = None
    import gc

    gc.collect()
    import torch

    if torch.backends.mps.is_available():
        torch.mps.empty_cache()


class MegaLocBackend:
    remote = False

    def __init__(self, image_size: int = 322, batch_size: int = 8, cache_root: Path | None = None):
        self.image_size, self.batch_size = image_size, max(1, batch_size)
        self.key = f"megaloc:{COMMIT[:7]}:{image_size}x{image_size}"
        self.telemetry = Telemetry()
        # Cache namespace = hash of the bench-v1 config dict; keep it byte-for-byte stable.
        self.cache = EmbeddingCache(self.key, self._cache_config(), cache_root)

    def config(self) -> dict:
        return {
            **self._cache_config(),
            "provider": "local",
            "endpoint_host": None,
            "project": None,
            "location": None,
            "dims": 8448,
            "device": device_name(),
        }

    def _cache_config(self) -> dict:
        return {
            "model": "MegaLoc",
            "repo": REPO,
            "commit": COMMIT,
            "weights": f"hf://{HF_REPO}@{HF_REVISION}/model.safetensors",
            "weights_sha256": WEIGHTS_SHA256,
            "dim": 8448,
            "preprocessing": {
                "exif_transpose": True,
                "color": "RGB",
                "normalize": {"mean": MEAN, "std": STD},
                "resize": [self.image_size, self.image_size],
                "antialias": True,
            },
            "normalisation": "l2",
        }

    def cost_estimate(self, n_images: int = 0, usage: dict | None = None) -> dict:
        from placematch.ops.pricing import LOCAL

        return {"usd": 0.0, **LOCAL}

    def is_cold(self) -> bool:
        """True when the model is not loaded yet (the next embed pays the load time)."""
        return not is_loaded()

    def requests_for(self, n_images: int) -> int:
        return 0

    def release(self) -> None:
        """Free the model after embedding (e.g. before verification); vectors stay cached."""
        release()

    def _tensor(self, path: Path):
        import torchvision.transforms as tfm

        t = tfm.Compose(
            [
                tfm.ToTensor(),
                tfm.Normalize(mean=MEAN, std=STD),
                tfm.Resize(size=[self.image_size, self.image_size], antialias=True),
            ]
        )
        return t(load_upright(path))

    def embed_paths(
        self, paths: list[Path], *, budget: RequestBudget, stats: EmbedStats
    ) -> np.ndarray:
        t0 = time.perf_counter()

        def run(todo: list[Path], shas: list[str]) -> None:
            import torch

            model = load_model(self.telemetry)
            dev = next(model.parameters()).device
            for i in range(0, len(todo), self.batch_size):
                batch, keep = [], []
                chunk = zip(
                    todo[i : i + self.batch_size], shas[i : i + self.batch_size], strict=True
                )
                for p, s in chunk:
                    try:
                        batch.append(self._tensor(p))
                        keep.append(s)
                    except Exception as exc:  # unreadable/unsupported image: name the file
                        stats.failed.append(failure_message(p, exc))
                if not batch:
                    continue
                t = time.perf_counter()
                with torch.inference_mode():
                    out = model(torch.stack(batch).to(dev)).float().cpu().numpy()
                per_image = (time.perf_counter() - t) / len(keep)  # batch time, amortised
                for s, v in zip(keep, out, strict=True):
                    self.cache.put(s, v)
                    self.telemetry.record_embed(s, per_image)

        try:
            return embed_with_cache(
                [Path(p) for p in paths],
                cache=self.cache,
                requests_for=self.requests_for,
                embed_uncached=run,
                budget=budget,
                stats=stats,
                remote=False,
            )
        finally:
            stats.elapsed_s += time.perf_counter() - t0
