"""Rotated + variable-frame-rate video: extracted timestamps equal true PTS (small, fast)."""

from __future__ import annotations

import json
import shutil
import subprocess

import numpy as np
import pytest
from PIL import Image

from placematch.frames import extract_video

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

DUR = [0.5, 0.1, 0.9, 0.25, 1.3]  # seconds each frame is shown (VFR)
TB = 90000


def _make(tmp, rotation):
    seq = tmp / "seq"
    seq.mkdir()
    for i in range(len(DUR)):  # distinct, orientation-revealing frames: bright top-left block
        a = np.full((96, 128, 3), 30 + 40 * i, np.uint8)
        a[:24, :32] = 255
        Image.fromarray(a).save(seq / f"{i:03d}.png")
    ticks = [round(t * TB) for t in np.cumsum([0.0] + DUR[:-1])]
    expr = "0"
    for i, t in reversed(list(enumerate(ticks))):
        expr = f"if(eq(N\\,{i})\\,{t}\\,{expr})"
    tr = {0: [], 90: ["transpose=1"], 270: ["transpose=2"]}[rotation]
    coded, out = tmp / "coded.mp4", tmp / f"r{rotation}.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-framerate", "1", "-i", str(seq / "%03d.png"),
         "-vf", ",".join([f"settb=1/{TB}", f"setpts={expr}", *tr]), "-fps_mode", "passthrough",
         "-enc_time_base:v", f"1/{TB}", "-c:v", "libx264", "-bf", "2", "-pix_fmt", "yuv420p",
         "-video_track_timescale", str(TB), str(coded)],
        check=True,
    )  # fmt: skip
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-display_rotation:v:0", str(rotation), "-i", str(coded),
         "-c", "copy", str(out)],
        check=True,
    )  # fmt: skip
    return out, [t / TB for t in ticks]


def _true_pts(video):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries",
         "frame=pts_time", "-of", "json", str(video)],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    return sorted(float(f["pts_time"]) for f in json.loads(out.stdout)["frames"])


@pytest.mark.parametrize("rotation", [0, 90, 270])
def test_vfr_rotated_timestamps_and_upright(tmp_path, rotation):
    video, designed = _make(tmp_path, rotation)
    true = _true_pts(video)
    assert np.allclose(true, designed, atol=1e-4)
    entries = extract_video(video, tmp_path / "frames", fps=2.0)
    # first frame of each 0.5 s bin, computed from the true PTS independently
    expected, last = [], None
    for i, t in enumerate(true):
        if int(np.floor(t * 2.0 + 1e-9)) != last:
            expected.append((i, t))
            last = int(np.floor(t * 2.0 + 1e-9))
    assert [round(e.timestamp_s, 4) for e in entries] == [round(t, 4) for _, t in expected]
    assert [e.frame_id for e in entries] == [str(i) for i, _ in expected]
    assert {e.extra["rotation_ccw_deg"] for e in entries} == {rotation}
    for e, (i, _) in zip(entries, expected, strict=True):
        a = np.asarray(Image.open(e.path).convert("L"), dtype=float)
        assert a.shape == (96, 128)  # displayed (upright) size, not the coded size
        assert a[:24, :32].mean() > 200  # bright block back in the top-left corner
        assert abs(a[40:, 60:].mean() - (30 + 40 * i)) < 12  # it is source frame i
