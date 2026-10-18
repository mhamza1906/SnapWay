"""Render an offline point-retrieval diagnostic without running model inference.

Example::

    python -m placematch.ops.point_video_render --run /path/to/run \
        --video /path/to/walk.MOV --output /path/to/tracking.mp4 --render-fps 10

The camera video plays at its original speed. Retrieval samples are held until the
next recorded timestamp; increasing render FPS does not add localization analyses.
Breadcrumbs follow exported, open walking-support edges, including bend nodes.
They are schematic retrieval history, not measured camera poses or verified paths.
"""

from __future__ import annotations

import argparse
import bisect
import heapq
import json
import math
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps

WIDTH, HEIGHT = 1600, 1000
CAMERA_BOX = (18, 114, 486, 946)
MAP_BOX = (510, 114, 1582, 582)
INK = "#f1f5f7"
MUTED = "#afbec9"
BG = "#111a22"
PANEL = "#1c2934"
GREEN = "#43d69b"
AMBER = "#ffc367"
RED = "#ee8c8c"
PURPLE = "#c6a6ff"


def _font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


FONTS = {size: _font(size) for size in (14, 16, 18, 20, 22, 24, 28, 30, 32)}
BOLD = {size: _font(size, bold=True) for size in (16, 18, 20, 22, 24, 28, 30, 32)}


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def _timestamp(seconds: float) -> str:
    minutes, remainder = divmod(max(0.0, seconds), 60)
    return f"{int(minutes):02d}:{remainder:04.1f}"


def _wrap(draw: ImageDraw.ImageDraw, text: str, width: int, font: Any) -> list[str]:
    lines: list[str] = []
    line = ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if line and draw.textlength(trial, font=font) > width:
            lines.append(line)
            line = word
        else:
            line = trial
    if line:
        lines.append(line)
    return lines


def _text_block(
    draw: ImageDraw.ImageDraw,
    text: str,
    xy: tuple[int, int],
    width: int,
    *,
    color: str = MUTED,
    size: int = 18,
    max_lines: int = 4,
) -> None:
    for index, line in enumerate(_wrap(draw, text, width, FONTS[size])[:max_lines]):
        draw.text((xy[0], xy[1] + index * (size + 7)), line, font=FONTS[size], fill=color)


def _probe(video: Path) -> dict[str, Any]:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(video)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def shortest_support_path(
    adjacency: dict[str, list[tuple[str, float]]], start: str, goal: str
) -> list[str]:
    """Return only existing support edges; a missing connection stays a visible gap."""
    if start == goal:
        return [start]
    distances = {start: 0.0}
    previous: dict[str, str] = {}
    queue = [(0.0, start)]
    while queue:
        cost, node = heapq.heappop(queue)
        if cost > distances[node]:
            continue
        if node == goal:
            path = [goal]
            while path[-1] != start:
                path.append(previous[path[-1]])
            return path[::-1]
        for neighbor, weight in adjacency.get(node, []):
            proposed = cost + weight
            if proposed < distances.get(neighbor, math.inf):
                distances[neighbor] = proposed
                previous[neighbor] = node
                heapq.heappush(queue, (proposed, neighbor))
    return []


class DiagnosticRenderer:
    """Compose camera/map/reference panels from already-computed retrievals."""

    def __init__(self, run: Path, *, trail_seconds: float = 35.0) -> None:
        self.run = run
        self.tracking = _read_json(run / "tracking.json")
        self.frames = sorted(self.tracking["frames"], key=lambda row: row["timestamp_s"])
        if not self.frames:
            raise ValueError("tracking.json contains no analyzed frames")
        self.times = [float(row["timestamp_s"]) for row in self.frames]
        if any(not math.isfinite(value) or value < 0 for value in self.times):
            raise ValueError("Tracking timestamps must be finite and nonnegative")
        self.sample_fps = float(self.tracking.get("sample_fps", 2))
        self.trail_seconds = trail_seconds
        summary = _read_json(run / "embedding-summary.json")
        self.reference_root = Path(summary["reference_root"])
        manifest = _read_json(run / "reference-manifest.json")
        self.references = {str(ref["reference_id"]): ref for ref in manifest["references"]}
        self.walks = manifest["walks"]
        self.node_walk: dict[str, dict[str, Any]] = {}
        self.nodes: dict[str, dict[str, Any]] = {}
        self.adjacency: dict[str, list[tuple[str, float]]] = defaultdict(list)
        self.path_cache: dict[tuple[str, str], list[str]] = {}
        self.map_cache: dict[str, tuple[Image.Image, float, tuple[int, int]]] = {}
        self.thumbnail_cache: dict[str, Image.Image] = {}
        for walk in self.walks:
            for node in walk["graph"]["nodes"]:
                self.node_walk[str(node["id"])] = walk
                self.nodes[str(node["id"])] = node
            for edge in walk["graph"]["edges"]:
                if not edge.get("is_open", True):
                    continue
                source, target = str(edge["from_node"]), str(edge["to_node"])
                if source not in self.nodes or target not in self.nodes:
                    continue
                a, b = self.nodes[source], self.nodes[target]
                fallback = math.hypot(float(a["x"]) - float(b["x"]), float(a["y"]) - float(b["y"]))
                cost = edge.get("cost")
                weight = float(fallback if cost is None else cost)
                if not math.isfinite(weight) or weight < 0:
                    raise ValueError("Graph support costs must be finite and nonnegative")
                # Photo-walk graph links provide two-way geometric walking support.
                # This display-only interpretation does not change application routing.
                self.adjacency[source].append((target, weight))
                self.adjacency[target].append((source, weight))
        self.trails = self._prepare_trails()
        self.preview_written = False

    def _prepare_trails(self) -> list[tuple[float, list[str]]]:
        trails = []
        previous = None
        for row in self.frames:
            # A rejected/ambiguous interval must not become a confident connecting line.
            if row.get("outcome") != "supported_retrieval":
                previous = None
                continue
            node_id = str(row.get("track_node_id", ""))
            if node_id not in self.nodes:
                previous = None
                continue
            if previous:
                previous_time, previous_id = previous
                if row["timestamp_s"] - previous_time <= max(1.5, 3 / self.sample_fps):
                    path = self._path(previous_id, node_id)
                    if len(path) > 1:
                        trails.append((float(row["timestamp_s"]), path))
            previous = (float(row["timestamp_s"]), node_id)
        return trails

    def _path(self, start: str, end: str) -> list[str]:
        if self.node_walk.get(start) is not self.node_walk.get(end):
            return []
        key = (start, end)
        if key not in self.path_cache:
            self.path_cache[key] = shortest_support_path(self.adjacency, start, end)
        return self.path_cache[key]

    def _map_base(self, target_id: str) -> tuple[Image.Image, float, tuple[int, int]]:
        if target_id in self.map_cache:
            return self.map_cache[target_id]
        walk = next(w for w in self.walks if str(w["target_id"]) == target_id)
        frame = walk["coordinate_frame"]
        area_width, area_height = MAP_BOX[2] - MAP_BOX[0], MAP_BOX[3] - MAP_BOX[1]
        frame_width, frame_height = float(frame["width"]), float(frame["height"])
        scale = min((area_width - 24) / frame_width, (area_height - 24) / frame_height)
        size = (round(frame_width * scale), round(frame_height * scale))
        offset = ((area_width - size[0]) // 2, (area_height - size[1]) // 2)
        image = Image.new("RGB", (area_width, area_height), "#eef1ec")
        underlay = walk.get("underlay")
        if underlay and underlay.get("path"):
            with Image.open(self.reference_root / underlay["path"]) as original:
                rgba = ImageOps.exif_transpose(original).convert("RGBA")
                white = Image.new("RGBA", rgba.size, "#eef1ec")
                white.alpha_composite(rgba)
                image.paste(white.convert("RGB").resize(size, Image.Resampling.LANCZOS), offset)
        draw = ImageDraw.Draw(image)
        for edge in walk["graph"]["edges"]:
            if not edge.get("is_open", True):
                continue
            a = self.nodes.get(str(edge["from_node"]))
            b = self.nodes.get(str(edge["to_node"]))
            if a and b:
                draw.line(
                    [self._xy(a, scale, offset), self._xy(b, scale, offset)],
                    fill="#6492a7",
                    width=2,
                )
        for node in walk["graph"]["nodes"]:
            if node.get("point_number") is None:
                continue
            x, y = self._xy(node, scale, offset)
            draw.ellipse((x - 9, y - 9, x + 9, y + 9), fill="#ecf5f6", outline="#365968", width=1)
            draw.text(
                (x, y), str(node["point_number"]), font=FONTS[14], fill="#203941", anchor="mm"
            )
        self.map_cache[target_id] = (image, scale, offset)
        return self.map_cache[target_id]

    @staticmethod
    def _xy(node: dict[str, Any], scale: float, offset: tuple[int, int]) -> tuple[int, int]:
        return round(float(node["x"]) * scale + offset[0]), round(
            float(node["y"]) * scale + offset[1]
        )

    def _map_panel(self, row: dict[str, Any], timestamp: float) -> Image.Image:
        track = str(row.get("track_node_id", ""))
        raw = str(row.get("raw_node_id", ""))
        walk = self.node_walk.get(track) or self.node_walk.get(raw)
        if not walk:
            return Image.new("RGB", (MAP_BOX[2] - MAP_BOX[0], MAP_BOX[3] - MAP_BOX[1]), PANEL)
        image, scale, offset = self._map_base(str(walk["target_id"]))
        image = image.copy()
        draw = ImageDraw.Draw(image)
        for trail_time, path in self.trails:
            if timestamp - self.trail_seconds <= trail_time <= timestamp:
                if self.node_walk.get(path[0]) is walk:
                    draw.line(
                        [self._xy(self.nodes[n], scale, offset) for n in path],
                        fill="#156a54",
                        width=5,
                    )
        outcome = row.get("outcome", "uncertain")
        color = GREEN if outcome == "supported_retrieval" else AMBER
        if raw in self.nodes and raw != track and outcome != "no_supported_match":
            x, y = self._xy(self.nodes[raw], scale, offset)
            draw.ellipse((x - 15, y - 15, x + 15, y + 15), outline=PURPLE, width=4)
        if track in self.nodes and outcome != "no_supported_match":
            x, y = self._xy(self.nodes[track], scale, offset)
            draw.ellipse((x - 16, y - 16, x + 16, y + 16), fill=color, outline="#153b37", width=3)
            draw.text(
                (x, y), str(row.get("track_point", "?")), font=BOLD[16], fill="#142c25", anchor="mm"
            )
        return image

    def _thumbnail(self, reference_id: str) -> Image.Image | None:
        if reference_id in self.thumbnail_cache:
            return self.thumbnail_cache[reference_id]
        reference = self.references.get(reference_id)
        if not reference:
            return None
        with Image.open(self.reference_root / reference["path"]) as original:
            image = ImageOps.exif_transpose(original).convert("RGB")
            image.thumbnail((226, 238), Image.Resampling.LANCZOS)
            self.thumbnail_cache[reference_id] = image
            return image

    def _reference_card(
        self, image: Image.Image, xy: tuple[int, int], reference_id: str, title: str
    ) -> None:
        x, y = xy
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((x, y, x + 244, y + 316), radius=10, fill=PANEL)
        draw.text((x + 10, y + 8), title, font=BOLD[18], fill=INK)
        reference = self.references.get(reference_id)
        thumbnail = self._thumbnail(reference_id)
        if thumbnail is not None and reference:
            image.paste(thumbnail, (x + (244 - thumbnail.width) // 2, y + 42))
            draw.text(
                (x + 10, y + 288),
                f"Point {reference['point_number']} · {reference['direction']}",
                font=FONTS[16],
                fill=MUTED,
            )
        else:
            draw.text((x + 12, y + 100), "No reference available", font=FONTS[16], fill=MUTED)

    def compose(self, camera: Image.Image, timestamp: float) -> Image.Image:
        index = max(0, bisect.bisect_right(self.times, timestamp + 1e-7) - 1)
        row = self.frames[index]
        canvas = Image.new("RGB", (WIDTH, HEIGHT), BG)
        draw = ImageDraw.Draw(canvas)
        draw.text((20, 14), "MegaLoc · Sam Ibrahim · Level 1", font=BOLD[30], fill=INK)
        draw.text(
            (20, 57),
            f"Recorded walk  {_timestamp(timestamp)}   |   "
            f"Analysis {self.sample_fps:g} Hz   |   Local inference",
            font=FONTS[22],
            fill=MUTED,
        )
        draw.text(
            (1040, 57),
            "Graph-supported trail; gaps on uncertain samples",
            font=FONTS[18],
            fill=MUTED,
        )
        camera = ImageOps.contain(
            camera.convert("RGB"),
            (CAMERA_BOX[2] - CAMERA_BOX[0], CAMERA_BOX[3] - CAMERA_BOX[1]),
            Image.Resampling.BILINEAR,
        )
        canvas.paste(camera, (CAMERA_BOX[0], CAMERA_BOX[1]))
        canvas.paste(self._map_panel(row, timestamp), (MAP_BOX[0], MAP_BOX[1]))
        outcome = row.get("outcome", "uncertain")
        supported = outcome == "supported_retrieval"
        color = GREEN if supported else (RED if outcome == "no_supported_match" else AMBER)
        title = (
            f"Offline estimate · nearby Point {row.get('track_point', '?')}"
            if outcome != "no_supported_match"
            else "No supported visual match"
        )
        draw.text((514, 597), title, font=BOLD[28], fill=color)
        draw.text(
            (514, 632),
            "Nearest known photo stop; position is approximate and unverified.",
            font=FONTS[18],
            fill=MUTED,
        )
        raw_ref = str(row.get("winning_reference_id", ""))
        alternate = next(
            (
                str(c["reference_id"])
                for c in row.get("candidates", [])
                if c.get("point") != row.get("raw_point")
            ),
            "",
        )
        self._reference_card(canvas, (514, 668), raw_ref, "Raw nearest reference")
        self._reference_card(canvas, (770, 668), alternate, "Alternative point")
        x, y = 1040, 675
        draw.text((x, y), "Retrieval diagnostics", font=BOLD[22], fill=INK)
        draw.text(
            (x, y + 38),
            f"Raw point {row.get('raw_point', '?')}  →  "
            f"temporal point {row.get('track_point', '?')}",
            font=FONTS[20],
            fill=PURPLE if row.get("raw_point") != row.get("track_point") else INK,
        )
        score, margin = row.get("score"), row.get("margin")
        score_text = (
            f"Raw cosine: {float(score):.3f}" if score is not None else "Raw cosine: unavailable"
        )
        if row.get("raw_point") != row.get("track_point") and row.get("track_score") is not None:
            score_text += f"  |  temporal: {float(row['track_score']):.3f}"
        draw.text((x, y + 71), score_text, font=FONTS[20], fill=INK)
        draw.text(
            (x, y + 102),
            f"Different-point margin: {float(margin):.3f}"
            if margin is not None
            else "Different-point margin: unavailable",
            font=FONTS[20],
            fill=INK,
        )
        state = "SUPPORTED RETRIEVAL*" if supported else outcome.upper().replace("_", " ")
        draw.text((x, y + 137), state, font=BOLD[20], fill=color)
        flags = row.get("quality_flags", [])
        _text_block(
            draw,
            "Flags: " + (", ".join(str(f) for f in flags) or "none"),
            (x, y + 171),
            530,
            max_lines=2,
        )
        draw.text(
            (x, y + 225),
            f"Held sample @ {_timestamp(float(row['timestamp_s']))}",
            font=FONTS[18],
            fill=MUTED,
        )
        draw.text(
            (x, y + 256), "Cosine is not probability or accuracy.", font=FONTS[18], fill=MUTED
        )
        if supported:
            draw.text(
                (x, y + 282),
                "*Transferred threshold; not site-calibrated.",
                font=FONTS[16],
                fill=MUTED,
            )
        # Footer avoids implying continuous tracking between the analyzed samples.
        draw.rectangle((0, 950, 500, 1000), fill=BG)
        _text_block(
            draw,
            "Diagnostic estimate · Original-speed video · No measured camera pose",
            (18, 957),
            470,
            size=16,
            max_lines=2,
        )
        return canvas


def render_video(
    run: Path, video: Path, output: Path, *, render_fps: float = 10.0
) -> dict[str, Any]:
    if not 0 < render_fps <= 60:
        raise ValueError("render-fps must be greater than 0 and at most 60")
    if output.resolve() == video.resolve():
        raise ValueError("Output must not overwrite the source video")
    from placematch.ops.point_video_embeddings import (
        validate_embedding_artifacts,
        validate_source_video,
    )

    validate_embedding_artifacts(run)
    validate_source_video(run, video)
    renderer = DiagnosticRenderer(run)
    metadata = _probe(video)
    duration = float(metadata["format"]["duration"])
    camera_width, camera_height = CAMERA_BOX[2] - CAMERA_BOX[0], CAMERA_BOX[3] - CAMERA_BOX[1]
    filters = (
        f"fps={render_fps:g},scale={camera_width}:{camera_height}:force_original_aspect_ratio=decrease,"
        f"pad={camera_width}:{camera_height}:(ow-iw)/2:(oh-ih)/2"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    preview = output.parent / "tracking-preview.jpg"
    temporary_output = output.with_name(f".{output.stem}.rendering.mp4")
    total = 0
    with tempfile.TemporaryDirectory(prefix="point-video-render-") as temporary:
        decoder_log = Path(temporary) / "decoder.log"
        encoder_log = Path(temporary) / "encoder.log"
        with decoder_log.open("wb") as decode_error, encoder_log.open("wb") as encode_error:
            decoder = subprocess.Popen(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(video),
                    "-an",
                    "-vf",
                    filters,
                    "-pix_fmt",
                    "rgb24",
                    "-f",
                    "rawvideo",
                    "pipe:1",
                ],
                stdout=subprocess.PIPE,
                stderr=decode_error,
            )
            encoder = subprocess.Popen(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "rawvideo",
                    "-pixel_format",
                    "rgb24",
                    "-video_size",
                    f"{WIDTH}x{HEIGHT}",
                    "-framerate",
                    f"{render_fps:g}",
                    "-i",
                    "pipe:0",
                    "-i",
                    str(video),
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0?",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "22",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "160k",
                    "-t",
                    str(duration),
                    "-movflags",
                    "+faststart",
                    "-metadata:s:v:0",
                    "rotate=0",
                    str(temporary_output),
                ],
                stdin=subprocess.PIPE,
                stderr=encode_error,
            )
            try:
                assert decoder.stdout is not None and encoder.stdin is not None
                frame_bytes = camera_width * camera_height * 3
                while True:
                    data = bytearray()
                    while len(data) < frame_bytes:
                        block = decoder.stdout.read(frame_bytes - len(data))
                        if not block:
                            break
                        data.extend(block)
                    if not data:
                        break
                    if len(data) != frame_bytes:
                        raise RuntimeError("Truncated decoded camera frame")
                    timestamp = total / render_fps
                    if timestamp > duration:
                        break
                    camera = Image.frombytes("RGB", (camera_width, camera_height), bytes(data))
                    composed = renderer.compose(camera, timestamp)
                    if total == 0:
                        composed.save(preview, quality=92)
                    if not renderer.preview_written and timestamp >= min(54.0, duration / 2):
                        composed.save(preview, quality=92)
                        renderer.preview_written = True
                    encoder.stdin.write(composed.tobytes())
                    total += 1
                    if total % max(1, round(render_fps * 10)) == 0:
                        print(
                            json.dumps(
                                {
                                    "rendered_seconds": round(timestamp, 1),
                                    "duration_seconds": duration,
                                }
                            ),
                            flush=True,
                        )
                encoder.stdin.close()
                decoder.stdout.close()
                decode_status = decoder.wait()
                encode_status = encoder.wait()
                if decode_status or encode_status:
                    raise RuntimeError(
                        "Video render failed: " + decoder_log.read_text() + encoder_log.read_text()
                    )
            except BaseException:
                decoder.kill()
                encoder.kill()
                decoder.wait()
                encoder.wait()
                temporary_output.unlink(missing_ok=True)
                raise
    temporary_output.replace(output)
    result = {
        "output": str(output),
        "preview": str(preview),
        "render_fps": render_fps,
        "analysis_fps": renderer.sample_fps,
        "rendered_frames": total,
        "source_duration_seconds": duration,
        "source_video_unchanged": True,
        "camera_rotation": "ffmpeg display-matrix autorotation",
        "position_interpretation": "approximate nearest known photo stop; not verified camera pose",
        "breadcrumb_interpretation": (
            "35-second supported retrieval history, using only open exported "
            "walking-support edges; gaps across uncertain intervals"
        ),
        "audio": "original audio re-encoded to AAC when present",
    }
    (output.parent / "render-summary.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, type=Path)
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--render-fps", type=float, default=10.0)
    arguments = parser.parse_args()
    result = render_video(
        arguments.run.resolve(),
        arguments.video.resolve(),
        arguments.output.resolve(),
        render_fps=arguments.render_fps,
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
