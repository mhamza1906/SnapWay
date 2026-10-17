"""MegaLoc-first decisions for the mobile API (IOS_AGENT_PROMPT.md §4).

Pure functions over :mod:`placematch.decide`; no models or I/O here.

- MegaLoc's decision is authoritative.
- Vertex AI may only (a) confirm a MegaLoc ``uncertain`` as ``likely_match`` when Vertex
  accepts *with geometric verification passing* and its accepted reference has the same
  ``location_id`` as MegaLoc's top-1, or (b) answer when MegaLoc is unavailable, still
  needing verification to report ``likely_match``.
- Disagreement is ``uncertain``. Scores from different backends are never averaged or
  compared; each candidate keeps the raw cosine of its own backend.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np

from placematch.backends.base import EmbeddingIndex
from placematch.decide import decide_query
from placematch.schemas import (
    BackendThresholds,
    Candidate,
    Decision,
    FrameQuality,
    QueryResult,
    ThresholdSet,
    VerificationResult,
)

BackendName = Literal["megaloc", "vertex"]
Mode = Literal["auto", "megaloc", "vertex"]


class NoBackendAvailable(RuntimeError):
    """Neither the requested nor a permitted fallback backend can answer."""


@dataclass
class BackendOutcome:
    """One backend's answer for one frame (or why it could not answer)."""

    name: BackendName
    key: str | None
    candidates: list[Candidate] = field(default_factory=list)
    decision: Decision | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None and self.decision is not None

    @property
    def top(self) -> Candidate | None:
        return self.candidates[0] if self.candidates else None

    @property
    def verification(self) -> VerificationResult | None:
        return self.top.verification if self.top else None


@dataclass
class Combined:
    decision: Decision
    location_id: str | None
    primary: BackendOutcome
    secondary: BackendOutcome | None
    backend_used: str
    fallback_used: bool
    second_opinion_used: bool


def search(
    index: EmbeddingIndex, vector: np.ndarray, locations: dict[str, str | None], top_k: int = 5
) -> list[Candidate]:
    """Top-k references by raw cosine (vectors are L2-normalised)."""
    v = np.asarray(vector, dtype=np.float32).reshape(-1)
    if v.shape[0] != index.vectors.shape[1]:
        raise ValueError(f"vector has {v.shape[0]} dims; index has {index.vectors.shape[1]}")
    scores = index.vectors @ v
    order = np.argsort(-scores)[: max(1, top_k)]
    return [
        Candidate(
            rank=r + 1,
            reference_id=index.image_ids[i],
            location_id=locations.get(index.image_ids[i]),
            cosine=float(scores[i]),
        )
        for r, i in enumerate(order)
    ]


def thresholds_for(
    thresholds: ThresholdSet | None, key: str
) -> tuple[BackendThresholds | None, str]:
    bt = thresholds.backends.get(key) if thresholds else None
    return bt, (thresholds.calibrated_on if bt is not None else "uncalibrated")


def decide_backend(
    name: BackendName,
    key: str,
    candidates: list[Candidate],
    thresholds: ThresholdSet | None,
    *,
    verification_ran: bool,
    quality: FrameQuality | None = None,
) -> Decision:
    """Single-backend decision. Vertex never accepts without passing verification."""
    bt, label = thresholds_for(thresholds, key)
    q = QueryResult(query_id="frame", path="", candidates=candidates, quality=quality)
    use_verification = verification_ran or name == "vertex"
    decision = decide_query(q, key, bt, label, use_verification)
    if name == "vertex" and not verification_ran and decision.outcome != "no_supported_match":
        decision.outcome = "uncertain"
        decision.reference_id = None
        decision.reasons.append("Vertex AI accepts only with geometric verification (not run)")
    return decision


def _location(outcome: BackendOutcome, reference_id: str | None) -> str | None:
    for c in outcome.candidates:
        if c.reference_id == reference_id:
            return c.location_id
    return None


def combine(
    mode: Mode,
    megaloc: BackendOutcome | None,
    vertex: BackendOutcome | None,
) -> Combined:
    """Apply the §4 decision order and combination rules."""
    if mode == "megaloc":
        if megaloc is None or not megaloc.ok:
            raise NoBackendAvailable(_why("megaloc", megaloc))
        return _single(megaloc, fallback=False)
    if mode == "vertex":
        if vertex is None or not vertex.ok:
            raise NoBackendAvailable(_why("vertex", vertex))
        return _single(vertex, fallback=False)

    # auto: MegaLoc first.
    if megaloc is not None and megaloc.ok:
        if megaloc.decision.outcome != "uncertain" or vertex is None:
            return _single(megaloc, fallback=False)
        return _second_opinion(megaloc, vertex)
    if vertex is not None and vertex.ok:
        combined = _single(vertex, fallback=True)
        combined.decision.reasons.insert(0, f"MegaLoc unavailable: {_why('megaloc', megaloc)}")
        return combined
    raise NoBackendAvailable(f"{_why('megaloc', megaloc)}; {_why('vertex', vertex)}")


def _why(name: str, outcome: BackendOutcome | None) -> str:
    if outcome is None:
        return f"{name} not requested or not configured"
    return outcome.error or f"{name} produced no decision"


def _single(outcome: BackendOutcome, *, fallback: bool) -> Combined:
    d = outcome.decision.model_copy(deep=True)
    return Combined(
        decision=d,
        location_id=_location(outcome, d.reference_id),
        primary=outcome,
        secondary=None,
        backend_used=outcome.name,
        fallback_used=fallback,
        second_opinion_used=False,
    )


def _second_opinion(megaloc: BackendOutcome, vertex: BackendOutcome) -> Combined:
    d = megaloc.decision.model_copy(deep=True)
    base = Combined(
        decision=d,
        location_id=None,
        primary=megaloc,
        secondary=vertex,
        backend_used="megaloc+vertex",
        fallback_used=False,
        second_opinion_used=True,
    )
    if not vertex.ok:
        d.reasons.append(f"second opinion unavailable: {_why('vertex', vertex)}")
        return base
    v = vertex.decision
    m_loc = megaloc.top.location_id if megaloc.top else None
    v_loc = _location(vertex, v.reference_id)
    if v.outcome != "likely_match":
        d.reasons.append(f"second opinion (Vertex AI) is {v.outcome}; MegaLoc stays uncertain")
        return base
    if m_loc is None or v_loc is None or m_loc != v_loc:
        d.reasons.append(
            f"second opinion disagrees (Vertex location {v_loc!r}, MegaLoc top-1 {m_loc!r})"
        )
        return base
    d.outcome = "likely_match"
    d.reference_id = v.reference_id
    d.reasons.append(
        f"confirmed by Vertex AI with geometric verification at the same location {m_loc!r}"
    )
    base.location_id = m_loc
    return base
