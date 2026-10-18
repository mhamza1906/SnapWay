import numpy as np
import pytest

from placematch.causal_tracking import CausalGraphTracker
from placematch.ops.point_video_tracking import aggregate_point_scores


def tracker():
    return CausalGraphTracker(["a", "b", "c"], np.array([[0, 10, 20], [10, 0, 10], [20, 10, 0]]))


def test_prefix_is_independent_of_future_frames():
    rows = [[0.5, 0.2, 0.1], [0.4, 0.35, 0.2], [0.2, 0.45, 0.2], [0.1, 0.2, 0.6]]
    short, full = tracker(), tracker()
    a = [short.update(row, i * 0.5) for i, row in enumerate(rows[:3])]
    b = [full.update(row, i * 0.5) for i, row in enumerate(rows)]
    assert a == b[:3]


def test_history_never_upgrades_weak_or_blurred_evidence():
    model = tracker()
    assert model.update([0.5, 0.2, 0.1], 0)["node_id"] == "a"
    weak = model.update([0.27, 0.26, 0.2], 0.5)
    assert weak["confidence_kind"] == "unsupported" and weak["node_id"] is None
    blurred = model.update([0.5, 0.2, 0.1], 1, ["blurry"])
    assert blurred["uncertain"] and blurred["node_id"] is None
    ambiguous = model.update([0.5, 0.499, 0.1], 1.5)
    assert ambiguous["uncertain"] and ambiguous["node_id"] is None


def test_quality_gap_resets_and_out_of_order_frames_are_rejected():
    model = tracker()
    model.update([0.6, 0.1, 0.1], 0)
    model.update([0.1, 0.1, 0.7], 1, ["blurry"])
    new = model.update([0.1, 0.1, 0.7], 4)
    assert new["node_id"] == "c"
    with pytest.raises(ValueError, match="increasing"):
        model.update([0.1, 0.1, 0.7], 3)


def test_directional_reference_views_are_grouped_before_distinct_point_margin():
    ids, scores = aggregate_point_scores(np.array([[0.55, 0.54, 0.3, 0.29]]), ["a", "a", "b", "b"])
    model = CausalGraphTracker(ids, np.array([[0, 10], [10, 0]]))
    result = model.update(scores[0], 0)
    assert result["node_id"] == "a"
    assert result["margin"] == pytest.approx(0.25)


def test_large_graph_jump_abstains_then_reacquires_after_stale_anchor():
    distances = np.array([[0, 10, 510], [10, 0, 500], [510, 500, 0]])
    model = CausalGraphTracker(["a", "b", "c"], distances)
    assert model.update([0.6, 0.1, 0.1], 0)["node_id"] == "a"
    # Median nearest spacing is 10; small progress at the budget boundary is valid.
    assert model.update([0.1, 0.9, 0.1], 0.5)["node_id"] == "b"
    far = model.update([0.1, 0.1, 0.99], 1)
    assert far["node_id"] is None and far["graph_jump"] and far["trail_break"]
    reacquired = model.update([0.1, 0.1, 0.99], 3.5)
    assert reacquired["node_id"] == "c" and reacquired["trail_break"]
