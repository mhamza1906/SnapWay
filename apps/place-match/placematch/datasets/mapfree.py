"""Niantic Map-free Relocalization dataset: subset download (train scenes only).

Source: https://github.com/nianticlabs/map-free-reloc and
https://nianticspatial.com/research/map-free/dataset (``train.zip``, 118.6 GB on Google
Cloud Storage, read with HTTP range requests: only the selected members are fetched).
Licence: "Niantic Map-free Relocalization Dataset License Agreement" (non-commercial),
displayed on the dataset page; downloading means accepting it. The user accepted these
terms explicitly in chat on 2026-10-17 (relayed by the head agent); see DATASETS.md.

Only **training** scenes are used because only they ship ``overlaps.npz`` (dataset-native
SfM co-visibility scores between every pair of frames of the two scans). Validation scenes
have poses but no overlaps, and test scenes have no poses at all (their pose lines are
zeros) - test data is never used.

Train scene layout: ``train/sXXXXX/{seq0,seq1}/frame_XXXXX.jpg`` (540x720), ``poses.txt``
(``frame qw qx qy qz tx ty tz``, world-to-camera, metric), ``intrinsics.txt``
(``frame fx fy cx cy w h``), ``overlaps.npz`` (``idxs`` = (seq_a, frame_a, seq_b, frame_b),
``overlaps`` in [0, 1]; pairs not stored have zero overlap). seq0 and seq1 are two
separate scans of the same place.

Everything read here is untrusted data: ``np.load(..., allow_pickle=False)``, text parsed
by hand, images only written to disk.

CLI::

    uv run python -m placematch.datasets.mapfree fetch [--n-scenes 160]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import time
import zipfile
from pathlib import Path

import numpy as np

from placematch.datasets.colmap_io import qvec_to_rotmat
from placematch.datasets.remote_zip import HttpRangeFile, read_member_direct, write_atomic
from placematch.env import DATA_DIR

TRAIN_URL = (
    "https://storage.googleapis.com/niantic-lon-static/research/map-free-reloc/dataset/train.zip"
)
PROJECT_URL = "https://nianticspatial.com/research/map-free/dataset"
REPO_URL = "https://github.com/nianticlabs/map-free-reloc"
LICENSE = (
    "Niantic Map-free Relocalization Dataset License Agreement (non-commercial), displayed "
    "on https://nianticspatial.com/research/map-free/dataset; accepted by the user in chat "
    "on 2026-10-17"
)
CITATION = (
    "E. Arnold et al. Map-free Visual Relocalization: Metric Pose Relative to a Single Image. "
    "ECCV 2022."
)
RAW_DIR = DATA_DIR / "raw" / "mapfree"
SEED = "placematch-v2"
#: The Map-free training code samples pairs with overlap in [0.2, 0.7]
#: (config/mapfree.yaml MIN_OVERLAP_SCORE=0.2); 0.2 is used as the positive boundary.
POSITIVE_OVERLAP = 0.2
AMBIGUOUS_OVERLAP = 0.05


def parse_poses(text: str) -> dict[str, np.ndarray]:
    """``frame qw qx qy qz tx ty tz`` -> 4x4 world-to-camera."""
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 8:
            continue
        q = np.array([float(x) for x in parts[1:5]])
        t = np.array([float(x) for x in parts[5:8]])
        if not (np.all(np.isfinite(q)) and np.all(np.isfinite(t))) or np.linalg.norm(q) < 0.5:
            continue
        m = np.eye(4)
        m[:3, :3] = qvec_to_rotmat(q / np.linalg.norm(q))
        m[:3, 3] = t
        out[parts[0]] = m
    return out


def parse_intrinsics(text: str) -> dict[str, list[float]]:
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 7:
            out[parts[0]] = [float(x) for x in parts[1:]]
    return out


def frame_number(name: str) -> int:
    return int(name.rsplit("frame_", 1)[1].split(".")[0])


def camera_centre(w2c: np.ndarray) -> np.ndarray:
    return -w2c[:3, :3].T @ w2c[:3, 3]


def rotation_deg(a: np.ndarray, b: np.ndarray) -> float:
    r = a[:3, :3] @ b[:3, :3].T
    return float(np.degrees(np.arccos(np.clip((np.trace(r) - 1) / 2, -1.0, 1.0))))


def spaced_selection(
    names: list[str],
    poses: dict[str, np.ndarray],
    k: int,
    *,
    min_trans: float,
    min_rot: float,
    oversample: int = 4,
) -> list[str]:
    """Up to ``k`` frames evenly spread over the sequence, each at least ``min_trans`` m
    or ``min_rot`` degrees from every frame already chosen (no near-duplicates)."""
    names = sorted(names, key=frame_number)
    if not names:
        return []
    n = k * oversample
    grid = [names[int(len(names) * (i + 0.5) / n)] for i in range(n)]
    # visit grid points in a coarse-to-fine order so the k picks spread over the sequence
    order = [grid[(i * oversample + oversample // 2) % n] for i in range(k)] + grid
    chosen: list[str] = []
    for nm in order:
        if len(chosen) >= k:
            break
        if nm in chosen:
            continue
        ok = all(
            np.linalg.norm(camera_centre(poses[nm]) - camera_centre(poses[c])) >= min_trans
            or rotation_deg(poses[nm], poses[c]) >= min_rot
            for c in chosen
        )
        if ok:
            chosen.append(nm)
    return sorted(chosen, key=frame_number)


def scene_order(scene_ids: list[str], seed: str = SEED) -> list[str]:
    return sorted(scene_ids, key=lambda s: hashlib.sha256(f"{seed}:{s}".encode()).hexdigest())


def _open(url: str = TRAIN_URL) -> tuple[HttpRangeFile, zipfile.ZipFile]:
    raw = HttpRangeFile(url, block_size=1 << 20)
    return raw, zipfile.ZipFile(io.BufferedReader(raw, 1 << 20))


def _fetch_scene(
    sc: str,
    infos: dict[str, zipfile.ZipInfo],
    frames: dict[str, list[str]],
    *,
    url: str,
    root: Path,
    n_refs: int,
    n_queries: int,
) -> int:
    """Fetch one scene with its own range-file handle; returns bytes downloaded."""
    out = root / "train" / sc
    raw = HttpRangeFile(url, block_size=1 << 16)
    try:

        def read(rel: str) -> bytes:
            return read_member_direct(raw, infos[f"train/{sc}/{rel}"])

        poses = parse_poses(read("poses.txt").decode())
        intr = parse_intrinsics(read("intrinsics.txt").decode())
        ov = np.load(io.BytesIO(read("overlaps.npz")), allow_pickle=False)
        idxs, scores = ov["idxs"].astype(np.int64), ov["overlaps"].astype(np.float64)
        s0 = [f for f in frames.get("seq0", []) if f in poses]
        s1 = [f for f in frames.get("seq1", []) if f in poses]
        refs = spaced_selection(s0, poses, n_refs, min_trans=0.5, min_rot=15.0)
        queries = spaced_selection(s1, poses, n_queries, min_trans=0.5, min_rot=15.0)
        # overlaps between selected queries (seq1) and all seq0 frames (either order stored)
        qnums = {frame_number(q): q for q in queries}
        q_of = np.full(len(scores), -1)
        r_of = np.full(len(scores), -1)
        a_q = (idxs[:, 0] == 1) & (idxs[:, 2] == 0) & np.isin(idxs[:, 1], list(qnums))
        b_q = (idxs[:, 2] == 1) & (idxs[:, 0] == 0) & np.isin(idxs[:, 3], list(qnums))
        q_of[a_q], r_of[a_q] = idxs[a_q, 1], idxs[a_q, 3]
        q_of[b_q], r_of[b_q] = idxs[b_q, 3], idxs[b_q, 1]
        sel = a_q | b_q
        q_scores: dict[str, dict[str, float]] = {q: {} for q in queries}
        for qn, rn, s in zip(
            q_of[sel].tolist(), r_of[sel].tolist(), scores[sel].tolist(), strict=True
        ):
            key = f"seq0/frame_{rn:05d}.jpg"
            prev = q_scores[qnums[qn]].get(key, 0.0)
            q_scores[qnums[qn]][key] = max(prev, round(float(s), 4))
        for f in refs + queries:
            dest = out / f
            if not dest.is_file():
                write_atomic(dest, read(f))
        meta = {
            "scene": sc,
            "n_frames": {"seq0": len(s0), "seq1": len(s1)},
            "references": refs,
            "queries": queries,
            "poses_w2c": {f: poses[f].tolist() for f in refs + queries},
            "intrinsics_fx_fy_cx_cy_w_h": {f: intr.get(f) for f in refs + queries},
            "query_overlaps_vs_seq0": q_scores,
            "overlap_pairs_in_file": int(len(scores)),
            "selection": {
                "n_refs": n_refs,
                "n_queries": n_queries,
                "min_trans_m": 0.5,
                "min_rot_deg": 15.0,
            },
            "bytes_downloaded": raw.bytes_fetched,
        }
        (out / "meta.json").write_text(json.dumps(meta, indent=1))
        return raw.bytes_fetched
    finally:
        raw.close()


def fetch(
    *,
    n_scenes: int = 160,
    n_refs: int = 6,
    n_queries: int = 6,
    root: Path = RAW_DIR,
    url: str = TRAIN_URL,
    workers: int = 6,
) -> dict:
    """Fetch metadata + selected frames of ``n_scenes`` train scenes (deterministic order).

    Per scene: ``n_refs`` reference frames from seq0 and ``n_queries`` query frames from
    seq1, evenly spread and pose-spaced (>= 0.5 m or >= 15 deg apart). The overlap scores
    between every selected query and *every* seq0 frame are kept (for labels and for the
    "is any seq0 view co-visible" diagnostic) in ``train/<scene>/meta.json``.
    """
    from concurrent.futures import ThreadPoolExecutor

    t0 = time.time()
    raw, z = _open(url)
    infos = {i.filename: i for i in z.infolist()}
    names = list(infos)
    scenes = sorted({n.split("/")[1] for n in names if n.startswith("train/s")})
    chosen = scene_order(scenes)[:n_scenes]
    frames_by_scene: dict[str, dict[str, list[str]]] = {}
    for n in names:
        if n.endswith(".jpg") and n.startswith("train/"):
            _, sc, seq, _f = n.split("/")
            frames_by_scene.setdefault(sc, {}).setdefault(seq, []).append(f"{seq}/{_f}")
    log = {"url": url, "archive_bytes": raw.size, "scenes": {}, "n_scenes_in_archive": len(scenes)}
    log["central_directory_bytes"] = raw.bytes_fetched
    todo = [sc for sc in chosen if not (root / "train" / sc / "meta.json").is_file()]
    for sc in chosen:
        if sc not in todo:
            log["scenes"][sc] = "cached"
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {
            sc: pool.submit(
                _fetch_scene,
                sc,
                infos,
                frames_by_scene.get(sc, {}),
                url=url,
                root=root,
                n_refs=n_refs,
                n_queries=n_queries,
            )
            for sc in todo
        }
        for i, (sc, fut) in enumerate(futs.items()):
            log["scenes"][sc] = fut.result()
            print(f"[{i + 1}/{len(todo)}] {sc}: {log['scenes'][sc] / 1e6:.1f} MB", flush=True)
    log["total_bytes_downloaded_this_call"] = raw.bytes_fetched + sum(
        v for v in log["scenes"].values() if isinstance(v, int)
    )
    log["elapsed_s"] = round(time.time() - t0, 1)
    log["chosen_scenes"] = chosen
    (root / "fetch_log.json").write_text(json.dumps(log, indent=1))
    raw.close()
    return log


def load_scene(scene: str, root: Path = RAW_DIR) -> dict:
    return json.loads((root / "train" / scene / "meta.json").read_text())


def chosen_scenes(root: Path = RAW_DIR) -> list[str]:
    return json.loads((root / "fetch_log.json").read_text())["chosen_scenes"]


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m placematch.datasets.mapfree")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch", help="metadata + selected frames of train scenes")
    f.add_argument("--n-scenes", type=int, default=160)
    f.add_argument("--n-refs", type=int, default=6)
    f.add_argument("--n-queries", type=int, default=6)
    args = ap.parse_args(argv)
    log = fetch(n_scenes=args.n_scenes, n_refs=args.n_refs, n_queries=args.n_queries)
    print(f"downloaded {log['total_bytes_downloaded_this_call'] / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
