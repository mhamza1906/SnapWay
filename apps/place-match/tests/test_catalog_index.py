"""Offline tests for multi-floor catalog helpers (no MegaLoc weights / zip I/O)."""

from __future__ import annotations

from placematch.catalog_index import GlobalCatalog, cross_target_uncertain
from placematch.schemas import Candidate


def test_sync_empty_does_not_deadlock():
    """sync() used to call snapshot() while holding Lock → permanent hang."""
    cat = GlobalCatalog()
    snap = cat.sync([], {})
    assert snap == {"sets": [], "n_vectors": 0}


def test_cross_target_uncertain():
    rows = {
        "a::r1": type("R", (), {"target_id": "t1"})(),
        "b::r2": type("R", (), {"target_id": "t2"})(),
    }
    cands = [
        Candidate(rank=1, reference_id="a::r1", location_id="n1", cosine=0.40),
        Candidate(rank=2, reference_id="b::r2", location_id="n2", cosine=0.39),
    ]
    assert cross_target_uncertain(cands, rows, min_margin=0.05) is True
    assert cross_target_uncertain(cands, rows, min_margin=0.005) is False


def test_cross_target_same_floor_ok():
    rows = {
        "a::r1": type("R", (), {"target_id": "t1"})(),
        "b::r2": type("R", (), {"target_id": "t1"})(),
    }
    cands = [
        Candidate(rank=1, reference_id="a::r1", location_id="n1", cosine=0.40),
        Candidate(rank=2, reference_id="b::r2", location_id="n2", cosine=0.39),
    ]
    assert cross_target_uncertain(cands, rows, min_margin=0.05) is False
