"""Minimal, dependency-free readers for COLMAP binary models (cameras/images/points3D).

Pure ``struct``/numpy parsing of untrusted files: nothing is executed or unpickled.
Format: https://colmap.github.io/format.html#binary-file-format
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

CAMERA_MODEL_PARAMS = {
    0: ("SIMPLE_PINHOLE", 3),
    1: ("PINHOLE", 4),
    2: ("SIMPLE_RADIAL", 4),
    3: ("RADIAL", 5),
    4: ("OPENCV", 8),
    5: ("OPENCV_FISHEYE", 8),
    6: ("FULL_OPENCV", 12),
    7: ("FOV", 5),
    8: ("SIMPLE_RADIAL_FISHEYE", 4),
    9: ("RADIAL_FISHEYE", 5),
    10: ("THIN_PRISM_FISHEYE", 12),
}


@dataclass
class Camera:
    camera_id: int
    model: str
    width: int
    height: int
    params: np.ndarray

    def K(self) -> np.ndarray:
        p = self.params
        if self.model in ("SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL", "SIMPLE_RADIAL_FISHEYE"):
            f, cx, cy = p[0], p[1], p[2]
            return np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], dtype=np.float64)
        fx, fy, cx, cy = p[0], p[1], p[2], p[3]
        return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)


@dataclass
class Image:
    image_id: int
    qvec: np.ndarray  # (w, x, y, z), world-to-camera rotation
    tvec: np.ndarray  # world-to-camera translation
    camera_id: int
    name: str
    point3D_ids: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.int64))
    xys: np.ndarray = field(default_factory=lambda: np.zeros((0, 2)))

    def world_to_camera(self) -> np.ndarray:
        T = np.eye(4)
        T[:3, :3] = qvec_to_rotmat(self.qvec)
        T[:3, 3] = self.tvec
        return T


def qvec_to_rotmat(q: np.ndarray) -> np.ndarray:
    w, x, y, z = np.asarray(q, dtype=np.float64) / np.linalg.norm(q)
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ]
    )


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data, self.pos = data, 0

    def unpack(self, fmt: str):
        size = struct.calcsize(fmt)
        out = struct.unpack_from(fmt, self.data, self.pos)
        self.pos += size
        return out

    def cstring(self) -> str:
        end = self.data.index(b"\x00", self.pos)
        s = self.data[self.pos : end].decode("utf-8", "replace")
        self.pos = end + 1
        return s

    def array(self, dtype: np.dtype, count: int) -> np.ndarray:
        dtype = np.dtype(dtype)
        arr = np.frombuffer(self.data, dtype=dtype, count=count, offset=self.pos)
        self.pos += dtype.itemsize * count
        return arr


def read_cameras(path: Path) -> dict[int, Camera]:
    r = _Reader(Path(path).read_bytes())
    (n,) = r.unpack("<Q")
    cams = {}
    for _ in range(n):
        cid, model_id, w, h = r.unpack("<iiQQ")
        name, npar = CAMERA_MODEL_PARAMS[model_id]
        params = np.array(r.unpack("<" + "d" * npar))
        cams[cid] = Camera(cid, name, int(w), int(h), params)
    return cams


def read_images(path: Path, *, with_points: bool = True) -> dict[int, Image]:
    r = _Reader(Path(path).read_bytes())
    (n,) = r.unpack("<Q")
    images = {}
    pt_dtype = np.dtype([("x", "<f8"), ("y", "<f8"), ("id", "<i8")])
    for _ in range(n):
        iid, qw, qx, qy, qz, tx, ty, tz, cid = r.unpack("<idddddddi")
        name = r.cstring()
        (npts,) = r.unpack("<Q")
        pts = r.array(pt_dtype, npts)
        img = Image(iid, np.array([qw, qx, qy, qz]), np.array([tx, ty, tz]), cid, name)
        if with_points:
            img.point3D_ids = pts["id"].copy()
            img.xys = np.stack([pts["x"], pts["y"]], axis=1)
        images[iid] = img
    return images


@dataclass
class Points3D:
    ids: np.ndarray  # int64 (n,)
    xyz: np.ndarray  # float64 (n, 3)
    error: np.ndarray  # float64 (n,) mean reprojection error (px)
    track_start: np.ndarray  # int64 (n,) offset into track_image_ids
    track_len: np.ndarray  # int64 (n,)
    track_image_ids: np.ndarray  # int32 (sum track_len,) observing image ids


def read_points3D(path: Path) -> Points3D:
    """Read points with their reprojection error and observing image ids (colours skipped)."""
    r = _Reader(Path(path).read_bytes())
    (n,) = r.unpack("<Q")
    ids = np.empty(n, dtype=np.int64)
    xyz = np.empty((n, 3), dtype=np.float64)
    err = np.empty(n, dtype=np.float64)
    tlens = np.empty(n, dtype=np.int64)
    tracks: list[np.ndarray] = []
    for i in range(n):
        pid, x, y, z = r.unpack("<Qddd")
        r.pos += 3  # rgb
        (e,) = r.unpack("<d")
        (tlen,) = r.unpack("<Q")
        tr = r.array(np.dtype("<i4"), 2 * tlen)
        tracks.append(tr[0::2])
        ids[i], xyz[i], err[i], tlens[i] = pid, (x, y, z), e, tlen
    starts = np.concatenate([[0], np.cumsum(tlens)[:-1]]).astype(np.int64)
    track_ids = np.concatenate(tracks).astype(np.int32) if tracks else np.zeros(0, np.int32)
    return Points3D(ids, xyz, err, starts, tlens, track_ids)
