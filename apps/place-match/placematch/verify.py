"""Optional geometric verification: SuperPoint + LightGlue, then a robust two-view model.

Matches come from https://github.com/cvg/LightGlue (pinned in pyproject). Geometry is
general 3D: a fundamental matrix fitted with MAGSAC++ (``cv2.USAC_MAGSAC``) is the primary
model; a homography (also MAGSAC++) is only reported as a secondary check, never required.
``verified`` needs enough inliers, a high enough inlier ratio and inliers spread over both
images. Anything short of that is ``inconclusive`` (little overlap is not evidence of a
different place); failures are ``error``. Verification never reorders candidates.
"""

from __future__ import annotations

import time
from pathlib import Path

import cv2
import numpy as np

from placematch.env import DATA_DIR
from placematch.frames import load_upright_array
from placematch.schemas import Manifest, RunResult, VerificationResult, VerifyThresholds

MODEL_DIR = DATA_DIR / "models" / "lightglue"  # torch.hub cache for the official weights
MAX_KEYPOINTS = 2048
RESIZE = 1024  # SuperPoint input longest side (LightGlue default)
MIN_MATCHES = 15  # fewer correspondences => no model is fitted
F_THRESHOLD_FRAC = 1.0 / 1024  # MAGSAC threshold as a fraction of the longest image side
GRID = 8
MAX_OVERLAY_LINES = 300
#: Default evidence thresholds (heuristic; decide.calibrate keeps them unless tuned).
DEFAULT_THRESHOLDS = VerifyThresholds(min_inliers=40, min_inlier_ratio=0.3, min_coverage=0.12)

#: SuperPoint runs on MPS when available (0.26 s/image vs ~4.9 s on CPU); LightGlue runs on
#: the CPU (0.64 s/pair vs 1.2-1.4 s on MPS, measured on the 640x480 demo). Unpadded MPS
#: matching also compiled a new graph per keypoint count and grew driver memory ~0.4 GB/pair.
MATCH_DEVICE = "cpu"
#: If LightGlue is ever placed on MPS, pad keypoint sets to these lengths (masked) so MPS
#: reuses a few cached graphs instead of one per shape.
PAD_LENGTHS = [512, 1024, 1536, 2048]

_MODELS: dict = {}


def weights_present() -> bool:
    ckpt = MODEL_DIR / "checkpoints"
    return (ckpt / "superpoint_v1.pth").is_file() and (
        ckpt / "superpoint_lightglue_v0-1_arxiv.pth"
    ).is_file()


def default_device() -> str:
    import torch

    return "mps" if torch.backends.mps.is_available() else "cpu"


def _load(kind: str, dev: str):
    if (kind, dev) not in _MODELS:
        import torch
        from lightglue import LightGlue, SuperPoint

        old = torch.hub.get_dir()
        torch.hub.set_dir(str(MODEL_DIR))
        try:
            if kind == "extractor":
                model = SuperPoint(max_num_keypoints=MAX_KEYPOINTS)
            else:
                model = LightGlue(features="superpoint")
                if dev == "mps":
                    model.static_lengths = PAD_LENGTHS  # padding only; no torch.compile
        finally:
            torch.hub.set_dir(old)
        _MODELS[(kind, dev)] = model.eval().to(dev)
    return _MODELS[(kind, dev)]


def load_models(device: str | None = None):
    """(SuperPoint on ``device``, LightGlue on MATCH_DEVICE, device); each loaded once."""
    dev = device or default_device()
    return _load("extractor", dev), _load("matcher", MATCH_DEVICE), dev


def release() -> None:
    """Drop the verification models and return cached accelerator memory."""
    _MODELS.clear()
    empty_cache()


def empty_cache() -> None:
    import sys

    torch = sys.modules.get("torch")
    if torch is not None and torch.backends.mps.is_available():
        torch.mps.empty_cache()


def is_oom(exc: BaseException) -> bool:
    return isinstance(exc, RuntimeError) and "out of memory" in str(exc).lower()


def extract(path: Path, device: str | None = None) -> tuple[dict, np.ndarray]:
    """SuperPoint features (kept on the CPU so caches never hold accelerator memory)."""
    # Reject invalid inputs before loading optional heavyweight dependencies/weights.
    img = load_upright_array(path)
    import torch

    extractor, _, dev = load_models(device)
    t = torch.from_numpy(img.transpose(2, 0, 1).copy()).float().div(255.0)
    with torch.inference_mode():
        feats = extractor.extract(t.to(dev), resize=RESIZE)
        feats = {k: v.detach().cpu() for k, v in feats.items()}
    return feats, img


def match(f0: dict, f1: dict) -> tuple[np.ndarray, np.ndarray]:
    import torch
    from lightglue.utils import rbd

    matcher = _load("matcher", MATCH_DEVICE)
    with torch.inference_mode():
        out = matcher(
            {
                "image0": {k: v.to(MATCH_DEVICE) for k, v in f0.items()},
                "image1": {k: v.to(MATCH_DEVICE) for k, v in f1.items()},
            }
        )
        m = rbd(out)["matches"].cpu().numpy()
        del out
    k0 = rbd(f0)["keypoints"].numpy()
    k1 = rbd(f1)["keypoints"].numpy()
    return k0[m[:, 0]].astype(np.float64), k1[m[:, 1]].astype(np.float64)


def coverage(points: np.ndarray, shape: tuple[int, ...], grid: int = GRID) -> float:
    """Fraction of a grid x grid partition of the image containing at least one point."""
    if len(points) == 0:
        return 0.0
    h, w = shape[:2]
    cx = np.clip((points[:, 0] / w * grid).astype(int), 0, grid - 1)
    cy = np.clip((points[:, 1] / h * grid).astype(int), 0, grid - 1)
    return len(set(zip(cx.tolist(), cy.tolist(), strict=True))) / (grid * grid)


def passes(r: VerificationResult, th: VerifyThresholds) -> bool:
    return (
        r.n_inliers >= th.min_inliers
        and r.inlier_ratio >= th.min_inlier_ratio
        and min(r.coverage_query, r.coverage_reference) >= th.min_coverage
    )


def draw_overlay(img0, img1, p0, p1, inl, path: Path, max_h: int = 720) -> None:
    """Side-by-side image: inlier correspondences green, rejected matches thin red."""
    s0, s1 = max_h / img0.shape[0], max_h / img1.shape[0]
    a = cv2.resize(img0, (round(img0.shape[1] * s0), max_h))
    b = cv2.resize(img1, (round(img1.shape[1] * s1), max_h))
    canvas = cv2.cvtColor(np.concatenate([a, b], axis=1), cv2.COLOR_RGB2BGR)
    off = a.shape[1]
    step = max(1, len(p0) // MAX_OVERLAY_LINES)  # deterministic thinning for readability
    for (x0, y0), (x1, y1), ok in zip(p0[::step], p1[::step], inl[::step], strict=True):
        q0 = (int(x0 * s0), int(y0 * s0))
        q1 = (int(x1 * s1) + off, int(y1 * s1))
        cv2.line(canvas, q0, q1, (0, 200, 0) if ok else (0, 0, 220), 1, cv2.LINE_AA)
        if ok:
            cv2.circle(canvas, q0, 2, (0, 255, 0), -1)
            cv2.circle(canvas, q1, 2, (0, 255, 0), -1)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), canvas)


def _verify(f0, img0, f1, img1, overlay_path, thresholds) -> VerificationResult:
    t0 = time.perf_counter()
    p0, p1 = match(f0, f1)
    n0 = int(f0["keypoints"].shape[-2])
    n1 = int(f1["keypoints"].shape[-2])
    res = dict(n_keypoints_query=n0, n_keypoints_reference=n1, n_correspondences=len(p0))
    if len(p0) < MIN_MATCHES:
        if overlay_path is not None:
            draw_overlay(img0, img1, p0, p1, np.zeros(len(p0), bool), Path(overlay_path))
            res["overlay_path"] = str(overlay_path)
        return VerificationResult(
            status="inconclusive",
            message=f"only {len(p0)} correspondences (< {MIN_MATCHES}); no model fitted",
            elapsed_s=time.perf_counter() - t0,
            **res,
        )
    thr = F_THRESHOLD_FRAC * max(*img0.shape[:2], *img1.shape[:2])
    F, mask = cv2.findFundamentalMat(p0, p1, cv2.USAC_MAGSAC, thr, 0.9999, 10000)
    ok = F is not None and mask is not None
    inl = mask.ravel().astype(bool) if ok else np.zeros(len(p0), bool)
    H, hmask = cv2.findHomography(p0, p1, cv2.USAC_MAGSAC, 4 * thr, maxIters=10000)
    n_h = int(hmask.sum()) if H is not None and hmask is not None else 0
    r = VerificationResult(
        status="inconclusive",
        geometry_model="fundamental",
        n_inliers=int(inl.sum()),
        inlier_ratio=float(inl.mean()) if len(inl) else 0.0,
        coverage_query=coverage(p0[inl], img0.shape),
        coverage_reference=coverage(p1[inl], img1.shape),
        **res,
    )
    if passes(r, thresholds):
        r.status = "verified"
    r.message = (
        f"F-MAGSAC thr={thr:.2f}px; homography inliers {n_h}/{len(p0)} (secondary check); "
        f"thresholds inliers>={thresholds.min_inliers}, ratio>={thresholds.min_inlier_ratio}, "
        f"coverage>={thresholds.min_coverage}"
    )
    if overlay_path is not None:
        draw_overlay(img0, img1, p0, p1, inl, Path(overlay_path))
        r.overlay_path = str(overlay_path)
    r.elapsed_s = time.perf_counter() - t0
    return r


def verify_pair(
    query: Path,
    reference: Path,
    *,
    overlay_path: Path | None = None,
    thresholds: VerifyThresholds | None = None,
    _features: dict | None = None,
) -> VerificationResult:
    """Match one query/reference pair; never raises.

    An accelerator out-of-memory error empties the cache and retries the pair once on the
    CPU. Any remaining failure is ``status="error"`` (never evidence either way).
    """
    t0 = time.perf_counter()
    cache = _features if _features is not None else {}
    th = thresholds or DEFAULT_THRESHOLDS
    note = ""
    for device in (None, "cpu"):
        try:
            for p in (query, reference):
                if str(p) not in cache:
                    cache[str(p)] = extract(Path(p), device)
            (f0, img0), (f1, img1) = cache[str(query)], cache[str(reference)]
            r = _verify(f0, img0, f1, img1, overlay_path, th)
            r.elapsed_s = time.perf_counter() - t0
            if note:
                r.message = f"{note}; {r.message}"
            return r
        except Exception as exc:
            err = f"{type(exc).__name__}: {exc}"[:400]
            if device is None and is_oom(exc) and default_device() != "cpu":
                empty_cache()
                note = "retried on CPU after accelerator out-of-memory"
                continue
            return VerificationResult(
                status="error",
                message=(f"{note}; " if note else "") + err,
                elapsed_s=time.perf_counter() - t0,
            )
        finally:
            if device is None:
                empty_cache()
    raise AssertionError("unreachable")


def verify_run(
    run: RunResult,
    manifest: Manifest,
    manifest_path: Path,
    *,
    top_n: int = 3,
    overlay_dir: Path | None = None,
    thresholds: VerifyThresholds | None = None,
) -> RunResult:
    """Fill ``candidate.verification`` for the top ``top_n`` candidates of every query."""
    t0 = time.perf_counter()
    run = run.model_copy(deep=True)
    paths = {e.image_id: manifest.resolve(e, Path(manifest_path)) for e in manifest.entries}
    feats: dict = {}  # per-run feature cache: each image is extracted once
    cold = not _MODELS
    pair_s: list[float] = []
    for q in run.queries:
        qpath = paths.get(q.query_id, Path(q.path))
        for c in q.candidates[:top_n]:
            overlay = None
            if overlay_dir is not None:
                safe = f"{q.query_id}__{c.reference_id}".replace("/", "_").replace(":", "_")
                overlay = Path(overlay_dir) / f"{safe}.png"
            c.verification = verify_pair(
                qpath, paths[c.reference_id], overlay_path=overlay, thresholds=thresholds,
                _features=feats,
            )  # fmt: skip
            pair_s.append(c.verification.elapsed_s)
        v = sum(c.verification.elapsed_s for c in q.candidates[:top_n] if c.verification)
        q.timings_s["verify"] = round(v, 5)
        q.timings_s["total"] = round(sum(x for k, x in q.timings_s.items() if k != "total"), 5)
        if len(feats) > 512:  # CPU features + images; bound memory on very long runs
            feats.clear()
    th = thresholds or DEFAULT_THRESHOLDS
    run.settings["verify"] = {
        "method": "superpoint+lightglue, fundamental USAC_MAGSAC (homography secondary)",
        "top_n": top_n,
        "max_keypoints": MAX_KEYPOINTS,
        "resize": RESIZE,
        "extract_device": default_device(),
        "match_device": MATCH_DEVICE,
        "grid": GRID,
        "thresholds": th.model_dump(),
    }
    run.stats.timings_s["verify"] = round(time.perf_counter() - t0, 4)
    from placematch.ops.telemetry import peak_rss_mb, percentiles

    run.stats.latency_s["verify_per_pair"] = percentiles(pair_s)
    run.stats.latency_s["verify_cold_start"] = cold
    run.stats.peak_rss_mb = max(run.stats.peak_rss_mb or 0.0, peak_rss_mb())
    return run
