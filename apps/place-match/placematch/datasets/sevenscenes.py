"""Microsoft RGB-D Dataset 7-Scenes: reproducible subset download and frame loading.

Source: https://www.microsoft.com/en-us/research/project/rgb-d-dataset-7-scenes/
Licence: Microsoft Research License Agreement, non-commercial use only
(https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/7-scenes-msr-la-dataset-7-scenes.rtf).

Each scene zip holds deflated ``seq-XX.zip`` archives (500 or 1000 frames each) plus the
original ``TrainSplit.txt`` / ``TestSplit.txt``. Only the selected sequences are streamed
(one range request per sequence) and only every ``keep_every``-th frame is written to disk.

Frame files: ``frame-XXXXXX.color.png`` (640x480 RGB), ``.depth.png`` (16-bit mm, 65535
= invalid), ``.pose.txt`` (4x4 camera-to-world, metres, the scene's world frame as
estimated by KinectFusion). RGB and depth cameras are not calibrated or registered; the
default depth intrinsics are fx=fy=585, cx=320, cy=240. No per-frame timestamps exist.

CLI::

    uv run python -m placematch.datasets.sevenscenes download [--scenes ...] [--keep-every 5]
"""

from __future__ import annotations

import argparse
import io
import json
import re
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np

from placematch.datasets.remote_zip import HttpRangeFile, iter_stream_zip, stream_member
from placematch.env import DATA_DIR

BASE_URL = "https://download.microsoft.com/download/2/8/5/28564B23-0828-408F-8631-23B1EFF1DAC8"
PROJECT_URL = "https://www.microsoft.com/en-us/research/project/rgb-d-dataset-7-scenes/"
LICENSE = (
    "Microsoft Research License Agreement (MSR-LA), Non-Commercial Use Only: "
    "https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/"
    "7-scenes-msr-la-dataset-7-scenes.rtf"
)
CITATION = (
    "J. Shotton, B. Glocker, C. Zach, S. Izadi, A. Criminisi, A. Fitzgibbon. Scene Coordinate "
    "Regression Forests for Camera Relocalization in RGB-D Images. CVPR 2013."
)
RAW_DIR = DATA_DIR / "raw" / "7scenes"

# Default depth intrinsics published on the project page (KinectFusion defaults).
DEPTH_FX = DEPTH_FY = 585.0
DEPTH_CX, DEPTH_CY = 320.0, 240.0
WIDTH, HEIGHT = 640, 480
DEPTH_INVALID = 65535

#: Sequences streamed by default. Reference sequences come from the original TrainSplit,
#: query sequences from the original TestSplit (different recordings). ``office`` is
#: downloaded for queries only: it is held out of the reference pool entirely.
DEFAULT_SUBSET: dict[str, dict[str, list[int]]] = {
    "chess": {"train": [1], "test": [3, 5]},
    "fire": {"train": [1], "test": [3, 4]},
    "heads": {"train": [2], "test": [1]},
    "stairs": {"train": [2, 3], "test": [1, 4]},
    "office": {"train": [], "test": [2, 6]},
}

#: placematch-v2 subset (superset of DEFAULT_SUBSET). New query recordings come from
#: sequences never used as bench-v1 queries; a TrainSplit sequence used as a query keeps
#: ``original_split="train"`` in the manifest. See DATASETS.md for the role of each sequence.
V2_SUBSET: dict[str, dict[str, list[int]]] = {
    "chess": {"train": [1, 2, 4], "test": [3, 5]},
    "fire": {"train": [1, 2], "test": [3, 4]},
    "heads": {"train": [2], "test": [1]},
    "stairs": {"train": [2, 3, 5, 6], "test": [1, 4]},
    "office": {"train": [], "test": [2, 6, 7, 9]},
    "pumpkin": {"train": [2], "test": [1, 7]},
    "redkitchen": {"train": [1], "test": [3, 4]},
}
SUBSETS = {"v1": DEFAULT_SUBSET, "v2": V2_SUBSET}

_FRAME_RE = re.compile(r"frame-(\d{6})\.(color\.png|depth\.png|pose\.txt)$")


def scene_url(scene: str) -> str:
    return f"{BASE_URL}/{scene}.zip"


def _parse_split(text: bytes) -> list[int]:
    return [int(m) for m in re.findall(rb"sequence(\d+)", text)]


def download_scene(
    scene: str,
    train: list[int],
    test: list[int],
    *,
    root: Path = RAW_DIR,
    keep_every: int = 5,
) -> dict:
    """Stream the chosen sequences of one scene; keep frames with index % keep_every == 0."""
    out_scene = root / scene
    out_scene.mkdir(parents=True, exist_ok=True)
    raw = HttpRangeFile(scene_url(scene), timeout=180.0)
    outer = zipfile.ZipFile(io.BufferedReader(raw, 1 << 20))
    splits = {
        "train": _parse_split(outer.read(f"{scene}/TrainSplit.txt")),
        "test": _parse_split(outer.read(f"{scene}/TestSplit.txt")),
    }
    for name in ("TrainSplit.txt", "TestSplit.txt"):
        (out_scene / name).write_bytes(outer.read(f"{scene}/{name}"))
    for seq in train:
        if seq not in splits["train"]:
            raise ValueError(f"{scene} seq-{seq:02d} is not in the original TrainSplit")
    for seq in test:
        if seq not in splits["test"]:
            raise ValueError(f"{scene} seq-{seq:02d} is not in the original TestSplit")

    log = {
        "scene": scene,
        "url": scene_url(scene),
        "archive_bytes": raw.size,
        "splits": splits,
        "sequences": {},
    }
    for seq in sorted(set(train) | set(test)):
        seq_name = f"seq-{seq:02d}"
        seq_dir = out_scene / seq_name
        done_marker = seq_dir / ".complete.json"
        if done_marker.is_file():
            log["sequences"][seq_name] = json.loads(done_marker.read_text())
            continue
        info = outer.getinfo(f"{scene}/{seq_name}.zip")
        seq_dir.mkdir(parents=True, exist_ok=True)
        before = raw.bytes_fetched
        t0 = time.time()
        n_total, kept, bad_crc = set(), set(), []

        def want(name: str, n_total: set = n_total) -> bool:
            m = _FRAME_RE.search(name)
            if not m:
                return False
            idx = int(m.group(1))
            n_total.add(idx)
            return idx % keep_every == 0

        attempts = 0
        while True:  # a dropped stream restarts the sequence (deflate cannot resume)
            attempts += 1
            try:
                for name, data, crc_ok in iter_stream_zip(stream_member(raw, info), want):
                    if not crc_ok:
                        bad_crc.append(name)
                        continue
                    (seq_dir / Path(name).name).write_bytes(data)
                    kept.add(int(_FRAME_RE.search(name).group(1)))
                break
            except (httpx.TransportError, httpx.HTTPStatusError, zipfile.BadZipFile):
                if attempts >= 4:
                    raise
                n_total.clear()
                kept.clear()
                bad_crc.clear()
                time.sleep(5 * attempts)
        rec = {
            "member": info.filename,
            "member_compressed_bytes": info.compress_size,
            "bytes_downloaded": raw.bytes_fetched - before,
            "frames_in_sequence": len(n_total),
            "frames_kept": len(kept),
            "keep_every": keep_every,
            "crc_failures": bad_crc,
            "split": "train" if seq in splits["train"] else "test",
            "elapsed_s": round(time.time() - t0, 1),
            "stream_attempts": attempts,
        }
        if bad_crc:
            raise OSError(f"{scene}/{seq_name}: CRC mismatch for {len(bad_crc)} members")
        done_marker.write_text(json.dumps(rec, indent=2))
        log["sequences"][seq_name] = rec
    log["total_bytes_downloaded_this_call"] = raw.bytes_fetched
    (out_scene / "download_log.json").write_text(json.dumps(log, indent=2))
    raw.close()
    return log


def download(
    subset: dict[str, dict[str, list[int]]] | None = None,
    *,
    root: Path = RAW_DIR,
    keep_every: int = 5,
    workers: int = 3,
) -> list[dict]:
    subset = subset or DEFAULT_SUBSET
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [
            pool.submit(download_scene, s, v["train"], v["test"], root=root, keep_every=keep_every)
            for s, v in subset.items()
        ]
        return [f.result() for f in futs]


# --------------------------------------------------------------------------- loading


@dataclass(frozen=True)
class Frame:
    scene: str
    seq: int
    index: int
    color: Path
    depth: Path
    pose_path: Path

    @property
    def frame_id(self) -> str:
        return f"seq-{self.seq:02d}/frame-{self.index:06d}"

    def pose(self) -> np.ndarray:
        return load_pose(self.pose_path)


def load_pose(path: Path) -> np.ndarray:
    m = np.loadtxt(path, dtype=np.float64)
    if m.shape != (4, 4) or not np.all(np.isfinite(m)):
        raise ValueError(f"bad pose in {path}")
    return m


def load_depth_m(path: Path) -> np.ndarray:
    """Depth in metres, NaN where invalid (0 or 65535)."""
    import cv2

    d = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if d is None or d.dtype != np.uint16:
        raise ValueError(f"unexpected depth image {path}")
    out = d.astype(np.float32) / 1000.0
    out[(d == 0) | (d == DEPTH_INVALID)] = np.nan
    return out


def list_frames(scene: str, seq: int, root: Path = RAW_DIR) -> list[Frame]:
    seq_dir = root / scene / f"seq-{seq:02d}"
    frames = []
    for color in sorted(seq_dir.glob("frame-*.color.png")):
        idx = int(color.name[6:12])
        depth = seq_dir / f"frame-{idx:06d}.depth.png"
        pose = seq_dir / f"frame-{idx:06d}.pose.txt"
        if depth.is_file() and pose.is_file():
            frames.append(Frame(scene, seq, idx, color, depth, pose))
    return frames


def read_splits(scene: str, root: Path = RAW_DIR) -> dict[str, list[int]]:
    d = root / scene
    return {
        "train": _parse_split((d / "TrainSplit.txt").read_bytes()),
        "test": _parse_split((d / "TestSplit.txt").read_bytes()),
    }


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m placematch.datasets.sevenscenes")
    sub = ap.add_subparsers(dest="cmd", required=True)
    dl = sub.add_parser("download", help="stream the default subset (or --scenes) to data/raw")
    dl.add_argument("--scenes", nargs="*", default=None, help="subset of the subset's keys")
    dl.add_argument("--subset", choices=sorted(SUBSETS), default="v1")
    dl.add_argument("--keep-every", type=int, default=5)
    dl.add_argument("--workers", type=int, default=3)
    dl.add_argument("--root", type=Path, default=RAW_DIR)
    args = ap.parse_args(argv)
    chosen = SUBSETS[args.subset]
    subset = {k: v for k, v in chosen.items() if args.scenes is None or k in args.scenes}
    logs = download(subset, root=args.root, keep_every=args.keep_every, workers=args.workers)
    for log in logs:
        got = sum(s["bytes_downloaded"] for s in log["sequences"].values())
        print(f"{log['scene']}: {len(log['sequences'])} sequences, {got / 1e6:.0f} MB streamed")


if __name__ == "__main__":
    main()
