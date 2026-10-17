"""Stanford 12-Scenes (RGB-D relocalisation): subset download with HTTP range requests.

Source: http://graphics.stanford.edu/projects/reloc/ (zips ``data/{apt1,apt2,office1,
office2}.zip``, 1.4 / 2.8 / 5.9 / 1.7 GB). Licence: Creative Commons
Attribution-NonCommercial-ShareAlike 4.0 (stated on the project page; no form or
click-through). Cite Valentin et al., 3DV 2016.

Each room folder holds ``data/frame-XXXXXX.{color.jpg,depth.png,pose.txt}``, ``info.txt``
(colour 1296x968 with default intrinsics, depth 640x480 at fx=fy=572, identity extrinsics:
the depth map is aligned to the colour image) and ``split.txt`` listing the scans
(``sequenceN [frames=..] [start=a ; end=b]``). The original protocol uses ``sequence0``
as the test scan and the remaining scans for training. Poses are camera-to-world in the
room's bundle-adjusted frame; some frames have invalid (non-finite) poses and are skipped.
Rooms are separate reconstructions, so poses of different rooms are never compared.

The zip members are individually deflated, so single frames are fetched without
downloading the archive. Nothing is executed; text is parsed by hand.

CLI::

    uv run python -m placematch.datasets.twelvescenes fetch
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

import numpy as np

from placematch.datasets.remote_zip import HttpRangeFile, extract_member
from placematch.env import DATA_DIR

BASE_URL = "http://graphics.stanford.edu/projects/reloc/data"
PROJECT_URL = "http://graphics.stanford.edu/projects/reloc/"
LICENSE = "CC BY-NC-SA 4.0 (stated on http://graphics.stanford.edu/projects/reloc/)"
CITATION = (
    "J. Valentin, A. Dai, M. Niessner, P. Kohli, P. Torr, S. Izadi, C. Keskin. Learning to "
    "Navigate the Energy Landscape. 3DV 2016."
)
RAW_DIR = DATA_DIR / "raw" / "12scenes"
SITES: dict[str, list[str]] = {
    "apt1": ["kitchen", "living"],
    "apt2": ["bed", "kitchen", "living", "luke"],
    "office1": ["gates362", "gates381", "lounge", "manolis"],
    "office2": ["5a", "5b"],
}
DEPTH_FX = DEPTH_FY = 572.0
DEPTH_CX, DEPTH_CY = 320.0, 240.0
DEPTH_W, DEPTH_H = 640, 480
POSE_STRIDE = 5  # poses read for every 5th frame, then frames are chosen by pose spacing
REFS_PER_ROOM = 30
QUERIES_PER_SCAN = 40
REF_SPACING = (0.35, 20.0)  # metres, degrees: a new reference must differ by either
QUERY_SPACING = (0.25, 15.0)

_SPLIT_RE = re.compile(r"sequence(\d+)\s*\[frames=(\d+)\]\s*\[start=(\d+)\s*;\s*end=(\d+)\]")


def site_url(site: str) -> str:
    return f"{BASE_URL}/{site}.zip"


def parse_split(text: str) -> dict[int, tuple[int, int]]:
    """``{sequence: (start_frame, end_frame)}`` (inclusive)."""
    return {int(m[0]): (int(m[2]), int(m[3])) for m in _SPLIT_RE.findall(text)}


def parse_info(text: str) -> dict[str, str]:
    out = {}
    for line in text.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def parse_pose(text: str) -> np.ndarray | None:
    try:
        m = np.array([[float(x) for x in row.split()] for row in text.strip().splitlines()])
    except ValueError:
        return None
    if m.shape != (4, 4) or not np.all(np.isfinite(m)):
        return None
    if abs(np.linalg.det(m[:3, :3]) - 1.0) > 0.05:
        return None
    return m


def _open(site: str, block: int = 1 << 17) -> tuple[HttpRangeFile, zipfile.ZipFile]:
    raw = HttpRangeFile(site_url(site), block_size=block)
    return raw, zipfile.ZipFile(io.BufferedReader(raw, block))


def _rot_deg(a: np.ndarray, b: np.ndarray) -> float:
    r = a[:3, :3].T @ b[:3, :3]
    return float(np.degrees(np.arccos(np.clip((np.trace(r) - 1) / 2, -1.0, 1.0))))


def spaced(poses: dict[int, np.ndarray], k: int, spacing: tuple[float, float]) -> list[int]:
    """Up to ``k`` frames spread over the scan; each differs from all chosen ones by at
    least ``spacing`` (metres or degrees)."""
    idx = sorted(poses)
    if not idx:
        return []
    n = 4 * k
    grid = [idx[int(len(idx) * (i + 0.5) / n)] for i in range(n)]
    order = [grid[(4 * i + 2) % n] for i in range(k)] + grid
    chosen: list[int] = []
    for f in order:
        if len(chosen) >= k:
            break
        if f in chosen:
            continue
        if all(
            np.linalg.norm(poses[f][:3, 3] - poses[c][:3, 3]) >= spacing[0]
            or _rot_deg(poses[f], poses[c]) >= spacing[1]
            for c in chosen
        ):
            chosen.append(f)
    return sorted(chosen)


def _read_poses(site: str, infos: list[zipfile.ZipInfo], workers: int = 8) -> dict[str, str]:
    """Read many tiny pose members in parallel (one small range request each)."""
    import zlib

    from placematch.datasets.remote_zip import member_data_offset

    chunks = [infos[i::workers] for i in range(workers)]

    def work(part: list[zipfile.ZipInfo]) -> dict[str, str]:
        raw = HttpRangeFile(site_url(site), block_size=1 << 12)
        try:
            res = {}
            for info in part:
                data = raw.read_range(member_data_offset(raw, info), info.compress_size)
                if info.compress_type == zipfile.ZIP_DEFLATED:
                    data = zlib.decompress(data, -15)
                if (zlib.crc32(data) & 0xFFFFFFFF) != info.CRC:
                    raise OSError(f"CRC mismatch for {info.filename}")
                res[info.filename] = data.decode("ascii", "replace")
            return res
        finally:
            raw.close()

    out: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for part in pool.map(work, chunks):
            out.update(part)
    return out


def fetch_site(site: str, *, root: Path = RAW_DIR) -> dict:
    t0 = time.time()
    out_site = root / site
    done = out_site / "selection.json"
    if done.is_file():
        return json.loads(done.read_text())
    raw, z = _open(site)
    names = [i.filename for i in z.infolist()]
    sel: dict = {"site": site, "url": site_url(site), "archive_bytes": raw.size, "rooms": {}}
    pose_bytes = 0
    for room in SITES[site]:
        base = f"{site}/{room}"
        split_txt = z.read(f"{base}/split.txt").decode()
        info_txt = z.read(f"{base}/info.txt").decode()
        (out_site / room).mkdir(parents=True, exist_ok=True)
        (out_site / room / "split.txt").write_text(split_txt)
        (out_site / room / "info.txt").write_text(info_txt)
        scans = parse_split(split_txt)
        frames = sorted(
            int(n.rsplit("frame-", 1)[1][:6])
            for n in names
            if n.startswith(f"{base}/data/frame-") and n.endswith(".pose.txt")
        )
        cand = [f for f in frames if f % POSE_STRIDE == 0]
        texts = _read_poses(site, [z.getinfo(f"{base}/data/frame-{f:06d}.pose.txt") for f in cand])
        pose_bytes += sum(len(t) for t in texts.values())
        poses = {}
        for f in cand:
            p = parse_pose(texts[f"{base}/data/frame-{f:06d}.pose.txt"])
            if p is not None:
                poses[f] = p
        room_sel: dict = {"scans": {str(k): list(v) for k, v in scans.items()}, "frames": {}}
        for seq, (a, b) in sorted(scans.items()):
            ps = {f: p for f, p in poses.items() if a <= f <= b}
            if seq == 1:
                chosen, role = spaced(ps, REFS_PER_ROOM, REF_SPACING), "reference"
            else:
                chosen, role = spaced(ps, QUERIES_PER_SCAN, QUERY_SPACING), "query"
            for f in chosen:
                room_sel["frames"][str(f)] = {
                    "scan": seq,
                    "role": role,
                    "original_split": "test" if seq == 0 else "train",
                    "pose_c2w": poses[f].tolist(),
                }
        room_sel["n_frames"] = len(frames)
        room_sel["n_valid_poses_read"] = len(poses)
        sel["rooms"][room] = room_sel
        for f in sorted(int(k) for k in room_sel["frames"]):
            for ext in ("color.jpg", "depth.png", "pose.txt"):
                m = f"{base}/data/frame-{f:06d}.{ext}"
                extract_member(z, m, out_site / room / "data" / f"frame-{f:06d}.{ext}")
        print(f"{site}/{room}: {len(room_sel['frames'])} frames", flush=True)
    sel["bytes_downloaded"] = raw.bytes_fetched + pose_bytes
    sel["bytes_note"] = "pose reads counted by payload; each used one small range request"
    sel["elapsed_s"] = round(time.time() - t0, 1)
    raw.close()
    done.write_text(json.dumps(sel, indent=1))
    return sel


def fetch(sites: list[str] | None = None, *, root: Path = RAW_DIR) -> list[dict]:
    return [fetch_site(s, root=root) for s in (sites or list(SITES))]


@dataclass(frozen=True)
class Frame:
    site: str
    room: str
    index: int
    scan: int
    role: str
    original_split: str

    @property
    def frame_id(self) -> str:
        return f"frame-{self.index:06d}"

    def path(self, ext: str, root: Path = RAW_DIR) -> Path:
        return root / self.site / self.room / "data" / f"frame-{self.index:06d}.{ext}"

    def pose(self, root: Path = RAW_DIR) -> np.ndarray:
        p = parse_pose(self.path("pose.txt", root).read_text())
        if p is None:
            raise ValueError(f"invalid pose for {self}")
        return p


def load_frames(root: Path = RAW_DIR) -> list[Frame]:
    out = []
    for site in SITES:
        p = root / site / "selection.json"
        if not p.is_file():
            continue
        sel = json.loads(p.read_text())
        for room, rs in sel["rooms"].items():
            for f, info in sorted(rs["frames"].items(), key=lambda kv: int(kv[0])):
                out.append(
                    Frame(site, room, int(f), info["scan"], info["role"], info["original_split"])
                )
    return out


def load_depth_m(path: Path) -> np.ndarray:
    import cv2

    d = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if d is None or d.dtype != np.uint16:
        raise ValueError(f"unexpected depth image {path}")
    out = d.astype(np.float32) / 1000.0
    out[d == 0] = np.nan
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m placematch.datasets.twelvescenes")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--sites", nargs="*", default=None)
    args = ap.parse_args(argv)
    for s in fetch(args.sites):
        n = sum(len(r["frames"]) for r in s["rooms"].values())
        print(f"{s['site']}: {n} frames, {s['bytes_downloaded'] / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
