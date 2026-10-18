"""Replay cached MegaLoc descriptors through the exact forward-only session filter."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

import numpy as np

from placematch.causal_tracking import CausalGraphTracker
from placematch.ops.point_video_tracking import (
    aggregate_point_scores,
    graph_point_distances,
    validate_vectors,
)


def continuity(ids, distances, node_ids):
    index = {node: i for i, node in enumerate(node_ids)}
    pairs = [(a, b) for a, b in zip(ids, ids[1:], strict=False) if a is not None and b is not None]
    jumps = [float(distances[index[a], index[b]]) for a, b in pairs]
    finite = [value for value in jumps if np.isfinite(value)]
    return {
        "adjacent_observed_pairs": len(pairs),
        "node_changes": sum(a != b for a, b in pairs),
        "disconnected_transitions": sum(not np.isfinite(v) for v in jumps),
        "max_graph_distance_per_sample": max(finite, default=0),
        "graph_distance_sum": sum(finite),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root, output = args.run.resolve(), args.output.resolve()
    refs = json.loads((root / "reference-rows.json").read_text())
    frames_doc = json.loads((root / "frames.json").read_text())
    frames = frames_doc["frames"]
    quality = json.loads((root / "frame-quality.json").read_text())
    manifest = json.loads((root / "reference-manifest.json").read_text())
    reference = np.load(root / "embeddings/reference-vectors.npy", allow_pickle=False)
    query = np.load(root / "embeddings/query-vectors.npy", allow_pickle=False)
    validate_vectors(reference, len(refs))
    validate_vectors(query, len(frames))
    node_ids, scores = aggregate_point_scores(query @ reference.T, [r["node_id"] for r in refs])
    metadata = {r["node_id"]: r for r in refs}
    nodes = [node for walk in manifest["walks"] for node in walk["graph"]["nodes"]]
    edges = [edge for walk in manifest["walks"] for edge in walk["graph"]["edges"]]
    distances = graph_point_distances(nodes, edges, node_ids)
    tracker = CausalGraphTracker(node_ids, distances)
    rows = []
    for i, (frame, flags) in enumerate(zip(frames, quality, strict=True)):
        row = tracker.update(scores[i], frame["timestamp_s"], flags["flags"])
        ref = metadata[row["candidate_node_id"]]
        row.update(
            candidate_point=ref["point_number"],
            x=ref["x"],
            y=ref["y"],
            raw_point=metadata[row["raw_node_id"]]["point_number"],
            source_frame_id=frame["frame_id"],
            query_path=frame["path"],
        )
        for candidate in row["topk"]:
            candidate["point"] = metadata[candidate["node_id"]]["point_number"]
        rows.append(row)
    summary = {
        "reference_points": len(node_ids),
        "reference_photos": len(refs),
        "frames": len(rows),
        "source_video_sha256": frames_doc["video_sha256"],
        "reference_vectors_sha256": hashlib.sha256(
            (root / "embeddings/reference-vectors.npy").read_bytes()
        ).hexdigest(),
        "outcomes": dict(Counter(row["confidence_kind"] for row in rows)),
        "raw_continuity": continuity([r["raw_node_id"] for r in rows], distances, node_ids),
        "causal_candidate_continuity": continuity(
            [r["candidate_node_id"] for r in rows], distances, node_ids
        ),
        "supported_only_continuity": continuity([r["node_id"] for r in rows], distances, node_ids),
        "anchor_comparisons": [],
        "startup": [
            {
                "timestamp_s": r["timestamp_s"],
                "raw_point": r["raw_point"],
                "candidate_point": r["candidate_point"],
                "uncertain": r["uncertain"],
            }
            for r in rows
            if r["timestamp_s"] <= 3.5
        ],
        "note": "Continuity and threshold counts are not measured accuracy. No metre scale, "
        "pose, floor transition, manual start/end hints or future frames used. "
        "Startup Point 19 vs user-recalled Point 1 remains unresolved.",
    }
    for time, point in [(54, 25), (78, 27), (126, 19), (156, 15)]:
        row = min(rows, key=lambda r: abs(r["timestamp_s"] - time))
        summary["anchor_comparisons"].append(
            {
                "timestamp_s": row["timestamp_s"],
                "visual_candidate": point,
                "raw_point": row["raw_point"],
                "causal_candidate": row["candidate_point"],
                "confidence_kind": row["confidence_kind"],
                "evidence": "Earlier model-blind visual candidate, not surveyed ground truth.",
            }
        )
    output.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "algorithm": "causal-decaying-max-product-graph-filter",
        "future_context": False,
        "position_kind": "old_photo_point_candidate",
        "median_nearest_point_graph_units": tracker.spacing,
        "thresholds": {
            "accept": tracker.accept,
            "reject": tracker.reject,
            "margin": tracker.margin,
            "site_calibrated": False,
        },
        "frames": rows,
        "summary": summary,
    }
    (output / "causal-replay.json").write_text(json.dumps(payload, indent=2))
    (output / "summary.json").write_text(json.dumps(summary, indent=2))
    browser = {
        "video": {
            "name": Path(frames_doc["video"]).name,
            "durationSeconds": float(frames[-1]["timestamp_s"]),
        },
        "method": payload["algorithm"],
        "frames": [
            {
                "timeSeconds": r["timestamp_s"],
                "nodeId": r["candidate_node_id"],
                "label": f"Point {r['candidate_point']}",
                "status": "uncertain" if r["uncertain"] else "candidate",
                "similarity": r["candidate_score"],
                "margin": r["margin"],
                "note": r["reason"],
                "rawPoint": r["raw_point"],
                "qualityFlags": r["quality_flags"],
                "trailBreak": r["trail_break"],
            }
            for r in rows
        ],
        "notes": [
            summary["note"],
            "No confirmed or exact mapped camera positions. "
            "Uncertain candidates must not be connected into a verified movement trail.",
        ],
    }
    (output / "browser-replay.json").write_text(json.dumps(browser, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
