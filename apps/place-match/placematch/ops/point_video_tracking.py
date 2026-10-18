"""Offline point retrieval and graph-regularized tracking; no video-to-reference leakage.

Scores remain cosine similarities, not probabilities. Temporal estimates are
separate from raw retrieval and never use the user's stated start/end locations.
"""

from __future__ import annotations

import argparse
import csv
import heapq
import json
from collections import Counter
from pathlib import Path

import numpy as np

from placematch.ops.point_video_embeddings import validate_embedding_artifacts


def validate_vectors(vectors, expected_rows: int, dim: int = 8448) -> dict:
    vectors = np.asarray(vectors)
    if vectors.shape != (expected_rows, dim) or not np.isfinite(vectors).all():
        raise ValueError("Non-finite descriptors or unexpected descriptor shape.")
    norms = np.linalg.norm(vectors, axis=1)
    if not len(norms) or not np.allclose(norms, 1.0, atol=1e-4):
        raise ValueError("Descriptors must be nonzero and L2-normalized.")
    return {
        "rows": expected_rows,
        "dimensions": dim,
        "norm_min": float(norms.min()),
        "norm_max": float(norms.max()),
    }


def aggregate_point_scores(similarities: np.ndarray, reference_node_ids: list[str]):
    similarities = np.asarray(similarities)
    if similarities.ndim != 2 or similarities.shape[1] != len(reference_node_ids):
        raise ValueError("Reference rows and similarities disagree.")
    if not reference_node_ids or not np.isfinite(similarities).all():
        raise ValueError("Empty/non-finite retrieval input.")
    node_ids = list(dict.fromkeys(reference_node_ids))
    scores = np.column_stack(
        [
            similarities[:, [i for i, node in enumerate(reference_node_ids) if node == point]].max(
                axis=1
            )
            for point in node_ids
        ]
    )
    return node_ids, scores


def distinct_node_candidates(scores_row, node_ids: list[str], k: int = 5) -> list[dict]:
    scores = np.asarray(scores_row)
    if scores.shape != (len(node_ids),) or not np.isfinite(scores).all() or k < 1:
        raise ValueError("Invalid point-score row or top-k.")
    return [
        {"node_id": node_ids[i], "score": float(scores[i])}
        for i in np.argsort(-scores, kind="stable")[:k]
    ]


def graph_adjacency(nodes: list[dict], edges: list[dict]) -> dict:
    positions = {node["id"]: node for node in nodes}
    adjacency = {key: [] for key in positions}
    for edge in edges:
        if edge.get("is_open") is False:
            continue
        start = edge.get("from_node_id", edge.get("from_node"))
        end = edge.get("to_node_id", edge.get("to_node"))
        if start not in positions or end not in positions:
            raise ValueError("Unknown graph endpoint.")
        cost = float(edge["cost"])
        if not np.isfinite(cost) or cost < 0:
            raise ValueError("Invalid graph edge cost.")
        adjacency[start].append((end, cost))
        adjacency[end].append((start, cost))
    return adjacency


def shortest_paths(adjacency: dict, start: str):
    distances, previous = {start: 0.0}, {}
    queue = [(0.0, start)]
    while queue:
        cost, node = heapq.heappop(queue)
        if cost != distances[node]:
            continue
        for neighbor, weight in adjacency[node]:
            wanted = cost + weight
            if wanted < distances.get(neighbor, float("inf")):
                distances[neighbor] = wanted
                previous[neighbor] = node
                heapq.heappush(queue, (wanted, neighbor))
    return distances, previous


def graph_point_distances(nodes: list[dict], edges: list[dict], point_ids: list[str]):
    adjacency = graph_adjacency(nodes, edges)
    result = np.full((len(point_ids), len(point_ids)), np.inf)
    for i, point in enumerate(point_ids):
        if point not in adjacency:
            raise ValueError("Reference point absent from its graph.")
        distances, _ = shortest_paths(adjacency, point)
        for j, other in enumerate(point_ids):
            result[i, j] = distances.get(other, np.inf)
    return result


def smooth_track(scores, distances, times, penalty_per_spacing: float = 0.015):
    """Offline Viterbi over cosine evidence, with fixed geometry-only transition costs."""
    without_self = distances.copy()
    np.fill_diagonal(without_self, np.inf)
    nearest = without_self.min(axis=1)
    finite = nearest[np.isfinite(nearest) & (nearest > 0)]
    spacing = float(np.median(finite)) if len(finite) else 1.0
    penalty = penalty_per_spacing * np.minimum(distances / spacing, 20)
    penalty[~np.isfinite(distances)] = np.inf
    previous = np.zeros(scores.shape, dtype=np.int32)
    value = scores[0].copy()
    for t in range(1, len(scores)):
        dt = max(0.001, float(times[t] - times[t - 1]))
        options = value[:, None] - penalty * (0.5 / dt)
        previous[t] = options.argmax(axis=0)
        value = scores[t] + options.max(axis=0)
    path = np.zeros(len(scores), dtype=np.int32)
    path[-1] = value.argmax()
    for t in range(len(scores) - 1, 0, -1):
        path[t - 1] = previous[t, path[t]]
    return path, {
        "algorithm": "offline graph-regularized Viterbi on cosine evidence",
        "future_context": True,
        "penalty_per_reference_spacing": penalty_per_spacing,
        "median_nearest_point_graph_units": spacing,
        "start_end_constraints": None,
        "metres_or_speed_estimated": False,
    }


def tracked_outcome(raw_outcome: str, changed: bool) -> str:
    if raw_outcome == "no_supported_match":
        return raw_outcome
    return "uncertain" if changed else raw_outcome


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--anchors", type=Path)
    args = parser.parse_args()
    root = args.run.resolve()
    validate_embedding_artifacts(root)
    refs = json.loads((root / "reference-rows.json").read_text())
    frames = json.loads((root / "frames.json").read_text())["frames"]
    manifest = json.loads((root / "reference-manifest.json").read_text())
    qualities = json.loads((root / "frame-quality.json").read_text())
    rv = np.load(root / "embeddings/reference-vectors.npy")
    qv = np.load(root / "embeddings/query-vectors.npy")
    validations = {
        "reference": validate_vectors(rv, len(refs)),
        "query": validate_vectors(qv, len(frames)),
    }
    similarities = qv @ rv.T
    node_ids, scores = aggregate_point_scores(similarities, [r["node_id"] for r in refs])
    np.save(root / "embeddings/frame-reference-cosines.npy", similarities)
    np.save(root / "embeddings/frame-point-cosines.npy", scores)
    metadata = {ref["node_id"]: ref for ref in refs}
    node_ref_indices = {
        node: [i for i, ref in enumerate(refs) if ref["node_id"] == node] for node in node_ids
    }
    nodes = [n for walk in manifest["walks"] for n in walk["graph"]["nodes"]]
    edges = [e for walk in manifest["walks"] for e in walk["graph"]["edges"]]
    distances = graph_point_distances(nodes, edges, node_ids)
    times = np.array([f["timestamp_s"] for f in frames])
    if np.any(np.diff(times) <= 0):
        raise ValueError("Sample timestamps must be strictly increasing.")
    track, smoothing = smooth_track(scores, distances, times)
    # Transferred from the existing recording-disjoint placematch-v2 benchmark.
    # These are NOT calibrated against this Sam Ibrahim video or its endpoints.
    accept, reject, margin_min = 0.330906689, 0.289042462, 0.01
    rows = []
    for i, (frame, quality) in enumerate(zip(frames, qualities, strict=True)):
        candidates = distinct_node_candidates(scores[i], node_ids)
        for candidate in candidates:
            ref_i = max(node_ref_indices[candidate["node_id"]], key=lambda j: similarities[i, j])
            candidate.update(
                point=metadata[candidate["node_id"]]["point_number"],
                reference_id=refs[ref_i]["reference_id"],
                direction=refs[ref_i]["direction"],
            )
        best = candidates[0]
        margin = best["score"] - candidates[1]["score"] if len(candidates) > 1 else 0
        raw_outcome = (
            "no_supported_match"
            if best["score"] < reject
            else "supported_retrieval"
            if best["score"] >= accept and margin >= margin_min and not quality["flags"]
            else "uncertain"
        )
        chosen = node_ids[int(track[i])]
        ref_i = max(node_ref_indices[chosen], key=lambda j: similarities[i, j])
        rows.append(
            {
                "timestamp_s": frame["timestamp_s"],
                "source_frame_id": frame["frame_id"],
                "query_path": frame["path"],
                "raw_node_id": best["node_id"],
                "raw_point": best["point"],
                "track_node_id": chosen,
                "track_point": metadata[chosen]["point_number"],
                "score": best["score"],
                "track_score": float(scores[i, int(track[i])]),
                "margin": margin,
                "raw_outcome": raw_outcome,
                "outcome": tracked_outcome(raw_outcome, chosen != best["node_id"]),
                "winning_reference_id": best["reference_id"],
                "track_reference_id": refs[ref_i]["reference_id"],
                "quality_flags": quality["flags"],
                "candidates": candidates,
            }
        )
    config = {
        "sample_fps": json.loads((root / "frames.json").read_text())["fps"],
        "method": "separate 4-view MegaLoc descriptors; max cosine per node",
        "thresholds": {
            "accept_cosine": accept,
            "reject_cosine": reject,
            "distinct_node_margin": margin_min,
            "source": "transferred placematch-v2; not Sam-calibrated",
        },
        "smoothing": smoothing,
        "position": "nearest photographed point, not metric pose",
    }
    (root / "tracking.json").write_text(json.dumps({**config, "frames": rows}, indent=2))
    with (root / "frame-predictions.csv").open("w") as stream:
        writer = csv.DictWriter(
            stream,
            fieldnames=[
                "timestamp_s",
                "source_frame_id",
                "raw_point",
                "track_point",
                "score",
                "track_score",
                "margin",
                "raw_outcome",
                "outcome",
                "quality_flags",
            ],
        )
        writer.writeheader()
        writer.writerows({key: row[key] for key in writer.fieldnames} for row in rows)
    summary = {
        "references": len(refs),
        "reference_points": len(node_ids),
        "video_samples": len(rows),
        "vector_validation": validations,
        "sampling_interval_median_s": float(np.median(np.diff(times))),
        "raw_outcomes": dict(Counter(r["raw_outcome"] for r in rows)),
        "track_outcomes": dict(Counter(r["outcome"] for r in rows)),
        "raw_track_agreement_fraction": float(
            np.mean([r["raw_node_id"] == r["track_node_id"] for r in rows])
        ),
        "raw_point_counts": dict(Counter(r["raw_point"] for r in rows)),
        "track_point_counts": dict(Counter(r["track_point"] for r in rows)),
        "distinct_node_margin_percentiles": {
            str(p): float(np.percentile([r["margin"] for r in rows], p))
            for p in [5, 25, 50, 75, 95]
        },
        "user_endpoint_checks": {
            "hint": {"start": [1], "end_near": [10, 22], "used_as_constraint": False},
            "first_5s_raw": dict(Counter(r["raw_point"] for r in rows if r["timestamp_s"] <= 5)),
            "first_5s_track": dict(
                Counter(r["track_point"] for r in rows if r["timestamp_s"] <= 5)
            ),
            "last_5s_raw": dict(
                Counter(r["raw_point"] for r in rows if r["timestamp_s"] >= times[-1] - 5)
            ),
            "last_5s_track": dict(
                Counter(r["track_point"] for r in rows if r["timestamp_s"] >= times[-1] - 5)
            ),
        },
        "limits": [
            "No measured video point/time ground truth; no exact-point accuracy claim.",
            "Only Level 1 has reference photographs; other floors are unsupported.",
            "Reference labels are collector-proposed, not surveyed positions.",
            "Offline smoothing uses future frames; not a real-time tracker benchmark.",
        ],
    }
    if args.anchors:
        anchors = json.loads(args.anchors.read_text())
        comparisons = []
        for anchor in anchors["anchors"]:
            row = min(rows, key=lambda r: abs(r["timestamp_s"] - anchor["time_seconds"]))
            nearby = set(anchor.get("neighbor_candidates", [])) | {anchor["best_visual_candidate"]}
            comparisons.append(
                {
                    "time_s": anchor["time_seconds"],
                    "strength": anchor["strength"],
                    "visual_candidate": anchor["best_visual_candidate"],
                    "neighbor_candidates": sorted(nearby),
                    "raw_point": row["raw_point"],
                    "track_point": row["track_point"],
                    "raw_in_visual_neighbor_set": row["raw_point"] in nearby,
                    "track_in_visual_neighbor_set": row["track_point"] in nearby,
                    "is_measured_ground_truth": False,
                }
            )
        summary["model_blind_visual_anchor_comparisons"] = comparisons
    (root / "tracking-summary.json").write_text(json.dumps(summary, indent=2))
    # Concise chronological segments aid manual point/time annotation.
    segments = []
    for row in rows:
        if not segments or segments[-1]["point"] != row["track_point"]:
            segments.append(
                {
                    "start_s": row["timestamp_s"],
                    "end_s": row["timestamp_s"],
                    "point": row["track_point"],
                    "samples": 1,
                }
            )
        else:
            segments[-1]["end_s"] = row["timestamp_s"]
            segments[-1]["samples"] += 1
    (root / "track-segments.json").write_text(json.dumps(segments, indent=2))
    print(
        json.dumps(
            {
                key: summary[key]
                for key in [
                    "references",
                    "reference_points",
                    "video_samples",
                    "raw_outcomes",
                    "track_outcomes",
                    "user_endpoint_checks",
                ]
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
