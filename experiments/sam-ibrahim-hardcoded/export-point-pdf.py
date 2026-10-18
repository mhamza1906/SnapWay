"""Create a source-aligned printable point plan using prepared local asset metadata.

Run with the bundled PDF Python runtime: export-point-pdf.py OUTPUT_FOLDER.
Requires existing reportlab, pypdf and Pillow; no application dependency changes.
"""

import hashlib
import json
import math
import sys
from pathlib import Path

from pypdf import PdfReader
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfgen import canvas

INK = HexColor("#203c36")
MUTED = HexColor("#52665f")
BLUE = HexColor("#2468a0")
ORANGE = HexColor("#b95c24")
GREEN = HexColor("#28765a")
W, H = landscape(A3)


def text(pdf, x, y, value, size=10, color=INK, bold=False):
    pdf.setFillColor(color)
    pdf.setFont("Helvetica-Bold" if bold else "Helvetica", size)
    pdf.drawString(x, y, str(value).replace("\u00b7", "|").replace("\u2013", "-"))


def footer(pdf, page, total):
    text(
        pdf,
        36,
        22,
        "Sam Ibrahim | Source-aligned capture plan | Field positions to be confirmed",
        9,
        MUTED,
    )
    text(pdf, W - 200, 22, f"October 18, 2026 | {page}/{total}", 9, MUTED)


def legend(pdf, y):
    for x, color, label in [
        (36, GREEN, "Four views uploaded"),
        (232, BLUE, "Existing stop"),
        (390, ORANGE, "Added stop - collect four views"),
    ]:
        pdf.setFillColor(color)
        pdf.circle(x + 5, y + 3, 5, fill=1, stroke=0)
        text(pdf, x + 18, y, label, 10, MUTED)


def badges(points, positions, rect):
    placed = []
    radius = 7
    left, bottom, width, height = rect
    for point in points:
        anchor = positions[point["order"]]
        offsets = [(0, 0)] + [
            (d * math.cos(a), d * math.sin(a))
            for d in (16, 25, 35, 46)
            for a in [i * math.pi / 4 for i in range(8)]
        ]
        choice = None
        for dx, dy in offsets:
            x, y = anchor[0] + dx, anchor[1] + dy
            if (
                not left + radius <= x <= left + width - radius
                or not bottom + radius <= y <= bottom + height - radius
            ):
                continue
            if all(math.hypot(x - px, y - py) >= 2 * radius + 1 for _, _, (px, py) in placed):
                choice = (x, y)
                break
        if choice is None:
            raise ValueError(f"Cannot place a legible label for Point {point['order']}")
        placed.append((point, anchor, choice))
    return placed


def build(folder):
    data = json.loads((folder / "point-plan.json").read_text())
    output = folder / "Sam_Ibrahim_Photo_Points_40.pdf"
    pdf = canvas.Canvas(str(output), pagesize=(W, H), pageCompression=1)
    pdf.setTitle("Sam Ibrahim - Photo capture points - 40-stop ceiling")
    pdf.setAuthor("SnapWay")
    pdf.setSubject(
        "Numbered capture stops on original floor plans; preserved IDs and upload snapshot"
    )
    total = len(data["walks"]) + 1
    text(pdf, 36, H - 62, "SAM IBRAHIM", 13, GREEN, True)
    text(pdf, 36, H - 110, "Photo capture points", 34, INK, True)
    text(
        pdf,
        36,
        H - 145,
        f"40-point cap | {len(data['walks'])} circulation walks | "
        f"{data['totalPoints']} active stops",
        16,
    )
    text(
        pdf,
        36,
        H - 174,
        f"{data['addedPoints']} added stops. "
        "Existing point numbers and uploaded photographs are preserved.",
        12,
        MUTED,
    )
    legend(pdf, H - 213)
    y = H - 268
    columns = [36, 142, 600, 700, 800, 910]
    for x, label in zip(
        columns, ["FLOOR", "CIRCULATION", "PREVIOUS", "NOW", "ADDED", "VIEWS"], strict=True
    ):
        text(pdf, x, y, label, 10, MUTED, True)
    for walk in data["walks"]:
        y -= 29
        pdf.setStrokeColor(HexColor("#dbe3df"))
        pdf.line(36, y - 8, W - 36, y - 8)
        values = [
            walk["floor"],
            walk["title"].split("\u00b7")[-1].strip(),
            walk["previousPoints"],
            len(walk["points"]),
            sum(p["added"] for p in walk["points"]),
            4 * len(walk["points"]),
        ]
        for x, value in zip(columns, values, strict=True):
            text(pdf, x, y, value, 12)
    y -= 57
    for line in [
        "At each added stop, capture front, right, back and left views. "
        "Checkboxes show the upload snapshot at generation time.",
        "Point numbers restart for each circulation. Gaps in numbering are intentional: "
        "retired stop numbers are not reused.",
        "Level 1 has 40 active stops; Points 5, 6, 23 and 30 remain retired. "
        "Added stops are numbered 31-44.",
        "Thin label leaders end at the exact planned stop. Maps use source plan coordinates; "
        "no verified metre scale is available.",
        "Door openings and floor connectors retain their existing inferred status. "
        "This PDF does not verify physical access.",
    ]:
        text(pdf, 36, y, line, 11, MUTED)
        y -= 21
    footer(pdf, 1, total)
    pdf.showPage()
    placement_info = []
    for page, walk in enumerate(data["walks"], start=2):
        text(pdf, 36, H - 48, walk["title"], 25, INK, True)
        text(
            pdf,
            36,
            H - 75,
            f"{len(walk['points'])} active stops | "
            f"{sum(p['added'] for p in walk['points'])} added | "
            "40-stop ceiling | 4 views per stop",
            12,
            MUTED,
        )
        legend(pdf, H - 99)
        if walk["floorId"] == "L1":
            text(pdf, 790, H - 99, "Retired: 5, 6, 23, 30. New: 31-44.", 10, MUTED)
        rect = (36, 259, W - 72, 453)
        x, y, width, height = rect
        scale = min((width - 20) / walk["width"], (height - 20) / walk["height"])
        mx = x + (width - scale * walk["width"]) / 2
        my = y + (height - scale * walk["height"]) / 2

        def transform(p, mx=mx, my=my, scale=scale, source_height=walk["height"]):
            return mx + p["x"] * scale, my + (source_height - p["y"]) * scale

        pdf.drawImage(
            str(folder / walk["background"]), mx, my, walk["width"] * scale, walk["height"] * scale
        )
        pdf.setStrokeColor(BLUE)
        pdf.setLineWidth(1.8)
        for a, b in walk["segments"]:
            pdf.line(*transform(a), *transform(b))
        positions = {point["order"]: transform(point) for point in walk["points"]}
        placements = badges(walk["points"], positions, rect)
        for point, anchor, label in placements:
            if math.dist(anchor, label) > 0.1:
                pdf.setStrokeColor(MUTED)
                pdf.setLineWidth(0.55)
                pdf.line(*anchor, *label)
                pdf.setFillColor(INK)
                pdf.circle(*anchor, 1.8, fill=1, stroke=0)
            color = (
                ORANGE
                if point["added"]
                else GREEN
                if len(point["uploadedDirections"]) == 4
                else BLUE
            )
            pdf.setFillColor(color)
            pdf.setStrokeColor(white)
            pdf.setLineWidth(0.8)
            pdf.circle(*label, 7, fill=1, stroke=1)
            pdf.setFillColor(white)
            pdf.setFont("Helvetica-Bold", 8.5)
            pdf.drawCentredString(label[0], label[1] - 2.8, str(point["order"]))
        text(
            pdf,
            36,
            237,
            "Capture checklist | F = front, R = right, B = back, L = left | "
            "Filled boxes = uploaded views",
            10,
            MUTED,
        )
        per_column = math.ceil(len(walk["points"]) / 4)
        for index, point in enumerate(walk["points"]):
            column, row = divmod(index, per_column)
            cx, cy = 36 + column * ((W - 72) / 4), 211 - row * 15
            text(
                pdf,
                cx,
                cy,
                f"Point {point['order']}" + (" NEW" if point["added"] else ""),
                9,
                ORANGE if point["added"] else INK,
                point["added"],
            )
            for offset, (direction, letter) in enumerate(
                zip(["front", "right", "back", "left"], "FRBL", strict=True)
            ):
                bx = cx + 91 + offset * 35
                pdf.setStrokeColor(MUTED)
                pdf.setLineWidth(0.5)
                pdf.setFillColor(GREEN if direction in point["uploadedDirections"] else white)
                pdf.rect(bx, cy - 1, 6, 6, fill=1, stroke=1)
                text(pdf, bx + 9, cy, letter, 8, MUTED)
        footer(pdf, page, total)
        pdf.showPage()
        placement_info.append(
            {
                "floor": walk["floor"],
                "points": len(placements),
                "leaders": sum(math.dist(a, b) > 0.1 for _, a, b in placements),
            }
        )
    pdf.save()
    reader = PdfReader(output)
    assert len(reader.pages) == total
    for page, walk in zip(reader.pages[1:], data["walks"], strict=True):
        content = page.extract_text()
        for point in walk["points"]:
            assert (
                f"Point {point['order']}\n" in content or f"Point {point['order']} NEW" in content
            ), (walk["title"], point["order"])
    report = {
        "filename": output.name,
        "pages": total,
        "bytes": output.stat().st_size,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "ceiling": 40,
        "walks": len(data["walks"]),
        "points": data["totalPoints"],
        "added": data["addedPoints"],
        "placements": placement_info,
    }
    (folder / "pdf-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == "__main__":
    build(Path(sys.argv[1]).resolve())
