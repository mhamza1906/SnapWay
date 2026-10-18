"""Geometric co-visibility between a query and a reference image.

Two estimators, both based on poses plus 3D structure (never camera position alone):

* :func:`depth_overlap` (7-Scenes): back-project the query depth map to 3D with the depth
  intrinsics, move the points into the reference camera with both poses, project them and
  keep the points that land inside the reference image *and* agree with the reference depth
  map (occlusion / visibility test). Returns the fraction of valid query depth pixels that
  are co-visible.

* :func:`sfm_covisibility` (CLoc): the reference image's observed SfM 3D points versus the
  set of model points visible in the query (projected with the ground-truth query pose and
  intrinsics, then filtered with a coarse z-buffer to drop points hidden behind nearer
  structure). Returns the fraction of query-visible points that the reference observes.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class PinholeK:
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int


def backproject(depth: np.ndarray, K: PinholeK, stride: int = 4) -> np.ndarray:
    """Return (n, 3) camera-frame points for valid depth pixels sampled on a grid."""
    vs, us = np.mgrid[0 : depth.shape[0] : stride, 0 : depth.shape[1] : stride]
    z = depth[vs, us]
    ok = np.isfinite(z) & (z > 0)
    u, v, z = us[ok].astype(np.float64), vs[ok].astype(np.float64), z[ok].astype(np.float64)
    return np.stack([(u - K.cx) / K.fx * z, (v - K.cy) / K.fy * z, z], axis=1)


def transform(T: np.ndarray, pts: np.ndarray) -> np.ndarray:
    return pts @ T[:3, :3].T + T[:3, 3]


def depth_overlap(
    query_depth: np.ndarray,
    query_c2w: np.ndarray,
    ref_depth: np.ndarray,
    ref_c2w: np.ndarray,
    K: PinholeK,
    *,
    stride: int = 4,
    abs_tol: float = 0.05,
    rel_tol: float = 0.05,
    query_mask: np.ndarray | None = None,
) -> tuple[float, int]:
    """Fraction of valid query depth pixels co-visible in the reference view.

    A query pixel is co-visible when its 3D point projects in front of the reference
    camera, inside the image, onto a valid reference depth pixel, and
    ``|ref_depth - z_ref| <= max(abs_tol, rel_tol * z_ref)``. ``query_mask`` (bool, same
    shape as the depth map) restricts the query pixels (used for synthetic crops).
    Returns ``(fraction, n_valid_query_points)``.
    """
    depth = query_depth
    if query_mask is not None:
        depth = np.where(query_mask, query_depth, np.nan)
    pts_q = backproject(depth, K, stride)
    n = len(pts_q)
    if n == 0:
        return 0.0, 0
    T = np.linalg.inv(ref_c2w) @ query_c2w  # query camera -> reference camera
    p = transform(T, pts_q)
    z = p[:, 2]
    front = z > 1e-3
    u = np.full(n, -1.0)
    v = np.full(n, -1.0)
    u[front] = K.fx * p[front, 0] / z[front] + K.cx
    v[front] = K.fy * p[front, 1] / z[front] + K.cy
    ui, vi = np.rint(u).astype(int), np.rint(v).astype(int)
    inside = front & (ui >= 0) & (ui < K.width) & (vi >= 0) & (vi < K.height)
    d_ref = np.full(n, np.nan)
    d_ref[inside] = ref_depth[vi[inside], ui[inside]]
    tol = np.maximum(abs_tol, rel_tol * z)
    with np.errstate(invalid="ignore"):
        ok = inside & np.isfinite(d_ref) & (np.abs(d_ref - z) <= tol)
    return float(ok.sum()) / n, n


def project_points(
    xyz_world: np.ndarray,
    w2c: np.ndarray,
    K: np.ndarray,
    dist: np.ndarray | None,
    width: int,
    height: int,
    *,
    max_tan: float = 1.2,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Project world points; returns (pixel uv (n,2), depth (n,), inside mask (n,)).

    Points far outside the field of view (|x/z| or |y/z| > max_tan) are rejected before
    applying the distortion polynomial, which is only valid near the image.
    """
    import cv2

    pc = transform(w2c, xyz_world)
    z = pc[:, 2]
    uv = np.full((len(pc), 2), -1.0)
    front = z > 0.05
    xn = np.zeros(len(pc))
    yn = np.zeros(len(pc))
    xn[front] = pc[front, 0] / z[front]
    yn[front] = pc[front, 1] / z[front]
    cand = front & (np.abs(xn) < max_tan) & (np.abs(yn) < max_tan)
    if cand.any():
        obj = np.stack([xn[cand], yn[cand], np.ones(cand.sum())], axis=1)
        d = np.zeros(5) if dist is None else np.asarray(dist, dtype=np.float64)
        img, _ = cv2.projectPoints(obj, np.zeros(3), np.zeros(3), K.astype(np.float64), d)
        uv[cand] = img.reshape(-1, 2)
    inside = cand & (uv[:, 0] >= 0) & (uv[:, 0] < width) & (uv[:, 1] >= 0) & (uv[:, 1] < height)
    return uv, z, inside


def zbuffer_keep(
    uv: np.ndarray,
    z: np.ndarray,
    candidates: np.ndarray,
    width: int,
    height: int,
    *,
    cell: int = 8,
    rel_tol: float = 0.3,
    abs_tol: float = 0.2,
) -> np.ndarray:
    """Coarse z-buffer: keep candidate points within tolerance of the nearest in their cell."""
    keep = np.zeros(len(z), dtype=bool)
    idx = np.flatnonzero(candidates)
    if len(idx) == 0:
        return keep
    gw, gh = int(np.ceil(width / cell)), int(np.ceil(height / cell))
    cx = np.clip((uv[idx, 0] // cell).astype(int), 0, gw - 1)
    cy = np.clip((uv[idx, 1] // cell).astype(int), 0, gh - 1)
    zmin = np.full((gh, gw), np.inf)
    np.minimum.at(zmin, (cy, cx), z[idx])
    keep[idx[z[idx] <= zmin[cy, cx] * (1 + rel_tol) + abs_tol]] = True
    return keep


def grid_coverage(uv: np.ndarray, width: int, height: int, cell: int = 128) -> float:
    """Fraction of ``cell``-pixel grid cells of an image that contain at least one point."""
    if len(uv) == 0:
        return 0.0
    gw, gh = int(np.ceil(width / cell)), int(np.ceil(height / cell))
    cx = np.clip((uv[:, 0] // cell).astype(int), 0, gw - 1)
    cy = np.clip((uv[:, 1] // cell).astype(int), 0, gh - 1)
    return len(set(zip(cx.tolist(), cy.tolist(), strict=True))) / (gw * gh)


@dataclass
class SfmPairStats:
    shared: int  # reference-observed 3D points predicted visible in the query
    ref_points: int  # 3D points the reference observes
    coverage_query: float  # grid coverage of the shared points in the query image
    coverage_reference: float  # grid coverage of the shared points in the reference image


class SfmVisibility:
    """Predict which SfM points a posed camera sees, from the model's own observations.

    A point counts as visible from a camera when it projects inside the image (with the
    camera's distortion), lies within ``max_angle_deg`` of the viewing direction of at least
    one database camera that actually observed it, and survives a coarse z-buffer
    (``zbuffer_keep``). Textureless surfaces contain no points, so the z-buffer cannot hide
    what lies behind them; :meth:`pair_stats` therefore only counts points the reference
    *observed* and requires them to cover a spread of both images.
    """

    def __init__(self, points, images: dict, *, max_angle_deg: float = 45.0) -> None:
        self.points = points
        self.images = images
        self.cos_max = float(np.cos(np.radians(max_angle_deg)))
        self.id_to_idx = {int(pid): i for i, pid in enumerate(points.ids.tolist())}
        centres = {iid: -im.world_to_camera()[:3, :3].T @ im.tvec for iid, im in images.items()}
        self.obs_pt = np.repeat(np.arange(len(points.ids)), points.track_len)
        self.obs_dir = np.array([centres[i] for i in points.track_image_ids.tolist()])
        self.obs_dir = self.obs_dir - points.xyz[self.obs_pt]
        self.obs_dir /= np.linalg.norm(self.obs_dir, axis=1, keepdims=True)

    def visible(
        self, w2c: np.ndarray, K: np.ndarray, dist: np.ndarray | None, width: int, height: int
    ) -> tuple[np.ndarray, np.ndarray]:
        """Return (visible mask over points, projected uv of all points)."""
        uv, z, inside = project_points(self.points.xyz, w2c, K, dist, width, height)
        centre = -w2c[:3, :3].T @ w2c[:3, 3]
        d = centre - self.points.xyz
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        dots = np.einsum("ij,ij->i", self.obs_dir, d[self.obs_pt])
        best = np.full(len(self.points.ids), -2.0)
        np.maximum.at(best, self.obs_pt, dots)
        cand = inside & (best >= self.cos_max)
        return zbuffer_keep(uv, z, cand, width, height), uv

    def pair_stats(
        self,
        query_visible: np.ndarray,
        query_uv: np.ndarray,
        query_size: tuple[int, int],
        ref_image,
        ref_size: tuple[int, int],
    ) -> SfmPairStats:
        obs = ref_image.point3D_ids >= 0
        pids = ref_image.point3D_ids[obs]
        idx = np.array([self.id_to_idx[int(p)] for p in pids.tolist()], dtype=int)
        shared_mask = query_visible[idx] if len(idx) else np.zeros(0, dtype=bool)
        shared_idx = np.unique(idx[shared_mask])
        return SfmPairStats(
            shared=int(len(shared_idx)),
            ref_points=int(len(np.unique(idx))),
            coverage_query=grid_coverage(query_uv[shared_idx], *query_size),
            coverage_reference=grid_coverage(ref_image.xys[obs][shared_mask], *ref_size),
        )
