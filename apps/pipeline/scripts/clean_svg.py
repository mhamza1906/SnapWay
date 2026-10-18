"""Clean a vectorizer.ai floor-plan SVG into a three-colour plan image.

No image models: plain SVG parsing, rsvg-convert and OpenCV. Claude's close
reading of the same SVG (scripts/analyze-svgs.js) supplies which colours are
walls, corridors and noise, and which shapes are noise.

Output PNG (SCALE x the SVG units): walls black, corridors flat grey #D8D8D8,
everything else white, cropped to the building outline. This is the input the
raster room finder (server/pipelines/raster-rooms.js) expects.

Usage (from the repo root):
  uv run --extra geometry python apps/pipeline/scripts/clean_svg.py <svg> <analysis.json> <out.png>
"""

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

SCALE = 3
WALL, CORRIDOR, WHITE, DROP = "#000000", "#d8d8d8", "#ffffff", None
# Noise kinds whose shapes are removed outright (the rest are painted by colour).
DROP_KINDS = {
    "leader-line",
    "fire-equipment",
    "text-glyphs",
    "glare-or-shadow",
    "other",
    "you-are-here",
    "legend",
}
# Free-standing dark blobs smaller than this (SVG units) are text or marks, not walls.
GLYPH_MAX_UNITS = 30
THIN_HALF_UNITS = 1.3  # lines thinner than 2.6 units are hairlines, not walls
HEX = re.compile(r"#[0-9a-fA-F]{6}")


def shapes_of(svg):
    """(id, tag, attrs) in the same order as compactSvg in server/svg-analysis.js."""
    out = [("path", m) for m in re.finditer(r"<path\b[^>]*?/?>", svg)]
    out += [(m.group(1), m) for m in re.finditer(r"<(rect|ellipse)\b[^>]*?/?>", svg)]
    return [(f"p{i + 1}", tag, m) for i, (tag, m) in enumerate(out)]


def luminance(colour):
    r, g, b = (int(colour[i : i + 2], 16) for i in (1, 3, 5))
    return 0.299 * r + 0.587 * g + 0.114 * b


def colour_classes(analysis):
    """Fill colour -> class: Claude's role for the colour, checked against how
    dark the colour actually is (a light room floor is never a wall)."""
    classes = {}
    for role in analysis["colourRoles"]:
        if "fill" not in role["usage"]:
            continue
        text = role["role"].lower()
        for colour in HEX.findall(role["colour"]):
            colour, lum = colour.lower(), luminance(colour)
            if "wall" in text and lum < 95:
                cls = WALL
            elif any(k in text for k in ("fire", "leader", "arrow", "exit", "red ", "tag")):
                cls = DROP
            elif (
                any(k in text for k in ("corridor", "circulation", "concourse")) and 80 <= lum < 170
            ):
                cls = CORRIDOR
            else:
                cls = fallback_class(colour)
            classes.setdefault(colour, cls)
    return classes


def fallback_class(colour):
    """A fill colour without a clear role: dark (charcoal or black) is wall,
    red is noise, else white. Corridor mauve is about 115 and room floors
    about 175, so 90 separates them."""
    r, g, b = (int(colour[i : i + 2], 16) for i in (1, 3, 5))
    if r > g + 40 and r > b + 40:
        return DROP
    return WALL if luminance(colour) < 90 else WHITE


def recolour(svg, analysis):
    classes, dropped = colour_classes(analysis), set()
    for group in analysis["noise"]:
        if group["kind"] in DROP_KINDS:
            dropped.update(group["shapeIds"])
    keep, counts = [], {"wall": 0, "corridor": 0, "white": 0, "dropped": 0}
    for sid, _tag, m in shapes_of(svg):
        el = m.group(0)
        fill = re.search(r'fill="(#[0-9a-fA-F]{6})"', el)
        if not fill or sid in dropped:  # stroke-only shapes are anti-aliasing edges
            counts["dropped"] += 1
            continue
        colour = fill.group(1).lower()
        cls = classes.get(colour, fallback_class(colour))
        if cls is DROP:
            counts["dropped"] += 1
            continue
        counts[{WALL: "wall", CORRIDOR: "corridor", WHITE: "white"}[cls]] += 1
        el = re.sub(r'fill="#[0-9a-fA-F]{6}"', f'fill="{cls}"', el)
        el = re.sub(r'\s(stroke|vector-effect)="[^"]*"', "", el)
        keep.append(el)
    vb = re.search(r'viewBox="([^"]+)"', svg).group(1)
    return (
        (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" shape-rendering="crispEdges">'
            '<rect x="-10000" y="-10000" width="30000" height="30000" fill="#ffffff"/>'
            f"{''.join(keep)}</svg>"
        ),
        [float(v) for v in vb.split()],
        counts,
    )


def render(svg, width):
    with tempfile.TemporaryDirectory() as tmp:
        src, png = Path(tmp, "in.svg"), Path(tmp, "out.png")
        src.write_text(svg)
        subprocess.run(["rsvg-convert", "-w", str(width), str(src), "-o", str(png)], check=True)
        return cv2.imread(str(png), cv2.IMREAD_GRAYSCALE)


def remove_leader_lines(img):
    """Leader lines run from symbols outside the building, straight and at an
    angle, into the plan, merged with the walls. Find long, thin straight lines
    well off the wall axes and erase their whole run, keeping the axis-aligned
    walls they cross."""
    walls = (img == 0).astype(np.uint8)
    k = 8 * SCALE
    straight = cv2.morphologyEx(
        walls, cv2.MORPH_OPEN, np.ones((1, k), np.uint8)
    ) | cv2.morphologyEx(walls, cv2.MORPH_OPEN, np.ones((k, 1), np.uint8))
    angled = walls & (1 - straight)
    found = cv2.HoughLinesP(
        angled * 255, 1, np.pi / 360, 40, minLineLength=25 * SCALE, maxLineGap=3 * SCALE
    )
    erase = np.zeros(walls.shape, np.uint8)
    h, w = walls.shape
    near = cv2.dilate(walls, np.ones((5, 5), np.uint8))
    half = cv2.dilate(cv2.distanceTransform(walls, cv2.DIST_L2, 3), np.ones((3, 3), np.uint8))
    leaders = 0
    for ax, ay, bx, by in found[:, 0] if found is not None else []:
        angle = abs(np.degrees(np.arctan2(by - ay, bx - ax))) % 90
        if min(angle, 90 - angle) < 10:
            continue
        # Thin: leader lines and the X marks across voids are hairlines; walls
        # are drawn thicker (half-thickness from the distance transform).
        n = max(2, int(np.hypot(bx - ax, by - ay)))
        xs, ys = (
            np.linspace(ax, bx, n).round().astype(int),
            np.linspace(ay, by, n).round().astype(int),
        )
        if np.median(half[ys.clip(0, h - 1), xs.clip(0, w - 1)]) > THIN_HALF_UNITS * SCALE:
            continue
        # Follow the line both ways while there is ink along it (gaps up to 4 units).
        d = np.array([bx - ax, by - ay], float)
        d /= np.linalg.norm(d)
        run = []
        for sign in (1, -1):
            gap, t = 0, 0.0
            start = np.array([ax, ay], float) if sign == 1 else np.array([bx, by], float)
            direction = d * sign
            while gap < 4 * SCALE:
                px, py = (start + direction * t).round().astype(int)
                if not (0 <= px < w and 0 <= py < h):
                    break
                if near[py, px]:
                    run.append((px, py))
                    gap = 0
                else:
                    gap += 1
                t += 1
        for px, py in run:
            cv2.circle(erase, (int(px), int(py)), int(2 * SCALE), 1, -1)
        leaders += 1
    # Also every other piece of thin ink that is not an axis-aligned wall:
    # seating rows, hatching and arcs inside halls.
    thin = (walls & (1 - straight) & (half <= THIN_HALF_UNITS * SCALE)).astype(np.uint8)
    thick_core = (walls & (half > THIN_HALF_UNITS * SCALE)).astype(np.uint8)
    # Keep the ends where thin ink runs into a thick wall (wall corners and joints).
    joints = cv2.dilate(thick_core, np.ones((2 * SCALE + 1, 2 * SCALE + 1), np.uint8))
    mask = ((erase | thin) & walls & (1 - straight) & (1 - joints)).astype(np.uint8)
    if mask.any():
        # Erased ink takes the colour most common around it: corridor grey or white.
        keep = mask == 0
        box = (9 * SCALE, 9 * SCALE)
        grey = cv2.blur(((img == 216) & keep).astype(np.float32), box)
        white = cv2.blur(((img == 255) & keep).astype(np.float32), box)
        img = np.where(mask > 0, np.where(grey > white, 216, 255), img).astype(np.uint8)
    return img, leaders


def clean_raster(gray, analysis):
    # Snap to three levels: wall, corridor, white.
    img = np.full(gray.shape, 255, np.uint8)
    img[gray < 100] = 0
    img[(gray >= 100) & (gray <= 240)] = 216
    # Everything outside the building outline (with a 3-unit margin) is board.
    x, y, w, h = analysis["outline"]["bbox"]
    pad = 3
    x0, y0 = max(0, int((x - pad) * SCALE)), max(0, int((y - pad) * SCALE))
    x1, y1 = (
        min(img.shape[1], int((x + w + pad) * SCALE)),
        min(img.shape[0], int((y + h + pad) * SCALE)),
    )
    img, leaders = remove_leader_lines(img)
    outside = np.ones(img.shape, bool)
    outside[y0:y1, x0:x1] = False
    img[outside] = 255
    # Small dark blobs not part of the wall network are text glyphs: fill each
    # with the colour around it (white in rooms, grey in corridors).
    walls = (img == 0).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(walls, connectivity=8)
    limit = GLYPH_MAX_UNITS * SCALE
    glyphs = 0
    for k in range(1, n):
        bw, bh = stats[k, cv2.CC_STAT_WIDTH], stats[k, cv2.CC_STAT_HEIGHT]
        if max(bw, bh) >= limit:
            continue
        blob = labels == k
        ring = cv2.dilate(blob.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & ~blob
        around = img[ring]
        img[blob] = 216 if (around == 216).sum() > (around == 255).sum() else 255
        glyphs += 1
    return img, glyphs, leaders


def main():
    svg_path, analysis_path, out_path = sys.argv[1:4]
    svg = Path(svg_path).read_text()
    analysis = json.loads(Path(analysis_path).read_text())
    recoloured, vb, counts = recolour(svg, analysis)
    gray = render(recoloured, int(round(vb[2] * SCALE)))
    img, glyphs, leaders = clean_raster(gray, analysis)
    cv2.imwrite(out_path, img)
    print(
        json.dumps(
            {
                "out": out_path,
                "scale": SCALE,
                "size": [img.shape[1], img.shape[0]],
                "shapes": counts,
                "glyphBlobsRemoved": glyphs,
                "leaderLinesRemoved": leaders,
            }
        )
    )


if __name__ == "__main__":
    main()
