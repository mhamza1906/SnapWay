"""Independent, model-free checks for point-level video retrieval and graph distances.

Fixtures are synthetic and never read the user video or its predictions. A route may
connect nearby-looking points only through authored graph edges, including support
bends; directional photographs of one point must not compete as distinct locations.
"""

from __future__ import annotations

import numpy as np
import pytest

from placematch.ops.point_video_tracking import (
    aggregate_point_scores,
    distinct_node_candidates,
    graph_point_distances,
    smooth_track,
    tracked_outcome,
    validate_vectors,
)


def test_directional_references_aggregate_by_maximum_in_first_seen_node_order():
    # References deliberately interleave point IDs, so a reshape by four views fails.
    similarities = np.array(
        [[0.20, 0.61, 0.91, 0.10, 0.82], [0.75, 0.30, 0.05, 0.95, 0.42]],
        dtype=np.float32,
    )

    node_ids, point_scores = aggregate_point_scores(
        similarities, ["point-b", "point-a", "point-b", "point-c", "point-a"]
    )

    assert node_ids == ["point-b", "point-a", "point-c"]
    np.testing.assert_allclose(point_scores, [[0.91, 0.82, 0.10], [0.75, 0.42, 0.95]])


def test_runner_up_is_another_point_not_another_direction_of_the_winner():
    similarities = np.array([[0.91, 0.90, 0.89, 0.88, 0.62, 0.61]], dtype=np.float32)
    node_ids, point_scores = aggregate_point_scores(
        similarities, ["point-7"] * 4 + ["point-8", "point-9"]
    )

    candidates = distinct_node_candidates(point_scores[0], node_ids)

    assert [candidate["node_id"] for candidate in candidates] == [
        "point-7",
        "point-8",
        "point-9",
    ]
    assert candidates[0]["score"] - candidates[1]["score"] == pytest.approx(0.29)
    assert len({candidate["node_id"] for candidate in candidates}) == len(candidates)


def test_candidates_descend_by_score_and_respect_top_k_without_returning_every_node():
    candidates = distinct_node_candidates(
        np.array([0.10, 0.87, 0.31, 0.53, 0.72, 0.92], dtype=np.float32),
        ["a", "b", "c", "d", "e", "f"],
        k=3,
    )

    assert [candidate["node_id"] for candidate in candidates] == ["f", "b", "e"]
    assert [candidate["score"] for candidate in candidates] == pytest.approx([0.92, 0.87, 0.72])


def test_aggregation_retains_negative_cosines_instead_of_clipping_them_to_zero():
    node_ids, scores = aggregate_point_scores(
        np.array([[-0.80, -0.30, -0.20]], dtype=np.float32), ["a", "b", "a"]
    )

    assert node_ids == ["a", "b"]
    np.testing.assert_allclose(scores, [[-0.20, -0.30]])


def _edge(start: str, end: str, cost: float) -> dict:
    return {"from_node_id": start, "to_node_id": end, "cost": cost}


def test_graph_distances_follow_support_bends_and_never_shortcut_across_walls():
    # a and b are only ten units apart through a wall. The authored walk goes
    # around the wall, and neither bend is a photograph point.
    nodes = [
        {"id": "a", "x": 0.0, "y": 0.0},
        {"id": "bend-1", "x": 0.0, "y": 10.0},
        {"id": "bend-2", "x": 10.0, "y": 10.0},
        {"id": "b", "x": 10.0, "y": 0.0},
        {"id": "isolated", "x": 10.1, "y": 0.0},
    ]
    edges = [_edge("a", "bend-1", 10.0), _edge("bend-1", "bend-2", 10.0)]
    edges.append(_edge("bend-2", "b", 10.0))

    distances = graph_point_distances(nodes, edges, ["b", "a", "isolated"])

    assert distances.shape == (3, 3)
    np.testing.assert_allclose(np.diag(distances), 0.0)
    assert distances[0, 1] == pytest.approx(30.0)
    assert distances[1, 0] == pytest.approx(30.0)  # edges are undirected
    assert np.isinf(distances[0, 2]) and np.isinf(distances[2, 0])
    assert np.isinf(distances[1, 2]) and np.isinf(distances[2, 1])


def test_graph_distances_use_authoritative_costs_and_choose_the_shortest_weighted_path():
    # Coordinates intentionally disagree with the supplied costs. A hop-count
    # search or Euclidean reconstruction would choose the wrong distance.
    nodes = [
        {"id": "a", "x": 0.0, "y": 0.0},
        {"id": "support", "x": 100.0, "y": 100.0},
        {"id": "b", "x": 1.0, "y": 0.0},
    ]
    edges = [_edge("a", "b", 12.0), _edge("a", "support", 3.0)]
    edges.append(_edge("support", "b", 4.5))

    distances = graph_point_distances(nodes, edges, ["a", "b"])

    np.testing.assert_allclose(distances, [[0.0, 7.5], [7.5, 0.0]])


def test_graph_distances_accept_actual_export_endpoints_and_exclude_closed_edges():
    nodes = [{"id": "a", "x": 0.0, "y": 0.0}, {"id": "b", "x": 1.0, "y": 0.0}]
    edges = [
        {"from_node": "a", "to_node": "b", "cost": 0.1, "is_open": False},
        {"from_node": "a", "to_node": "b", "cost": 8.0, "is_open": True},
    ]

    np.testing.assert_allclose(graph_point_distances(nodes, edges, ["a", "b"]), [[0, 8], [8, 0]])


@pytest.mark.parametrize("connected", [False, True], ids=["disconnected", "connected"])
def test_temporal_evidence_cannot_force_a_jump_between_disconnected_components(connected):
    # A long second half can outweigh any finite transition penalty. The disconnected
    # case must remain within one component despite this strong visual temptation.
    scores = np.array([[0.9, 0.1]] * 20 + [[0.1, 0.9]] * 20, dtype=np.float32)
    cost = 1.0 if connected else np.inf
    distances = np.array([[0.0, cost], [cost, 0.0]])
    times = np.arange(len(scores), dtype=float) * 0.5

    path, metadata = smooth_track(scores, distances, times)

    assert path.shape == (40,)
    assert metadata["future_context"] is True
    if connected:
        # The control prevents a tracker that freezes every sequence from passing.
        np.testing.assert_array_equal(path, [0] * 20 + [1] * 20)
    else:
        assert len(set(path.tolist())) == 1


@pytest.mark.parametrize(
    ("raw_outcome", "changed", "expected"),
    [
        ("no_supported_match", True, "no_supported_match"),
        ("no_supported_match", False, "no_supported_match"),
        ("supported_retrieval", True, "uncertain"),
        ("supported_retrieval", False, "supported_retrieval"),
        ("uncertain", True, "uncertain"),
        ("uncertain", False, "uncertain"),
    ],
)
def test_smoothing_never_weakens_rejection_or_upgrades_uncertain_visual_evidence(
    raw_outcome, changed, expected
):
    assert tracked_outcome(raw_outcome, changed) == expected


def test_valid_default_megaloc_descriptor_shape_and_unit_norms_are_accepted():
    vectors = np.zeros((2, 8448), dtype=np.float32)
    vectors[0, 10] = 1.0
    vectors[1, 42] = -1.0

    result = validate_vectors(vectors, expected_rows=2)

    assert isinstance(result, dict)
    np.testing.assert_array_equal(np.linalg.norm(vectors, axis=1), [1.0, 1.0])


def test_valid_vectors_allow_explicit_descriptor_dimension():
    vectors = np.array([[0.6, 0.8, 0.0], [-1.0, 0.0, 0.0]], dtype=np.float32)

    assert isinstance(validate_vectors(vectors, expected_rows=2, dim=3), dict)


@pytest.mark.parametrize(
    ("vectors", "rows", "dim"),
    [
        pytest.param(np.eye(2, dtype=np.float32), 3, 2, id="wrong-row-count"),
        pytest.param(np.eye(2, dtype=np.float32), 2, 3, id="wrong-descriptor-dimension"),
        pytest.param(np.array([1.0, 0.0], dtype=np.float32), 1, 2, id="missing-batch-axis"),
        pytest.param(np.array([[np.nan, 0.0]], dtype=np.float32), 1, 2, id="nan"),
        pytest.param(np.array([[np.inf, 0.0]], dtype=np.float32), 1, 2, id="infinity"),
        pytest.param(np.zeros((1, 2), dtype=np.float32), 1, 2, id="zero-descriptor"),
        pytest.param(np.array([[2.0, 0.0]], dtype=np.float32), 1, 2, id="non-unit-descriptor"),
    ],
)
def test_invalid_vectors_are_rejected_before_any_similarity_search(vectors, rows, dim):
    with pytest.raises(ValueError):
        validate_vectors(vectors, expected_rows=rows, dim=dim)
