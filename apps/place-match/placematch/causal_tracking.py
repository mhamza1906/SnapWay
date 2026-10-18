"""Forward-only graph candidate filter. Scores/continuity are not location probabilities."""

from __future__ import annotations

import numpy as np

from placematch.ops.point_video_tracking import distinct_node_candidates


class CausalGraphTracker:
    """One mutable instance per live session; never share state between users.

    Input is one max-per-distinct-point cosine row in node_ids order, monotonic
    presentation time, and frame quality flags. The graph supplies only topology
    and relative plan distances: no metres/speed or precise camera pose is inferred.
    Temporal evidence can reject a raw winner; it cannot make weak evidence valid.
    """

    def __init__(
        self,
        node_ids,
        distances,
        *,
        accept=0.330906689,
        reject=0.289042462,
        margin=0.01,
        penalty=0.015,
        memory_seconds=2.0,
        stale_seconds=3.0,
        jump_spacings_per_second=2.0,
    ):
        self.node_ids = list(node_ids)
        self.distances = np.asarray(distances, dtype=float)
        n = len(self.node_ids)
        if n < 2 or self.distances.shape != (n, n):
            raise ValueError("Need at least two graph points and pairwise distances.")
        if np.isnan(self.distances).any() or (self.distances < 0).any():
            raise ValueError("Graph distances must be nonnegative or infinity.")
        if not np.allclose(np.diag(self.distances), 0):
            raise ValueError("Each point must have zero self-distance.")
        if not (
            0 <= reject <= accept <= 1
            and margin >= 0
            and penalty >= 0
            and memory_seconds > 0
            and stale_seconds > 0
            and jump_spacings_per_second > 0
        ):
            raise ValueError("Invalid filter thresholds.")
        nearest = self.distances.copy()
        np.fill_diagonal(nearest, np.inf)
        nearest = nearest.min(axis=1)
        finite = nearest[np.isfinite(nearest) & (nearest > 0)]
        self.spacing = float(np.median(finite)) if len(finite) else 1.0
        self.penalty = penalty * np.minimum(self.distances / self.spacing, 20)
        self.penalty[~np.isfinite(self.distances)] = np.inf
        self.accept, self.reject, self.margin = accept, reject, margin
        self.memory_seconds, self.stale_seconds = memory_seconds, stale_seconds
        self.jump_spacings_per_second = jump_spacings_per_second
        self.reset()

    def reset(self):
        self.value = None
        self.last_time = None
        self.last_evidence_time = None
        self.last_supported_index = None
        self.last_supported_time = None

    def update(self, scores, timestamp_s, quality_flags=()):
        scores = np.asarray(scores, dtype=float)
        timestamp_s = float(timestamp_s)
        if scores.shape != (len(self.node_ids),) or not np.isfinite(scores).all():
            raise ValueError("One finite cosine per distinct point is required.")
        if not np.isfinite(timestamp_s) or timestamp_s < 0:
            raise ValueError("Timestamp must be finite and nonnegative.")
        if self.last_time is not None and timestamp_s <= self.last_time:
            raise ValueError("Frames must arrive in strictly increasing presentation time.")
        dt = timestamp_s - self.last_time if self.last_time is not None else 0
        if self.last_time is not None and dt > self.stale_seconds:
            self.value = None
        if (
            self.last_evidence_time is not None
            and timestamp_s - self.last_evidence_time > self.stale_seconds
        ):
            self.value = None
        reacquired = (
            self.last_supported_time is not None
            and timestamp_s - self.last_supported_time >= self.stale_seconds
        )
        if reacquired:
            self.last_supported_index = None
            self.last_supported_time = None
            self.value = None
        self.last_time = timestamp_s
        topk = distinct_node_candidates(scores, self.node_ids)
        raw = topk[0]
        margin = raw["score"] - topk[1]["score"]
        flags = list(quality_flags)
        visual_supported = raw["score"] >= self.accept and margin >= self.margin and not flags
        # Unusable frames do not reinforce a stale location. Moderate retrieval can
        # inform candidate ranking, but acceptance always needs this frame's visual evidence.
        usable = raw["score"] >= self.reject and not flags
        if usable:
            if self.value is None:
                self.value = scores.copy()
            else:
                decay = np.exp(-dt / self.memory_seconds)
                self.value = scores + (self.value[:, None] * decay - self.penalty).max(axis=0)
            self.value -= self.value.max()
            self.last_evidence_time = timestamp_s
        index = int(self.value.argmax()) if self.value is not None else int(scores.argmax())
        candidate = self.node_ids[index]
        same = candidate == raw["node_id"]
        supported = visual_supported and same
        if raw["score"] < self.reject:
            kind, reason = "unsupported", "Cosine below transferred rejection threshold."
        elif flags:
            kind, reason = "uncertain", "Frame quality flags; no temporal update."
        elif margin < self.margin:
            kind, reason = "uncertain", "Distinct old points have similar appearance."
        elif raw["score"] < self.accept:
            kind, reason = "uncertain", "Cosine below transferred acceptance threshold."
        elif not same:
            kind, reason = "uncertain", "Visual winner disagrees with causal graph history."
        else:
            kind, reason = (
                "retrieval_supported",
                "Visual threshold and graph history agree; unsurveyed candidate.",
            )
        jump = False
        jump_distance = None
        if supported and self.last_supported_index is not None:
            jump_distance = float(self.distances[self.last_supported_index, index])
            elapsed = timestamp_s - self.last_supported_time
            budget = self.jump_spacings_per_second * self.spacing * max(elapsed, 0.5)
            jump = not np.isfinite(jump_distance) or jump_distance > budget
            if jump:
                supported = False
                kind, reason = "uncertain", "Large graph jump; reconfirm reference."
        if supported:
            self.last_supported_index = index
            self.last_supported_time = timestamp_s
        return {
            "timestamp_s": timestamp_s,
            "node_id": candidate if supported else None,
            "candidate_node_id": candidate,
            "confidence_kind": kind,
            "uncertain": not supported,
            "reason": reason,
            "candidate_score": float(scores[index]),
            "raw_node_id": raw["node_id"],
            "raw_score": raw["score"],
            "margin": margin,
            "quality_flags": flags,
            "topk": topk,
            "trail_break": not supported or reacquired,
            "graph_jump": jump,
            "graph_jump_distance": jump_distance if np.isfinite(jump_distance or 0) else None,
        }
