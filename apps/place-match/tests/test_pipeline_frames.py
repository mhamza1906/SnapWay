"""Frame extraction, image ingest and quality flags (offline)."""

from __future__ import annotations

import shutil
import subprocess

import numpy as np
import pytest
from PIL import Image

from placematch.frames import extract_video, ingest_images, load_upright
from placematch.quality import assess


def _textured(w=160, h=120, seed=0) -> Image.Image:
    rng = np.random.default_rng(seed)
    return Image.fromarray(rng.integers(0, 255, (h, w, 3), dtype=np.uint8))


def test_ingest_recursive_maps_and_exif(tmp_path):
    (tmp_path / "lobby").mkdir()
    _textured().save(tmp_path / "a.png")
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 CW to display
    _textured(160, 120).save(tmp_path / "lobby" / "IMG_1.jpg", exif=exif)
    (tmp_path / "notes.txt").write_text("x")
    es = ingest_images(
        tmp_path,
        "reference",
        location_map={"lobby/IMG_1.jpg": "lobby"},
        timestamps={"a.png": 1.5},
    )
    assert [e.image_id for e in es] == ["reference:a.png", "reference:lobby/IMG_1.jpg"]
    a, b = es
    assert a.timestamp_s == 1.5 and b.timestamp_s is None
    assert b.location_id == "lobby" and a.location_id is None
    assert b.frame_id == "lobby/IMG_1.jpg" and b.orientation == 6 and a.orientation == 1
    assert load_upright(b.path).size == (120, 160)  # EXIF applied by every loader


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")
def test_extract_video_pts_and_rotation(tmp_path):
    src, rot = tmp_path / "a.mp4", tmp_path / "rot.mp4"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         "testsrc2=size=160x120:rate=30000/1001", "-t", "2.5", "-pix_fmt", "yuv420p", str(src)],
        check=True,
    )  # fmt: skip
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", str(src),
         "-c", "copy", str(rot)],
        check=True,
    )  # fmt: skip
    es = extract_video(rot, tmp_path / "frames", fps=1.0, location_id="x")
    assert [e.timestamp_s for e in es] == pytest.approx([0.0, 1.001, 2.002], abs=1e-3)
    assert [e.frame_id for e in es] == ["0", "30", "60"]
    assert es[1].image_id == "query:rot@1.001" and es[0].role == "query"
    assert all(e.orientation == 8 and e.extra["rotation_ccw_deg"] == 90 for e in es)
    assert Image.open(es[0].path).size == (120, 160)  # upright (portrait)
    es2 = extract_video(src, tmp_path / "frames2", fps=2.0)
    assert len(es2) == 5 and es2[0].orientation == 1


def test_quality_flags(tmp_path):
    _textured(256, 256).save(tmp_path / "sharp.png")
    Image.new("RGB", (256, 256), (128, 128, 128)).save(tmp_path / "flat.png")
    Image.new("RGB", (256, 256), (5, 5, 5)).save(tmp_path / "dark.png")
    Image.new("RGB", (256, 256), (252, 252, 252)).save(tmp_path / "bright.png")
    assert assess(tmp_path / "sharp.png").flags == []
    assert assess(tmp_path / "flat.png").flags == ["blurry"]
    dark = assess(tmp_path / "dark.png")
    assert "underexposed" in dark.flags and dark.dark_fraction == 1.0
    assert "overexposed" in assess(tmp_path / "bright.png").flags
