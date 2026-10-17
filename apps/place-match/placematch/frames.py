"""Video frame extraction (real PTS, upright) and image-directory ingest."""

from __future__ import annotations

import bisect
import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from placematch.schemas import ManifestEntry, Role

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
if ".heic" in Image.registered_extensions():  # only with a HEIF plugin installed
    IMAGE_EXTS |= {".heic", ".heif"}

# Display rotation (ffprobe, degrees counter-clockwise) -> equivalent EXIF orientation code.
_ROTATION_TO_EXIF = {0: 1, 90: 8, 180: 3, 270: 6}
_SHOWINFO = re.compile(r"\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.]+)")


def _tool(name: str) -> str:
    path = shutil.which(name) or f"/opt/homebrew/bin/{name}"
    if not Path(path).exists():
        raise RuntimeError(f"{name} not found on PATH")
    return path


HEIF_EXTS = {".heic", ".heif"}


class InvalidImage(ValueError):
    """An image file that cannot be decoded; the message always names the file."""


class InvalidVideo(ValueError):
    """A video file that ffprobe/ffmpeg cannot read; the message always names the file."""


def _image_problem(path: Path, exc: BaseException) -> str:
    path = Path(path)
    if not path.exists():
        return "file not found"
    size = path.stat().st_size
    if size == 0:
        return "empty file (0 bytes)"
    with open(path, "rb") as f:
        head = f.read(32)
    if path.suffix.lower() in HEIF_EXTS or head[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1"):
        if ".heic" not in Image.registered_extensions():
            return "HEIC/HEIF image but no HEIF decoder is installed (pillow-heif); convert to JPEG"
    if isinstance(exc, OSError) and "truncated" in str(exc).lower():
        return f"truncated/corrupt image data ({size} bytes): {exc}"
    if head[:2] == b"\xff\xd8" and not isinstance(exc, FileNotFoundError):
        return f"corrupt JPEG ({size} bytes): {type(exc).__name__}: {exc}"
    if all(32 <= b < 127 or b in (9, 10, 13) for b in head):
        return f"not an image: file starts with text ({size} bytes, suffix {path.suffix!r})"
    return f"cannot decode image ({size} bytes): {type(exc).__name__}: {exc}"


def load_upright(path: Path) -> Image.Image:
    """Open an image as RGB with its EXIF orientation applied.

    Raises :class:`InvalidImage` naming the file and the reason (empty, text, truncated,
    HEIC without a decoder, ...).
    """
    try:
        with Image.open(path) as im:
            return ImageOps.exif_transpose(im).convert("RGB")
    except Exception as exc:
        raise InvalidImage(f"{path}: {_image_problem(Path(path), exc)}") from exc


def load_upright_array(path: Path) -> np.ndarray:
    return np.asarray(load_upright(path))


def exif_orientation(path: Path) -> int:
    try:
        with Image.open(path) as im:
            return int(im.getexif().get(0x0112, 1) or 1)
    except Exception:
        return 1


def probe_video(video: Path) -> dict:
    """Stream info for the first video stream: rotation and presentation timestamps."""
    video = Path(video)
    if not video.is_file():
        raise InvalidVideo(f"{video}: file not found")
    if video.stat().st_size == 0:
        raise InvalidVideo(f"{video}: empty file (0 bytes)")
    out = subprocess.run(
        [_tool("ffprobe"), "-v", "error", "-select_streams", "v:0", "-print_format", "json",
         "-show_streams", "-show_format", "-show_entries", "packet=pts_time", str(video)],
        capture_output=True, text=True,
    )  # fmt: skip
    if out.returncode != 0:
        raise InvalidVideo(f"{video}: ffprobe cannot read it: {out.stderr.strip()[-300:]}")
    info = json.loads(out.stdout or "{}")
    if not info.get("streams"):
        raise InvalidVideo(f"{video}: no video stream found")
    stream = info["streams"][0]
    rotation = 0.0
    for sd in stream.get("side_data_list", []):
        if "rotation" in sd:
            rotation = float(sd["rotation"])
    if not rotation and "rotate" in stream.get("tags", {}):
        rotation = -float(stream["tags"]["rotate"])  # legacy tag is clockwise
    pts = sorted(float(p["pts_time"]) for p in info.get("packets", []) if "pts_time" in p)
    return {
        "rotation_ccw_deg": int(round(rotation)) % 360,
        "pts": pts,
        # ffmpeg shifts input timestamps by the container start time (no -copyts).
        "start_time": float(info.get("format", {}).get("start_time", 0.0) or 0.0),
        "width": stream.get("width"),
        "height": stream.get("height"),
        "codec": stream.get("codec_name"),
    }


def extract_video(
    video: Path, out_dir: Path, fps: float = 1.0, location_id: str | None = None
) -> list[ManifestEntry]:
    """Extract roughly ``fps`` frames per second as upright JPEGs with their real PTS.

    The first decoded frame of every ``1/fps`` time bin is kept (no drift, no duplicated
    frames). ffmpeg's autorotate applies the stream's display matrix; the applied rotation is
    recorded as an EXIF-style ``orientation`` code plus ``extra["rotation_ccw_deg"]``.
    ``timestamp_s`` is the selected frame's presentation time (showinfo ``pts_time``) and
    ``frame_id`` its index in presentation order among the stream's packets.
    """
    video = Path(video).resolve()
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    info = probe_video(video)
    stem = video.stem
    for old in out_dir.glob(f"{stem}_*.jpg"):
        old.unlink()
    select = f"select='isnan(prev_selected_t)+gt(floor(t*{fps}),floor(prev_selected_t*{fps}))'"
    proc = subprocess.run(
        [_tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-i", str(video), "-map", "0:v:0",
         "-vf", f"{select},showinfo", "-fps_mode", "passthrough", "-q:v", "2",
         str(out_dir / f"{stem}_%06d.jpg")],
        capture_output=True, text=True,
    )  # fmt: skip
    if proc.returncode != 0:
        raise InvalidVideo(f"{video}: ffmpeg failed: {proc.stderr[-800:]}")
    times = [float(m.group(3)) for m in _SHOWINFO.finditer(proc.stderr)]
    files = sorted(out_dir.glob(f"{stem}_*.jpg"))
    if not files:
        raise InvalidVideo(f"{video}: no frames could be decoded")
    if len(times) != len(files):
        raise RuntimeError(
            f"{video}: showinfo reported {len(times)} frames but {len(files)} were written"
        )
    pts = [p - info["start_time"] for p in info["pts"]]
    rot = info["rotation_ccw_deg"]
    entries = []
    for path, t in zip(files, times, strict=True):
        frame_index = None
        if pts:
            i = bisect.bisect_left(pts, t - 1e-4)
            if i < len(pts) and abs(pts[i] - t) < 1e-3:
                frame_index = i
        entries.append(
            ManifestEntry(
                image_id=f"query:{stem}@{t:.3f}",
                path=str(path),
                role="query",
                dataset="user",
                scene_id=stem,
                location_id=location_id,
                sequence_id=stem,
                frame_id=None if frame_index is None else str(frame_index),
                timestamp_s=round(t, 6),
                orientation=_ROTATION_TO_EXIF.get(rot, 1),
                extra={
                    "video": str(video),
                    "fps_requested": fps,
                    "rotation_ccw_deg": rot,
                    "autorotated": True,
                    "timestamp_source": "ffmpeg showinfo pts_time",
                },
            )
        )
    return entries


def unsupported_images(directory: Path) -> list[str]:
    """Image-like files that ``ingest_images`` skips, each with the reason (names the file)."""
    out = []
    for p in sorted(Path(directory).rglob("*")):
        ext = p.suffix.lower()
        if p.is_file() and ext not in IMAGE_EXTS and ext in HEIF_EXTS | {".tif", ".tiff", ".gif"}:
            why = (
                "HEIC/HEIF needs a HEIF decoder (pillow-heif), not installed"
                if ext in HEIF_EXTS
                else f"unsupported image format {ext}"
            )
            out.append(f"{p}: {why}")
    return out


def ingest_images(
    directory: Path,
    role: Role,
    *,
    dataset: str = "user",
    location_map: dict[str, str] | None = None,
    timestamps: dict[str, float] | None = None,
) -> list[ManifestEntry]:
    """Index images under ``directory`` (recursive, sorted) without copying or renaming.

    Map keys are POSIX paths relative to ``directory``. ``frame_id`` keeps the supplied
    relative filename; ``timestamp_s`` is set only when supplied. ``orientation`` is the EXIF
    code that every loader (:func:`load_upright`) applies.
    """
    directory = Path(directory).resolve()
    location_map = location_map or {}
    timestamps = timestamps or {}
    files = sorted(
        p for p in directory.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTS
    )
    skipped = unsupported_images(directory)
    if skipped:
        import warnings

        warnings.warn(
            f"skipped {len(skipped)} unsupported image file(s) under {directory}: "
            + "; ".join(skipped[:5]),
            stacklevel=2,
        )
    entries = []
    for p in files:
        rel = p.relative_to(directory).as_posix()
        entries.append(
            ManifestEntry(
                image_id=f"{role}:{rel}",
                path=str(p),
                role=role,
                dataset=dataset,
                scene_id=directory.name,
                location_id=location_map.get(rel),
                frame_id=rel,
                timestamp_s=timestamps.get(rel),
                orientation=exif_orientation(p),
            )
        )
    return entries
