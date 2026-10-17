"""Offline tests for dataset helpers: overlap geometry, zip streaming, COLMAP, pickles."""

from __future__ import annotations

import io
import pickle
import struct
import zipfile

import numpy as np
import pytest

from placematch.datasets import bench, cloc, colmap_io
from placematch.datasets.overlap import (
    PinholeK,
    depth_overlap,
    grid_coverage,
    project_points,
    zbuffer_keep,
)
from placematch.datasets.remote_zip import WindowFile, iter_stream_zip, member_data_offset

K = PinholeK(585.0, 585.0, 320.0, 240.0, 640, 480)


def _wall(z=2.0):
    return np.full((480, 640), z, dtype=np.float32)


def _pose(tx=0.0, yaw_deg=0.0):
    a = np.radians(yaw_deg)
    T = np.eye(4)
    T[:3, :3] = [[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]]
    T[0, 3] = tx
    return T


def test_depth_overlap_identity_and_shift():
    full, n = depth_overlap(_wall(), _pose(), _wall(), _pose(), K)
    assert full == pytest.approx(1.0) and n > 0
    # shift sideways by half the visible wall width (wall width at 2 m = 640/585*2 m)
    half, _ = depth_overlap(_wall(), _pose(), _wall(), _pose(tx=640 / 585.0), K)
    assert 0.4 < half < 0.6
    away, _ = depth_overlap(_wall(), _pose(), _wall(), _pose(yaw_deg=180), K)
    assert away == 0.0


def test_depth_overlap_occlusion_and_invalid():
    ref = _wall(1.0)  # reference sees a nearer surface: query wall hidden behind it
    hidden, _ = depth_overlap(_wall(2.0), _pose(), ref, _pose(), K)
    assert hidden == 0.0
    q = _wall()
    q[:, :320] = np.nan
    frac, n = depth_overlap(q, _pose(), _wall(), _pose(), K)
    assert frac == pytest.approx(1.0)
    mask = np.zeros((480, 640), bool)
    mask[100:200, 400:500] = True
    frac_m, n_m = depth_overlap(_wall(), _pose(), _wall(), _pose(), K, query_mask=mask)
    assert frac_m == pytest.approx(1.0) and n_m < n


def test_projection_zbuffer_and_coverage():
    Km = np.array([[100.0, 0, 50], [0, 100.0, 50], [0, 0, 1]])
    pts = np.array([[0, 0, 1.0], [0, 0, 5.0], [0, 0, -1.0], [10, 0, 1.0]])
    uv, z, inside = project_points(pts, np.eye(4), Km, None, 100, 100)
    assert inside.tolist() == [True, True, False, False]
    keep = zbuffer_keep(uv, z, inside, 100, 100)
    assert keep.tolist() == [True, False, False, False]  # far point hidden
    assert grid_coverage(np.array([[1.0, 1.0], [100.0, 1.0]]), 256, 128, cell=128) == 0.5


def _zip_bytes(members: dict[str, bytes], compression=zipfile.ZIP_DEFLATED) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=compression) as z:
        for n, d in members.items():
            z.writestr(n, d)
    return buf.getvalue()


def test_stream_zip_selects_members_and_checks_crc():
    data = {f"seq/frame-{i:06d}.color.png": bytes([i]) * (100 + i) for i in range(6)}
    data["seq/frame-000000.pose.txt"] = b"1 0 0 0\n" * 4
    blob = _zip_bytes(data)
    chunks = [blob[i : i + 37] for i in range(0, len(blob), 37)]
    got = list(iter_stream_zip(chunks, lambda n: n.endswith("0.color.png")))
    assert [g[0] for g in got] == ["seq/frame-000000.color.png"]
    assert got[0][1] == data["seq/frame-000000.color.png"] and got[0][2]


def test_nested_window_open():
    inner = _zip_bytes({"a.txt": b"hello"})
    outer_bytes = _zip_bytes({"seq-01.zip": inner}, compression=zipfile.ZIP_STORED)
    raw = io.BytesIO(outer_bytes)
    outer = zipfile.ZipFile(raw)
    info = outer.getinfo("seq-01.zip")
    start = member_data_offset(raw, info)
    z = zipfile.ZipFile(io.BufferedReader(WindowFile(raw, start, info.file_size)))
    assert z.read("a.txt") == b"hello"


def test_colmap_binary_readers(tmp_path):
    cams = struct.pack("<Q", 1) + struct.pack("<iiQQ", 7, 2, 1024, 1024)
    cams += struct.pack("<dddd", 512, 512, 512, 0)
    (tmp_path / "cameras.bin").write_bytes(cams)
    img = struct.pack("<Q", 1) + struct.pack("<idddddddi", 3, 1, 0, 0, 0, 1, 2, 3, 7)
    img += b"f1/123.5_2.png\x00" + struct.pack("<Q", 2)
    img += struct.pack("<ddq", 10.0, 20.0, 42) + struct.pack("<ddq", 5.0, 6.0, -1)
    (tmp_path / "images.bin").write_bytes(img)
    pts = struct.pack("<Q", 1) + struct.pack("<Qddd", 42, 1.0, 2.0, 3.0) + bytes([1, 2, 3])
    pts += struct.pack("<d", 0.5) + struct.pack("<Q", 2) + struct.pack("<iiii", 3, 0, 4, 1)
    (tmp_path / "points3D.bin").write_bytes(pts)
    c = colmap_io.read_cameras(tmp_path / "cameras.bin")[7]
    assert c.model == "SIMPLE_RADIAL" and c.K()[0, 0] == 512
    im = colmap_io.read_images(tmp_path / "images.bin")[3]
    assert im.name == "f1/123.5_2.png" and im.point3D_ids.tolist() == [42, -1]
    assert np.allclose(im.world_to_camera()[:3, 3], [1, 2, 3])
    p = colmap_io.read_points3D(tmp_path / "points3D.bin")
    assert p.ids.tolist() == [42] and p.track_image_ids.tolist() == [3, 4]


class _Evil:
    def __reduce__(self):
        import os

        return (os.system, ("echo should-not-run",))


def test_gt_pickle_loader_is_restricted():
    good = pickle.dumps({"s/001/f.jpg": [np.array([1.0, 2.0, 3.0]), np.array([1.0, 0, 0, 0])]})
    out = cloc.safe_load_gt_pickle(good)
    assert out["s/001/f.jpg"][0].tolist() == [1.0, 2.0, 3.0]
    with pytest.raises(pickle.UnpicklingError):
        cloc.safe_load_gt_pickle(pickle.dumps({"x": [_Evil()]}))


def test_farthest_point_and_spread():
    pts = np.array([[0, 0], [1, 0], [10, 0], [5, 0]], float)
    assert cloc.farthest_point_order(pts, 3) == [0, 2, 3]
    assert cloc._spread([str(i) for i in range(50)], 2) == ["12", "37"]


def test_synthetic_edits():
    img = np.full((480, 640, 3), 200, np.uint8)
    dark, m = bench._edit(img, "dark")
    assert dark.max() == 50 and m is None
    crop, mask = bench._edit(img, "crop")
    assert crop.shape[:2] == (336, 448) and mask.sum() == 336 * 448
    blur, _ = bench._edit(img, "motion_blur")
    assert blur.shape == img.shape


def test_apply_inspection_overrides_without_human_review(tmp_path):
    from placematch.schemas import QueryLabel

    b = bench._Builder(tmp_path)
    b.labels["q"] = QueryLabel(
        query_id="q", has_valid_reference=False, ambiguous=["r1"], method="m", split="test"
    )
    f = tmp_path / "insp.json"
    f.write_text('[{"query_id": "q", "reference_id": "r1", "decision": "positive", "note": "x"}]')
    recs = bench.apply_inspection(b, f)
    lab = b.labels["q"]
    assert lab.positives == ["r1"] and lab.ambiguous == [] and lab.has_valid_reference
    assert lab.agent_inspected and not lab.reviewed and "agent_override" in lab.method
    assert recs[0]["auto_label"] == "ambiguous"
