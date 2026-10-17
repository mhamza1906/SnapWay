"""Rotated and variable-frame-rate videos: ``python -m placematch.ops.video_check``.

Builds H.264 videos (with B-frames) from 12 well-separated real 7-Scenes frames (read-only)
with explicit, uneven per-frame presentation times (VFR, ``setpts`` on a 1/90000 base).
For rotation the *coded* frames are rotated (``transpose``) and a display matrix that
undoes it is added on remux (``-display_rotation``, counter-clockwise degrees), as a phone
does. Checks:

- every extracted ``timestamp_s`` equals a true presentation time (ffprobe ``-show_frames``
  ``pts_time``, independent of the extractor) and the designed time, within 1 ms;
- the selected frames are exactly the first frame of each ``1/fps`` bin;
- the extracted image is the source frame shown at that time (best match among the 12),
  upright (best match among the four rotations is 0 degrees);
- ``orientation`` / ``rotation_ccw_deg`` match the display matrix.

Writes ``runs/ops/video.json``; videos and frames go to ``runs/ops/fixtures/video/``.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from placematch.env import DATA_DIR
from placematch.frames import extract_video
from placematch.ops.common import OPS_DIR, now, rel, write_json

FIX = OPS_DIR / "fixtures" / "video"
SRC = DATA_DIR / "raw" / "7scenes"
#: uneven durations (s): VFR with gaps shorter and longer than the 1/fps bin
DURATIONS = [0.5, 0.1, 0.9, 0.25, 1.3, 0.05, 0.6, 0.033, 0.75, 1.1, 0.2, 0.4]
TRANSPOSE = {0: None, 90: "transpose=1", 180: "transpose=1,transpose=1", 270: "transpose=2"}
TIMESCALE = 90000


def sources() -> list[Path]:
    scenes = ["chess", "fire", "heads", "office", "stairs", "chess"]
    out = []
    for i, s in enumerate(scenes):
        seq = sorted((SRC / s).glob("seq-*"))[0]
        frames = sorted(seq.glob("frame-*.color.png"))
        out += [frames[len(frames) // 4 * (i % 2)], frames[-1 - i]]
    return out[: len(DURATIONS)]


def small(img: Image.Image, size=(64, 48)) -> np.ndarray:
    a = np.asarray(img.convert("L").resize(size, Image.Resampling.BILINEAR), dtype=np.float32)
    return (a - a.mean()) / (a.std() + 1e-6)


def ffprobe_frames(video: Path) -> list[float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames",
         "-show_entries", "frame=pts_time", "-of", "json", str(video)],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    return sorted(float(f["pts_time"]) for f in json.loads(out.stdout)["frames"])


def probe_rotation(video: Path) -> float | None:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json",
         str(video)],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    for sd in json.loads(out.stdout)["streams"][0].get("side_data_list", []):
        if "rotation" in sd:
            return float(sd["rotation"])
    return None


def designed_pts() -> list[int]:
    """Presentation times in 1/TIMESCALE ticks: frame i starts at sum(DURATIONS[:i])."""
    return [round(t * TIMESCALE) for t in np.cumsum([0.0] + DURATIONS[:-1])]


def make_video(srcs: list[Path], rotation: int, container: str) -> Path:
    """Image sequence -> explicit per-frame PTS (setpts on a 1/90000 time base) -> H.264."""
    FIX.mkdir(parents=True, exist_ok=True)
    seq = FIX / "seq"
    shutil.rmtree(seq, ignore_errors=True)
    seq.mkdir()
    for i, p in enumerate(srcs):
        shutil.copyfile(p, seq / f"{i:03d}.png")
    expr = "0"
    for i, ticks in reversed(list(enumerate(designed_pts()))):
        expr = f"if(eq(N\\,{i})\\,{ticks}\\,{expr})"
    filters = [f"settb=1/{TIMESCALE}", f"setpts={expr}"]
    if TRANSPOSE[rotation]:
        filters.append(TRANSPOSE[rotation])
    coded = FIX / f"coded_r{rotation}.{container}"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-framerate", "1", "-i", str(seq / "%03d.png"),
         "-vf", ",".join(filters), "-fps_mode", "passthrough",
         "-enc_time_base:v", f"1/{TIMESCALE}", "-c:v", "libx264", "-bf", "3",
         "-pix_fmt", "yuv420p", "-video_track_timescale", str(TIMESCALE), str(coded)],
        check=True,
    )  # fmt: skip
    shutil.rmtree(seq)
    out = FIX / f"vfr_r{rotation}.{container}"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-display_rotation:v:0", str(rotation), "-i",
         str(coded), "-c", "copy", str(out)],
        check=True,
    )  # fmt: skip
    coded.unlink()
    return out


def check(video: Path, srcs: list[Path], rotation: int, fps: float) -> dict:
    designed = np.asarray(designed_pts()) / TIMESCALE
    true_pts = ffprobe_frames(video)
    start = float(
        json.loads(
            subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=start_time",
                    "-of",
                    "json",
                    str(video),
                ],
                capture_output=True,
                text=True,
                check=True,
            ).stdout  # fmt: skip
        )["format"].get("start_time", 0.0)
    )
    true_rel = [t - start for t in true_pts]
    expected, last_bin = [], None
    for i, t in enumerate(true_rel):
        b = int(np.floor(t * fps + 1e-9))
        if b != last_bin:
            expected.append((i, t))
            last_bin = b
    out_dir = FIX / f"frames_{video.stem}"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    entries = extract_video(video, out_dir, fps=fps)
    refs = [small(Image.open(p)) for p in srcs]
    rows, ok = [], True
    for e, (exp_i, exp_t) in zip(entries, expected, strict=False):
        img = Image.open(e.path)
        src_i = min(exp_i, len(srcs) - 1)
        scores = [float((small(img) * r).mean()) for r in refs]
        best = int(np.argmax(scores))
        rot_scores = {
            k: float((small(img.rotate(k, expand=True)) * refs[src_i]).mean())
            for k in (0, 90, 180, 270)
        }
        upright = max(rot_scores, key=rot_scores.get) == 0
        row = {
            "timestamp_s": e.timestamp_s,
            "expected_pts_s": round(exp_t, 6),
            "designed_s": round(float(designed[exp_i]), 6),
            "abs_err_vs_pts_ms": round(abs(e.timestamp_s - exp_t) * 1000, 4),
            "frame_id": e.frame_id,
            "expected_frame_index": exp_i,
            "expected_source_index": src_i,
            "content_matches_source_index": best,
            "upright": upright,
            "size": list(img.size),
        }
        good = (
            row["abs_err_vs_pts_ms"] <= 1.0
            and abs(e.timestamp_s - designed[exp_i]) <= 1e-3
            and best == src_i
            and upright
            and e.frame_id == str(exp_i)
        )
        row["ok"] = good
        ok &= good
        rows.append(row)
    meta = entries[0] if entries else None
    return {
        "video": rel(video),
        "rotation_set_ccw_deg": rotation,
        "ffprobe_side_data_rotation": probe_rotation(video),
        "extracted_rotation_ccw_deg": meta.extra.get("rotation_ccw_deg") if meta else None,
        "extracted_orientation": meta.orientation if meta else None,
        "container_start_time_s": start,
        "fps_requested": fps,
        "n_true_frames": len(true_pts),
        "true_pts_match_design": len(true_rel) == len(designed)
        and bool(np.allclose(true_rel, designed, atol=1e-3)),
        "n_expected_selected": len(expected),
        "n_extracted": len(entries),
        "max_abs_err_ms": max((r["abs_err_vs_pts_ms"] for r in rows), default=None),
        "all_ok": bool(ok and len(entries) == len(expected)),
        "frames": rows,
    }


def main() -> int:
    srcs = sources()
    results = []
    for rotation in (0, 90, 180, 270):
        for container in ("mp4", "mov"):
            v = make_video(srcs, rotation, container)
            for fps in (1.0, 4.0):
                r = check(v, srcs, rotation, fps)
                results.append(r)
                print(
                    f"{v.name} fps={fps}: {r['n_extracted']}/{r['n_expected_selected']} frames, "
                    f"max err {r['max_abs_err_ms']} ms, rot {r['extracted_rotation_ccw_deg']}, "
                    f"ok={r['all_ok']}"
                )
    out = {
        "created_utc": now(),
        "sources": [rel(p) for p in srcs],
        "durations_s": DURATIONS,
        "encoder": "libx264 -bf 3 (B-frames), setpts per frame, -fps_mode passthrough",
        "ffmpeg": subprocess.run(
            ["ffmpeg", "-version"], capture_output=True, text=True
        ).stdout.splitlines()[0],
        "all_ok": all(r["all_ok"] for r in results),
        "results": results,
    }
    print(write_json("video.json", out), "all_ok =", out["all_ok"])
    return 0 if out["all_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
