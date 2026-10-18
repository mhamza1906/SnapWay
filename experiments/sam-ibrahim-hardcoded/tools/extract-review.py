#!/usr/bin/env python3
"""Reproduce the checked-in PDF inventory; not part of application runtime.

Requires pypdf (and Pillow for PDF raster extraction) only when rerun. No model,
network, application imports, environment files, or source-image modifications.
Usage: python extract-review.py --source-root /path/to/Hack_The_valley
"""

import argparse
import hashlib
import json
import re
from pathlib import Path

DOCUMENT_ID = "sam-ibrahim-review-pdf"
PDF_NAME = "Sam_Ibrahim_Indoor_Navigation_Review.pdf"
FLOORS = [
    ("L5", "Level 5", 105, 95, 12, 20, 3),
    ("L4", "Level 4", 115, 108, 21, 30, 4),
    ("L3", "Level 3", 41, 35, 31, 34, 5),
    ("L2", "Level 2", 39, 36, 35, 38, 6),
    ("L1", "Level 1", 34, 29, 39, 41, 7),
    ("LB", "Level B", 32, 27, 42, 44, 8),
]
EXPECTED_SOURCE_SHA256 = "7891a1bc9bc7e43d4726fbd4bc76b6126040f85d0d1e8d89e6ba6c980a0187fa"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def evidence(page, kind="printed-inventory"):
    return {"documentId": DOCUMENT_ID, "page": page, "kind": kind}


def extract_inventory(reader):
    floors, portals, ids = [], {}, set()
    for floor_id, label, region_count, portal_count, start, end, image_page in FLOORS:
        frame_id = f"{floor_id}:report-crop-normalized"
        regions = []
        for page_number in range(start, end + 1):
            page_rows = []
            text = reader.pages[page_number - 1].extract_text(extraction_mode="layout")
            for line in text.splitlines():
                if not re.match(r"^L(?:[1-5]|B)-", line.strip()):
                    continue
                parts = re.split(r"\s{2,}", line.strip())
                if len(parts) != 5:
                    raise ValueError(f"Page {page_number}: expected five columns, got {parts!r}")
                region_id, name, feature_type, center, portal_text = parts
                if region_id in ids or not region_id.startswith(floor_id + "-"):
                    raise ValueError(f"Duplicate or wrong-floor ID: {region_id}")
                ids.add(region_id)
                match = re.fullmatch(r"(0\.\d{3}), (0\.\d{3})", center)
                if not match:
                    raise ValueError(f"Invalid center: {region_id}: {center}")
                x, y = map(float, match.groups())
                source_portals = [] if portal_text == "none resolved" else portal_text.split(", ")
                if not all(re.fullmatch(r"[PX]\d{2,3}", p) for p in source_portals):
                    raise ValueError(f"Invalid portal references: {region_id}: {portal_text}")
                portal_ids = [f"{floor_id}:{p}" for p in source_portals]
                region = {
                    "id": region_id,
                    "sourceId": region_id,
                    "displayOriginalId": region_id,
                    "floorId": floor_id,
                    "name": name,
                    "featureType": feature_type,
                    "center": {"x": x, "y": y},
                    "coordinateFrameId": frame_id,
                    "portalIds": portal_ids,
                    "sourcePortalIds": source_portals,
                    "sourcePortalText": portal_text,
                    "evidence": evidence(page_number),
                    "reviewStatus": "agent-inspected",
                    "interpretationStatus": "unverified",
                    "geometry": None,
                    "confidence": {
                        "basis": "transcribed printed inventory",
                        "humanVerified": False,
                    },
                }
                if "user confirmed" in feature_type:
                    region["confidence"]["sourceClaim"] = feature_type
                    region["confidence"]["sourceClaimMeaning"] = (
                        "Quoted report classification of feature identity only; this extraction "
                        "does not establish human review, accessible endpoints, or a routable connection."
                    )
                regions.append(region)
                page_rows.append(region)
                for source_id, portal_id in zip(source_portals, portal_ids):
                    portal = portals.setdefault(portal_id, {
                        "id": portal_id,
                        "sourceId": source_id,
                        "displayOriginalId": source_id,
                        "floorId": floor_id,
                        "regionIds": [],
                        "position": None,
                        "coordinateFrameId": frame_id,
                        "kind": "exterior-exit-observation" if source_id.startswith("X") else "doorway-candidate",
                        "interpretationStatus": "unverified",
                        "reviewStatus": "agent-inspected",
                        "evidence": [],
                    })
                    portal["regionIds"].append(region_id)
                    portal["evidence"].append(evidence(page_number))
            page_range = re.search(r"Rows (\d+)-(\d+) of (\d+)", text)
            if not page_range or len(page_rows) != int(page_range[2]) - int(page_range[1]) + 1:
                raise ValueError(f"Page {page_number} row count does not match its printed heading")
        if len(regions) != region_count:
            raise ValueError(f"{floor_id}: expected {region_count} regions, got {len(regions)}")
        floor_portals = [p for p in portals.values() if p["floorId"] == floor_id]
        if len(floor_portals) != portal_count:
            raise ValueError(f"{floor_id}: expected {portal_count} portals, got {len(floor_portals)}")
        floors.append({
            "id": floor_id, "label": label,
            "expectedRegionCount": region_count, "expectedPortalCount": portal_count,
            "inventoryPages": {"first": start, "last": end},
            "overviewPage": image_page, "coordinateFrameId": frame_id, "regions": regions,
        })
    if len(ids) != 366 or len(portals) != 330:
        raise ValueError("Document totals disagree with the reviewed PDF")
    return {
        "schemaVersion": 1,
        "sourceDocumentId": DOCUMENT_ID,
        "inventoryPageRange": {"first": 12, "last": 44},
        "reviewStatus": "agent-inspected",
        "floors": floors,
        "portals": list(portals.values()),
        "totals": {"floors": 6, "regions": 366, "portalCandidates": 330, "verifiedCrossFloorEdges": 0},
        "limitations": [
            "Region centers are approximate annotation locations, never vertices of a walkable polygon or doorway coordinates.",
            "No PDF table supplies portal positions, region boundary vertices, landing elevations, or per-floor metric scale.",
            "none resolved means no portal reference was resolved in the report; it does not prove that a physical room has no doorway.",
            "Feature type strings are verbatim source claims, including user confirmed; all records remain agent-inspected and physically unverified.",
            "A repeated physical room depiction does not imply another entrance or usable cross-floor connection.",
            "Annotation rectangles may overlap; their footprints must not be imported as walkable geometry.",
            "Portal identifiers are namespaced by floor because printed labels repeat across drawings.",
        ],
    }


def extract_questions(reader):
    text = reader.pages[10].extract_text()
    matches = re.findall(r"(Q\d{2})\s+(.+?)(?=\nQ\d{2}\s|\Z)", text, flags=re.S)
    questions = []
    blockers = {
        "Q01": ["L3-R07"], "Q02": ["L3-OS01"], "Q03": ["L2-R08", "L3-R08"],
        "Q04": ["L2-OS01", "L2-OS02", "L3-OS02", "L3-OS03", "L4-ST-DIAG"],
        "Q05": [], "Q06": [], "Q07": ["L1-SEXTRA", "LB-SEXTRA"],
        "Q08": [], "Q09": ["L4-RG-W", "L4-RG-E"], "Q10": [],
    }
    for question_id, body in matches:
        body = re.split(r"IMAGE-DERIVED DRAFT", body)[0]
        body = " ".join(body.split())
        questions.append({
            "id": question_id, "priority": int(question_id[1:]), "question": body,
            "status": "unresolved", "evidence": evidence(11, "review-priority"),
            "affectedRegionIds": blockers[question_id],
        })
    if [q["id"] for q in questions] != [f"Q{i:02d}" for i in range(1, 11)]:
        raise ValueError("Could not extract exactly Q01 through Q10")
    discrepancy_specs = [
        ("D01", "Cloud depiction and access", ["L2-R06", "L3-R07", "L3-OS01"], [1, 2, 5, 31, 34, 35],
         "Level 2 has P06 and P07; the Level 3 Cloud footprint has no resolved portal. Its continuous east boundary and adjacent external stair support a possible lower-room projection, not a Level 3 doorway. A void is not established either.",
         "Keep the Cloud physical identity distinct from its Level 3 depiction. Never copy L2 portals upward or join the adjacent stair directly to the room."),
        ("D02", "Conveyor name, suffix, and doorway reconciliation", ["L2-R08", "L3-R08"], [1, 5, 6, 10, 31, 35, 45],
         "The report corrects Connector to Conveyor. Its cited naming source uses IA2150 while the classroom inventory uses IA2150A. L2 has two portal candidates and L3 three; five observations do not establish five physical entrances. The cited inventory lists three entrances/exits.",
         "Retain each observed threshold separately with unresolved physical doorway identity and elevation until matched; preserve the suffix discrepancy."),
        ("D03", "Arrow Innovation Hall door totals", ["LB-R01"], [8, 10, 42, 45],
         "LB-R01 has four printed portal candidates P01-P04, while the cited IA-B1050 classroom entry lists two entrances/exits. Arrow Group Innovation Hall and Arrow Innovation Hall name variants refer to the report's proposed same room identity.",
         "Do not silently discard or accept candidate doors to make counts agree; reconcile against actual entrances."),
        ("D04", "Level 2 central stair evidence wording", ["L2-OS01", "L2-OS02"], [6, 38],
         "Page 6 describes both central stair features as user-identified, while page 38 labels only L2-OS01 open stair user confirmed; L2-OS02 remains open stair candidate.",
         "Preserve both source statements; no human review or landing connection is inferred by this extraction."),
        ("D05", "Level 5 exclusion count", ["L5-X1", "L5-X2", "L5-X3", "L5-X4", "L5-X5"], [3, 20],
         "The overview mentions four large crossed regions; the table contains five exclusion records including the smaller southwest-central L5-X5.",
         "Preserve all five table records; never inherit Level 4 roof-garden walkability into the Level 5 crossed side regions."),
        ("D06", "Ground-floor exit observation count", ["L1-C01", "L1-C03", "L1-C04", "L1-SA", "L1-SB", "L1-SD", "L1-SEXTRA", "L1-R11"], [7, 39, 40, 41],
         "The twelve X01-X12 observations include arrows and threshold groups; the report does not verify twelve independent physical doors.",
         "Keep exit observations as candidates until thresholds, vestibules, and exterior destinations are established."),
    ]
    discrepancies = [{
        "id": i, "title": title, "regionIds": regions, "evidence": [evidence(p, "report-discussion") for p in pages],
        "finding": finding, "requiredHandling": handling, "status": "unresolved",
    } for i, title, regions, pages, finding, handling in discrepancy_specs]
    official_counts = [
        ("IA-B1010", 1), ("IA-B1050", 2), ("IA-B1100", 2), ("IA1120", 1), ("IA1150", 3),
        ("IA1160", 1), ("IA2010", 1), ("IA2021", 2), ("IA2040", 2), ("IA2050", 2),
        ("IA2060", 2), ("IA2100", 1), ("IA2110", 1), ("IA2120", 1), ("IA2150A", 3),
        ("IA2160", 2), ("IA2170", 2), ("IA3050", 2), ("IA3060", 1), ("IA3120", 2),
    ]
    return {
        "schemaVersion": 1, "sourceDocumentId": DOCUMENT_ID, "questions": questions,
        "discrepancies": discrepancies,
        "officialDoorCountsAsQuotedByReport": [{"roomId": room, "entrancesExits": count, "evidence": evidence(10, "quoted-external-inventory")} for room, count in official_counts],
        "officialDoorCountTotal": sum(count for _, count in official_counts),
        "officialDoorCountLimitations": "Quoted from PDF, not freshly checked online; a completeness check, not doorway location, elevation, current access, or a building-wide count.",
        "otherUnresolvedRelationships": [
            {"regionIds": ["L1-R03", "LB-R04"], "status": "unresolved", "issue": "Right-hand tiered room may be depicted across different elevations; exact physical identity and entrance relationship not established.", "evidence": [evidence(8, "report-discussion")]},
            {"regionIds": ["L1-U01", "L1-U02", "L1-U03"], "status": "unresolved", "issue": "White regions are not established walkable Level 1 lobby surface.", "evidence": [evidence(7, "report-discussion"), evidence(40)]},
        ],
    }


def create_manifest(reader, root, pdf_bytes):
    from PIL import Image

    sources = [{
        "id": DOCUMENT_ID, "relativePath": PDF_NAME, "sha256": digest(pdf_bytes),
        "byteLength": len(pdf_bytes), "pageCount": len(reader.pages), "role": "primary-review-evidence",
        "attachmentNames": list(reader.attachments),
    }]
    frames = []
    for folder in ["sam-ibrahim-plans/original", "input/sam-ibrahim"]:
        for path in sorted((root / folder).glob("*")):
            if path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
                continue
            raw = path.read_bytes()
            with Image.open(path) as img:
                width, height = img.size
            relative = path.relative_to(root).as_posix()
            sources.append({
                "id": relative, "relativePath": relative, "sha256": digest(raw), "byteLength": len(raw),
                "pixelWidth": width, "pixelHeight": height,
                "role": "original-source-photo" if path.name == "board-photo.jpg" else "original-photo-crop",
            })
    for folder, variant in [("sam-ibrahim-plans/svg", "original"), ("sam-ibrahim-plans/clean-svg", "clean")]:
        for path in sorted((root / folder).glob("*.svg")):
            raw = path.read_bytes()
            text = raw.decode("utf-8")
            view_box_match = re.search(r'<svg\b[^>]*\bviewBox="([^"]+)"', text)
            if not view_box_match:
                raise ValueError(f"Missing SVG viewBox: {path.name}")
            view_box = [float(n) for n in re.split(r"[\s,]+", view_box_match[1].strip())]
            if len(view_box) != 4 or view_box[2] <= 0 or view_box[3] <= 0:
                raise ValueError(f"Invalid SVG viewBox: {path.name}")
            suffix = path.name.split("-")[1]
            floor_id = f"L{suffix}"
            relative = path.relative_to(root).as_posix()
            frame_id = f"{floor_id}:{variant}-svg-viewbox"
            sources.append({
                "id": relative, "relativePath": relative, "sha256": digest(raw), "byteLength": len(raw),
                "floorId": floor_id, "viewBox": view_box, "coordinateFrameId": frame_id,
                "role": "source-vectorized-original" if variant == "original" else "earlier-cleaned-vector-derivative",
                "originalPhotoCropId": f"sam-ibrahim-plans/original/Level-{suffix}-original.png",
                "evidenceLimitation": "SVG is a vectorized derivative; geometry identity and access must be checked against original photograph and PDF review.",
            })
            frames.append({
                "id": frame_id, "floorId": floor_id, "units": "svg-user-unit", "origin": "viewBox-origin",
                "xDirection": "right", "yDirection": "down", "viewBox": view_box,
                "sourceId": relative, "metricScale": None, "reportCropTransform": None,
                "transformStatus": "unregistered-to-report-crop",
            })
    embedded = []
    for floor_id, label, _, _, _, _, page_number in FLOORS:
        page = reader.pages[page_number - 1]
        images = list(page.images)
        if len(images) != 1:
            raise ValueError(f"Page {page_number}: expected one raster overlay")
        image = images[0]
        width, height = image.image.size
        embedded.append({
            "id": f"{floor_id}:report-overlay-raster", "documentId": DOCUMENT_ID,
            "page": page_number, "pdfImageName": image.name, "pixelWidth": width, "pixelHeight": height,
            "extractedPngSha256": digest(image.data), "annotationObjectCount": len(page.get("/Annots", [])),
            "content": "Original photo crop with burned-in colored boxes, labels, and portal dots.",
        })
        frames.append({
            "id": f"{floor_id}:report-crop-normalized", "floorId": floor_id,
            "units": "fraction", "origin": "top-left", "xDirection": "right", "yDirection": "down",
            "bounds": {"xMin": 0, "yMin": 0, "xMax": 1, "yMax": 1},
            "sourceDefinition": "Inventory heading: Coordinates are crop-relative fractions.",
            "reportOverlayRasterId": f"{floor_id}:report-overlay-raster",
            "reportOverlayPixelWidth": width, "reportOverlayPixelHeight": height,
            "metricScale": None,
            "sourceCropTransform": None,
            "transformStatus": "unregistered",
            "warning": "The companion JSON containing original-pixel references was not located. Report raster dimensions are recorded for inspection; direct scaling to either local crop set or board photo is not validated.",
        })
    analysis_paths = sorted((root / "sam-ibrahim-plans/analysis").glob("*.analysis.json"))
    return {
        "schemaVersion": 1,
        "externalSourceRoot": {"label": "Hack_The_valley", "resolution": "Resolve source relativePath against a caller-supplied source root. The PDF, photographic rasters, and earlier cleaned SVG derivatives remain external; six unchanged original SVGs are frozen locally through frozenGeometrySources."},
        "frozenGeometrySources": [{
            "sourceManifestId": source["id"],
            "floorId": source["floorId"],
            "relativePath": "source/" + Path(source["relativePath"]).name,
            "relativeTo": "experiment-root",
            "sha256": source["sha256"],
            "byteLength": source["byteLength"],
            "viewBox": source["viewBox"],
            "coordinateFrameId": source["coordinateFrameId"],
            "disposition": "Byte-for-byte frozen copy of the source vectorized original, used for offline geometry and shape-reference audits.",
        } for source in sources if source.get("role") == "source-vectorized-original"],
        "sources": sources, "coordinateFrames": frames, "embeddedRasters": embedded,
        "pdfResourceInspection": {
            "embeddedCompanionJsonFound": False,
            "floorOverlayPages": [3, 4, 5, 6, 7, 8],
            "floorOverlayFormat": "single embedded raster per floor; no PDF annotation objects",
            "geometricOverlayVectorsAvailable": False,
            "recoverableWithoutGuessing": ["all printed region IDs, labels, feature types, center fractions, and related portal IDs", "embedded annotated raster pixels"],
            "notSuppliedByPrintedTables": ["portal coordinates", "region bounding boxes or boundary polygons", "original-photo crop transforms", "walkable surfaces", "stair landing elevations", "verified cross-floor edges"],
        },
        "companionSearch": {
            "result": "not-found-in-scoped-local-search",
            "scope": ["PDF attachment names", "Hack_The_valley Sam-Ibrahim-related paths", "nearby hackathon paths with Sam Ibrahim, indoor review, or companion in their filename"],
            "olderAnalysisFilesFound": [p.relative_to(root).as_posix() for p in analysis_paths],
            "olderAnalysisDisposition": "Earlier model analyses of SVGs have different IDs and coordinate frames; they are not the missing PDF companion and are not imported as report geometry.",
            "reportReferencedOriginalPath": "source/original_poster.jpg",
            "reportReferencedOriginalPathLocated": (root / "source/original_poster.jpg").exists(),
            "limit": "This is a scoped local discovery result, not proof that no companion exists elsewhere.",
        },
        "reproduction": {"tool": "tools/extract-review.py", "dependencies": ["pypdf", "Pillow"], "runtimeRequirement": "Only needed for optional re-extraction; checked-in JSON and standalone navigation modules do not require Python or these packages."},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data")
    args = parser.parse_args()
    from pypdf import PdfReader

    root = args.source_root.resolve()
    pdf = root / PDF_NAME
    raw = pdf.read_bytes()
    if digest(raw) != EXPECTED_SOURCE_SHA256:
        raise ValueError("Source PDF hash changed; re-review it before replacing the checked-in inventory")
    reader = PdfReader(pdf)
    if len(reader.pages) != 45:
        raise ValueError("Expected the reviewed 45-page document")
    outputs = {
        "review-inventory.json": extract_inventory(reader),
        "review-questions.json": extract_questions(reader),
        "source-manifest.json": create_manifest(reader, root, raw),
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, value in outputs.items():
        (args.output_dir / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"regions": 366, "portals": 330, "questions": 10, "outputFiles": list(outputs)}))


if __name__ == "__main__":
    main()
