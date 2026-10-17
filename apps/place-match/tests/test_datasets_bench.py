"""Consistency checks on the built benchmark (skipped when data/bench is not present)."""

from __future__ import annotations

import pytest

from placematch.datasets.bench import BENCH_DIR, DEFAULT_NAME
from placematch.schemas import LabelSet, Manifest

BENCH = BENCH_DIR / DEFAULT_NAME
pytestmark = pytest.mark.skipif(
    not (BENCH / "labels.json").is_file(), reason="benchmark not built (data/ is local only)"
)


@pytest.fixture(scope="module")
def bench():
    m = Manifest.model_validate_json((BENCH / "manifest.json").read_text())
    lab = LabelSet.model_validate_json((BENCH / "labels.json").read_text())
    return m, lab


def test_ids_files_and_roles(bench):
    m, lab = bench
    ids = [e.image_id for e in m.entries]
    assert len(ids) == len(set(ids))
    for e in m.entries:
        assert m.resolve(e, BENCH / "manifest.json").is_file(), e.path
        assert (e.role == "reference") == (e.split is None)
        assert e.timestamp_s is None  # neither dataset supplies per-frame times we use
    queries = {e.image_id for e in m.queries()}
    assert {lb.query_id for lb in lab.labels} == queries


def test_labels_reference_same_scene_refs(bench):
    m, lab = bench
    by = {e.image_id: e for e in m.entries}
    for lb in lab.labels:
        q = by[lb.query_id]
        assert not lb.reviewed  # nothing here was reviewed by a person
        assert lb.has_valid_reference == bool(lb.positives)
        assert not set(lb.positives) & set(lb.ambiguous)
        for r in lb.positives + lb.ambiguous:
            ref = by[r]
            assert ref.role == "reference"
            assert ref.pose.frame == q.pose.frame  # only same-frame poses compared


def test_splits_do_not_share_recordings(bench):
    m, _ = bench
    seqs = {"validation": set(), "test": set()}
    refs = {e.sequence_id for e in m.references()}
    for e in m.queries():
        seqs[e.split].add(e.sequence_id)
        assert e.sequence_id not in refs
    assert not seqs["validation"] & seqs["test"]


def test_held_out_scenes_have_no_references(bench):
    m, lab = bench
    ref_locations = {e.location_id for e in m.references()}
    by = {e.image_id: e for e in m.entries}
    held = [lb for lb in lab.labels if by[lb.query_id].location_id not in ref_locations]
    assert held and all(not lb.has_valid_reference for lb in held)
    for split in ("validation", "test"):
        assert any(by[lb.query_id].split == split for lb in held)


def test_synthetic_entries_are_tagged_and_test_only(bench):
    m, _ = bench
    synth = [e for e in m.entries if any(c.startswith("synthetic:") for c in e.conditions)]
    assert synth
    for e in synth:
        assert e.split == "test" and e.extra["derived_from"]
        assert not any(c.startswith("real:") for c in e.conditions)
