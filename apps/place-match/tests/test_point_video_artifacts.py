"""Model-free regressions for frozen video/reference identity and point packaging."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from placematch.ops.point_video_embeddings import (
    EMBEDDING_FILES,
    file_hash,
    guard_reference_resume,
    save_point_vectors,
    seal_embedding_artifacts,
    validate_embedding_artifacts,
    validate_source_video,
)
from placematch.ops.point_video_render import DiagnosticRenderer


def _write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def _reference(node: str, point: int, direction: str = "front", target: str = "walk-a") -> dict:
    return {
        "node_id": node,
        "point_number": point,
        "target_id": target,
        "reference_id": f"{node}-{direction}",
        "direction": direction,
        "x": float(point) * 10,
        "y": float(point) * 20,
    }


def test_resume_accepts_identical_manifest_and_rows_without_touching_existing_output(tmp_path):
    references = [_reference("a", 1), _reference("b", 2)]
    _write_json(tmp_path / "reference-rows.json", references)
    _write_json(tmp_path / "embedding-summary.json", {"reference_manifest_sha256": "frozen"})
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}

    guard_reference_resume(tmp_path, "frozen", references)

    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before


def test_changed_reference_manifest_is_rejected_before_existing_rows_can_be_rewritten(tmp_path):
    references = [_reference("a", 1)]
    _write_json(tmp_path / "reference-rows.json", references)
    _write_json(tmp_path / "embedding-summary.json", {"reference_manifest_sha256": "old"})

    with pytest.raises(ValueError, match="manifest"):
        guard_reference_resume(tmp_path, "new", references)

    assert json.loads((tmp_path / "reference-rows.json").read_text()) == references


@pytest.mark.parametrize("change", ["reorder", "relabel", "remove"])
def test_changed_reference_row_identity_is_rejected_even_when_manifest_hash_is_reused(
    tmp_path, change
):
    original = [_reference("a", 1), _reference("b", 2)]
    _write_json(tmp_path / "reference-rows.json", original)
    _write_json(tmp_path / "embedding-summary.json", {"reference_manifest_sha256": "frozen"})
    replacement = json.loads(json.dumps(original))
    if change == "reorder":
        replacement.reverse()  # Same matrix shape; silently swapping labels is still unsafe.
    elif change == "relabel":
        replacement[0]["node_id"] = "another-node"
    else:
        replacement.pop()

    with pytest.raises(ValueError, match="row"):
        guard_reference_resume(tmp_path, "frozen", replacement)


def _write_sealable_run(path: Path) -> None:
    for name in EMBEDDING_FILES:
        destination = path / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.suffix == ".npy":
            np.save(destination, np.eye(2, dtype=np.float32))
        else:
            _write_json(destination, {"synthetic_artifact": name})


def test_only_a_complete_sealed_generation_is_ready_for_tracking(tmp_path):
    _write_sealable_run(tmp_path)
    seal_embedding_artifacts(tmp_path)

    validate_embedding_artifacts(tmp_path)
    state = json.loads((tmp_path / "embedding-state.json").read_text())
    assert state["state"] == "ready"
    assert set(state["sha256"]) == set(EMBEDDING_FILES)
    assert "frame-quality.json" in state["sha256"]  # Quality rows gate supported outcomes.

    _write_json(tmp_path / "embedding-state.json", {**state, "state": "building"})
    with pytest.raises(ValueError, match="incomplete"):
        validate_embedding_artifacts(tmp_path)


@pytest.mark.parametrize("name", EMBEDDING_FILES)
def test_mixed_or_modified_artifacts_are_rejected_even_if_vector_shapes_are_unchanged(
    tmp_path, name
):
    _write_sealable_run(tmp_path)
    seal_embedding_artifacts(tmp_path)
    destination = tmp_path / name
    if destination.suffix == ".npy":
        np.save(destination, np.array([[0, 1], [1, 0]], dtype=np.float32))
    else:
        _write_json(destination, {"synthetic_artifact": name, "changed_generation": True})

    with pytest.raises(ValueError, match="changed|mixed"):
        validate_embedding_artifacts(tmp_path)


def test_video_identity_is_content_based_and_wrong_video_is_rejected(tmp_path):
    original = tmp_path / "original.MOV"
    original.write_bytes(b"a small synthetic recording identity fixture")
    renamed = tmp_path / "renamed.MOV"
    renamed.write_bytes(original.read_bytes())
    wrong = tmp_path / "other.MOV"
    wrong.write_bytes(b"a different recording with the same filename suffix")
    _write_json(tmp_path / "frames.json", {"video_sha256": file_hash(original)})

    validate_source_video(tmp_path, original)
    validate_source_video(tmp_path, renamed)
    with pytest.raises(ValueError, match="differs"):
        validate_source_video(tmp_path, wrong)


def test_four_view_packages_preserve_exact_descriptor_rows_and_direction_mapping(tmp_path):
    references = [
        _reference("a", 1, "back"),
        _reference("b", 2, "front"),
        _reference("a", 1, "front"),
        _reference("a", 1, "left"),
        _reference("a", 1, "right"),
    ]
    vectors = np.arange(20, dtype=np.float32).reshape(5, 4)

    save_point_vectors(tmp_path, references, vectors)

    with np.load(tmp_path / "embeddings/points/point-01.npz", allow_pickle=False) as point:
        np.testing.assert_array_equal(point["vectors"], vectors[[0, 2, 3, 4]])
        assert point["directions"].tolist() == ["back", "front", "left", "right"]
        assert point["reference_ids"].tolist() == ["a-back", "a-front", "a-left", "a-right"]
        assert point["node_id"].item() == "a"
        assert point["target_id"].item() == "walk-a"
        assert point["x"].item() == 10 and point["y"].item() == 20


def test_same_point_number_on_different_targets_gets_separate_packages(tmp_path):
    references = [_reference("a", 1), _reference("b", 1, target="walk-b")]
    vectors = np.array([[1, 2, 3], [4, 5, 6]], dtype=np.float32)

    save_point_vectors(tmp_path, references, vectors)

    root = tmp_path / "embeddings/points"
    for index, target in enumerate(["walk-a", "walk-b"]):
        with np.load(root / target / "point-01.npz", allow_pickle=False) as point:
            np.testing.assert_array_equal(point["vectors"], vectors[index : index + 1])
            assert point["target_id"].item() == target
    assert not (root / "point-01.npz").exists()


def test_rebuilding_packages_removes_deleted_points_without_touching_other_embeddings(tmp_path):
    references = [_reference("a", 1), _reference("b", 2)]
    vectors = np.eye(2, dtype=np.float32)
    save_point_vectors(tmp_path, references, vectors)
    preserved = tmp_path / "embeddings/reference-vectors.npy"
    np.save(preserved, vectors)
    original_bytes = preserved.read_bytes()

    save_point_vectors(tmp_path, references[:1], vectors[:1])

    assert sorted(p.name for p in (tmp_path / "embeddings/points").iterdir()) == ["point-01.npz"]
    assert preserved.read_bytes() == original_bytes


def test_changing_from_multi_target_to_single_target_removes_stale_nested_packages(tmp_path):
    references = [_reference("a", 1), _reference("b", 1, target="walk-b")]
    vectors = np.eye(2, dtype=np.float32)
    save_point_vectors(tmp_path, references, vectors)

    save_point_vectors(tmp_path, references[:1], vectors[:1])

    assert sorted(p.name for p in (tmp_path / "embeddings/points").iterdir()) == ["point-01.npz"]


def test_failed_package_replacement_restores_previous_complete_packages(tmp_path, monkeypatch):
    references = [_reference("a", 1)]
    save_point_vectors(tmp_path, references, np.array([[1, 0]], dtype=np.float32))
    point_root = tmp_path / "embeddings/points"
    previous_bytes = (point_root / "point-01.npz").read_bytes()
    original_rename = Path.rename

    def fail_install(path, target):
        if path.name == "new" and Path(target) == point_root:
            raise OSError("simulated directory install failure")
        return original_rename(path, target)

    monkeypatch.setattr(Path, "rename", fail_install)
    with pytest.raises(OSError, match="simulated"):
        save_point_vectors(tmp_path, references, np.array([[0, 1]], dtype=np.float32))

    assert (point_root / "point-01.npz").read_bytes() == previous_bytes


def test_renderer_preserves_zero_edge_cost_when_selecting_a_display_path(tmp_path):
    _write_json(
        tmp_path / "tracking.json",
        {"sample_fps": 2, "frames": [{"timestamp_s": 0, "outcome": "uncertain"}]},
    )
    _write_json(tmp_path / "embedding-summary.json", {"reference_root": str(tmp_path)})
    _write_json(
        tmp_path / "reference-manifest.json",
        {
            "references": [],
            "walks": [
                {
                    "target_id": "walk-a",
                    "graph": {
                        "nodes": [
                            {"id": "a", "x": 0, "y": 0},
                            {"id": "b", "x": 100, "y": 0},
                            {"id": "bend", "x": 50, "y": 100},
                        ],
                        "edges": [
                            {"from_node": "a", "to_node": "b", "cost": 0},
                            {"from_node": "a", "to_node": "bend", "cost": 1},
                            {"from_node": "bend", "to_node": "b", "cost": 1},
                        ],
                    },
                }
            ],
        },
    )

    renderer = DiagnosticRenderer(tmp_path)

    assert ("b", 0) in renderer.adjacency["a"]
    assert renderer._path("a", "b") == ["a", "b"]
