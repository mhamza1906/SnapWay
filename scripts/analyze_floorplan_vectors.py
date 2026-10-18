"""Read-only SVG/visual audit; run from repository root using the existing venv.

First render SVG via installed apps/pipeline sharp, as documented in the report.
This measures dark-paint fidelity, not walls, room topology or route accuracy.
"""

import argparse
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--out", type=Path, default=ROOT / "local/test-results/figma-vectorization-replay"
)
OUT = parser.parse_args().out.resolve()
if not OUT.is_relative_to((ROOT / "local").resolve()):
    parser.error("Replay output must stay under ignored local/")
OUT.mkdir(parents=True, exist_ok=True)
EVIDENCE = ROOT / "docs/audits/assets/2026-10-17-figma-vectorization"
SVG = EVIDENCE / "figma-vector.svg"
BASE = ROOT / "docs/audits/assets/2026-10-17-gpt-fullchain"
SOURCE = BASE / "optimized-floor.png"


def rgb(path):
    im = Image.open(path).convert("RGBA")
    bg = Image.new("RGBA", im.size, "white")
    bg.alpha_composite(im)
    return np.asarray(bg.convert("RGB"))


source = rgb(SOURCE)
images = {
    "figma": rgb(EVIDENCE / "rendered.png"),
    "gpt_whole": rgb(BASE / "gpt-structure/vector.png"),
    "gemini_whole": rgb(BASE / "gemini-structure/vector.png"),
}
assert source.shape == (1024, 1536, 3)
assert all(im.shape == source.shape for im in images.values())
root = ET.parse(SVG).getroot()
paths = list(root)
commands = Counter(c for p in paths for c in re.findall("[MmLlHhVvCcSsQqTtAaZz]", p.get("d", "")))
tags = Counter(p.tag.split("}")[-1] for p in root.iter())
attributes = Counter(k for p in root.iter() for k in p.attrib)
fills = Counter(p.get("fill") for p in paths)
roi = (15, 140, 1530, 835)
x0, y0, x1, y1 = roi


def mask(im, threshold):
    # All RGB channels below threshold: avoids classifying saturated colors as black.
    return np.max(im[y0:y1, x0:x1], axis=2) < threshold


def metrics(a, b):
    intersection = np.logical_and(a, b).sum()
    da = cv2.distanceTransform((~a).astype("uint8"), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    db = cv2.distanceTransform((~b).astype("uint8"), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    precision = float(np.mean(da[b] <= 2))
    recall = float(np.mean(db[a] <= 2))
    return {
        "input_dark_pixels": int(a.sum()),
        "candidate_dark_pixels": int(b.sum()),
        "iou": float(intersection / np.logical_or(a, b).sum()),
        "precision_within_2px": precision,
        "recall_within_2px": recall,
        "f1_within_2px": 2 * precision * recall / (precision + recall),
        "input_to_candidate_distance_px_median": float(np.median(db[a])),
        "input_to_candidate_distance_px_p95": float(np.percentile(db[a], 95)),
    }


timing_note = (
    "User-supplied output, no instrumented Figma run; render time is not vectorization time."
)
result = {
    "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    "svg_sha256": hashlib.sha256(SVG.read_bytes()).hexdigest(),
    "svg_bytes": SVG.stat().st_size,
    "canvas": [1536, 1024],
    "tags": dict(tags),
    "attributes": dict(attributes),
    "unique_path_fills": len(fills),
    "path_commands": dict(commands),
    "compound_paths": sum(len(re.findall("M", p.get("d", ""))) > 1 for p in paths),
    "paths_with_closed_subpaths": sum("Z" in p.get("d", "") for p in paths),
    "roi_xyxy": list(roi),
    "method": (
        "Native pixel frame, no registration/resize; composite RGBA on white; "
        "max(R,G,B)<threshold; Euclidean tolerance 2px. Visual dark-paint metric only; "
        "prior LLM render includes labels and presentation colors. "
        "Not semantic or navigation accuracy."
    ),
    "conditions": {
        name: {str(t): metrics(mask(source, t), mask(im, t)) for t in (80, 96, 128)}
        for name, im in images.items()
    },
    "timing": {
        "figma_vectorization_seconds": None,
        "figma_credits": None,
        "note": timing_note,
    },
}
(OUT / "metrics.json").write_text(
    json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
Image.fromarray(images["figma"]).save(OUT / "rendered-white.png")
# Green input-only, magenta vector-only, dark overlap. Exact-pixel evidence, not tolerance.
a = mask(source, 96)
b = mask(images["figma"], 96)
overlay = np.full((*a.shape, 3), 255, dtype="uint8")
overlay[a & b] = (35, 35, 35)
overlay[a & ~b] = (0, 160, 120)
overlay[b & ~a] = (210, 0, 170)
Image.fromarray(overlay).save(OUT / "dark-paint-overlay.png")

panels = [
    ("GPT optimized input", source),
    ("Figma vector rendered on white", images["figma"]),
    ("GPT 6.1 whole-vector proposal", images["gpt_whole"]),
    ("Gemini 4 whole-vector proposal", images["gemini_whole"]),
]
montage = Image.new("RGB", (1536, 1080), "#eef0f3")
d = ImageDraw.Draw(montage)
for i, (title, im) in enumerate(panels):
    x = (i % 2) * 768
    y = (i // 2) * 540
    d.text((x + 14, y + 10), title, fill="black")
    montage.paste(Image.fromarray(im).resize((768, 512), Image.Resampling.LANCZOS), (x, y + 28))
montage.save(OUT / "comparison.jpg", quality=90)
regions = [
    ("Upper stair treads / cyan shaft", (620, 200, 790, 340)),
    ("Door arc and wall near room", (1110, 280, 1235, 370)),
    ("Lecture seating", (1030, 420, 1200, 665)),
]
detail = Image.new("RGB", (1200, 900), "#eef0f3")
d = ImageDraw.Draw(detail)
for i, (name, box) in enumerate(regions):
    for j, (label, im) in enumerate([("Input", source), ("Figma", images["figma"])]):
        x = j * 600
        y = i * 300
        d.text((x + 10, y + 8), name + " - " + label, fill="black")
        crop = Image.fromarray(im).crop(box)
        crop.thumbnail((570, 265), Image.Resampling.NEAREST)
        detail.paste(
            crop.resize(
                (
                    int(crop.width * min(570 / crop.width, 265 / crop.height)),
                    int(crop.height * min(570 / crop.width, 265 / crop.height)),
                ),
                Image.Resampling.NEAREST,
            ),
            (x + 12, y + 30),
        )
detail.save(OUT / "details.jpg", quality=93)
print(
    json.dumps(
        {
            "structure": {
                k: result[k]
                for k in [
                    "svg_bytes",
                    "tags",
                    "unique_path_fills",
                    "compound_paths",
                    "paths_with_closed_subpaths",
                ]
            },
            "threshold96": {k: v["96"] for k, v in result["conditions"].items()},
        },
        indent=2,
    )
)
