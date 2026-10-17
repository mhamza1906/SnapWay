"""Shared data contracts. Owned by the integration (head) layer.

Every component reads and writes these models only. Changing a field here is an
interface change: keep it backwards compatible or bump ``SCHEMA_VERSION``.

Files on disk:
- ``manifest.json``      -> :class:`Manifest`       (dataset preparation / CLI ingest)
- ``labels.json``        -> :class:`LabelSet`       (ground truth, evaluation only)
- ``thresholds.json``    -> :class:`ThresholdSet`   (calibration output)
- ``results.json``       -> :class:`RunResult`      (pipeline output, one backend per run)
- ``metrics.json``       -> :class:`EvalReport`     (evaluation output)
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from placematch import SCHEMA_VERSION

Role = Literal["reference", "query"]
# validation: threshold tuning. test: frozen final evaluation (never inspected before the
# final run). development: data that already influenced the system (e.g. all of bench-v1),
# usable for diagnostics only.
Split = Literal["validation", "test", "development"]
Outcome = Literal["likely_match", "uncertain", "no_supported_match"]
VerifyStatus = Literal["verified", "inconclusive", "error", "skipped"]


# --------------------------------------------------------------------------- manifest


class Pose(BaseModel):
    """Camera pose exactly as the source dataset supplies it.

    ``matrix`` is a row-major 4x4. ``convention`` states which direction it maps
    (e.g. ``"camera_to_world"`` or ``"world_to_camera"``) and ``frame`` names the
    coordinate frame (e.g. ``"7scenes:chess:world"``). Poses from different frames
    must never be compared.
    """

    matrix: list[list[float]]
    convention: Literal["camera_to_world", "world_to_camera"]
    frame: str
    units: str = "m"


class Intrinsics(BaseModel):
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int


class SourceInfo(BaseModel):
    url: str | None = None
    license: str | None = None
    citation: str | None = None


class ManifestEntry(BaseModel):
    image_id: str  # unique within the manifest
    path: str  # absolute, or relative to the manifest file's directory
    role: Role
    dataset: str  # e.g. "7scenes", "cloc", "mapfree", "user"
    scene_id: str  # dataset scene, e.g. "chess"
    location_id: str | None = None  # "same physical place" grouping; None = unknown
    sequence_id: str | None = None  # recording / capture session
    frame_id: str | None = None  # identifier exactly as supplied by the source
    timestamp_s: float | None = None  # only when actually known; never invented
    orientation: int | None = None  # EXIF orientation code already applied (1 = none)
    pose: Pose | None = None
    intrinsics: Intrinsics | None = None
    depth_path: str | None = None
    conditions: list[str] = Field(default_factory=list)  # "real:lighting", "synthetic:dark"
    split: Split | None = None
    source: SourceInfo | None = None
    floor_id: str | None = None  # building floor, when the dataset defines one
    group_id: str | None = None  # cluster for confidence intervals (recording/session)
    derived_from: str | None = None  # source image_id of a synthetic variant
    content_sha256: str | None = None  # of the original file, for duplicate detection
    extra: dict = Field(default_factory=dict)


class Manifest(BaseModel):
    schema_version: str = SCHEMA_VERSION
    name: str
    description: str = ""
    entries: list[ManifestEntry]
    notes: dict = Field(default_factory=dict)  # subset selection, provenance, licences

    def references(self) -> list[ManifestEntry]:
        return [e for e in self.entries if e.role == "reference"]

    def queries(self) -> list[ManifestEntry]:
        return [e for e in self.entries if e.role == "query"]

    def resolve(self, entry: ManifestEntry, manifest_path: Path) -> Path:
        p = Path(entry.path)
        return p if p.is_absolute() else (manifest_path.parent / p).resolve()


# --------------------------------------------------------------------------- labels


class QueryLabel(BaseModel):
    query_id: str
    has_valid_reference: bool  # False => the query's place is absent from the references
    positives: list[str] = Field(default_factory=list)  # reference ids that truly match
    ambiguous: list[str] = Field(default_factory=list)  # neither counted right nor wrong
    method: str  # how the label was derived, e.g. "depth_reprojection_overlap>=0.3"
    reviewed: bool = False  # True only if a person reviewed it (never set by an agent)
    agent_inspected: bool = False  # an agent looked at the images
    conditions: list[str] = Field(default_factory=list)
    split: Split
    notes: str = ""
    label_version: str = "v1"
    group_id: str | None = None  # recording/session cluster (for clustered intervals)
    eval_sets: list[str] = Field(default_factory=list)  # "location_disjoint", "robustness"...
    derived_from: str | None = None  # synthetic variant of this query id (same split)
    # Raw overlap score per reference (only refs above a small floor) so label-boundary
    # sensitivity can be recomputed without re-deriving labels.
    scores: dict[str, float] = Field(default_factory=dict)


class LabelSet(BaseModel):
    schema_version: str = SCHEMA_VERSION
    manifest: str  # path of the manifest the ids refer to
    definition: str  # human-readable definition of a "correct match"
    labels: list[QueryLabel]
    version: str = "v1"
    boundaries: dict = Field(default_factory=dict)  # e.g. {"positive": 0.3, "ambiguous": 0.1}
    changelog: str | None = None  # path of the versioned label change log


# --------------------------------------------------------------------------- thresholds


class VerifyThresholds(BaseModel):
    min_inliers: int
    min_inlier_ratio: float
    min_coverage: float


class BackendThresholds(BaseModel):
    """Raw cosine thresholds for one backend. Cosine is not a probability."""

    accept_cosine: float  # top-1 cosine at/above => candidate for likely_match
    reject_cosine: float  # top-1 cosine below => no_supported_match
    min_margin: float = 0.0  # top1 - best cosine of a different location_id
    verify: VerifyThresholds | None = None


class ThresholdSet(BaseModel):
    schema_version: str = SCHEMA_VERSION
    calibrated_on: str  # labels file + split used, e.g. "bench/labels.json:validation"
    method: str  # how thresholds were chosen
    backends: dict[str, BackendThresholds]  # keyed by EmbeddingBackend.key


# --------------------------------------------------------------------------- results


class FrameQuality(BaseModel):
    blur_laplacian_var: float
    mean_luma: float  # 0..255
    dark_fraction: float  # fraction of pixels with luma < 16
    flags: list[Literal["blurry", "underexposed", "overexposed"]] = Field(default_factory=list)


class VerificationResult(BaseModel):
    method: str = "superpoint+lightglue"
    status: VerifyStatus
    geometry_model: str | None = None  # "fundamental" / "homography"
    n_keypoints_query: int = 0
    n_keypoints_reference: int = 0
    n_correspondences: int = 0
    n_inliers: int = 0
    inlier_ratio: float = 0.0
    coverage_query: float = 0.0  # fraction of grid cells containing inliers, 0..1
    coverage_reference: float = 0.0
    overlay_path: str | None = None
    elapsed_s: float = 0.0
    message: str = ""


class Candidate(BaseModel):
    rank: int  # 1-based
    reference_id: str
    location_id: str | None = None
    cosine: float  # raw cosine similarity in [-1, 1]; never shown as a percentage
    verification: VerificationResult | None = None


class Decision(BaseModel):
    outcome: Outcome
    reference_id: str | None = None  # accepted reference for likely_match
    reasons: list[str] = Field(default_factory=list)
    thresholds: str | None = None  # ThresholdSet.calibrated_on, or "uncalibrated"


class QueryResult(BaseModel):
    query_id: str
    path: str
    timestamp_s: float | None = None
    frame_id: str | None = None
    quality: FrameQuality | None = None
    candidates: list[Candidate]  # top-k by cosine, rank order (verification never reorders)
    decision: Decision | None = None
    timings_s: dict[str, float] = Field(default_factory=dict)  # embed, search, verify, total


class ReverseMatch(BaseModel):
    query_id: str
    cosine: float
    timestamp_s: float | None = None


class ReferenceResult(BaseModel):
    reference_id: str
    location_id: str | None = None
    best_queries: list[ReverseMatch]


class RunStats(BaseModel):
    n_references: int
    n_queries: int
    expected_uncached_requests: int
    api_requests: int
    cache_hits: int
    cache_misses: int
    retries: int = 0
    failed: int = 0
    timings_s: dict[str, float] = Field(default_factory=dict)
    http_attempts: int = 0  # every HTTP attempt incl. retries (logical requests = api_requests)
    usage: dict = Field(default_factory=dict)  # provider usage metadata, summed
    cost_estimate: dict = Field(default_factory=dict)  # {"usd":..., "pricing_source":..., ...}
    latency_s: dict = Field(default_factory=dict)  # {"embed_per_image": {"p50":..,"p95":..}}
    peak_rss_mb: float | None = None
    hardware: dict = Field(default_factory=dict)  # device, accelerator, concurrent workload
    cold_start: bool | None = None


class RunResult(BaseModel):
    schema_version: str = SCHEMA_VERSION
    run_id: str
    created_utc: str
    backend: str  # EmbeddingBackend.key; one backend per RunResult, never mixed
    backend_config: dict
    manifest: str
    settings: dict = Field(default_factory=dict)  # top_k, verify settings, frame rate...
    queries: list[QueryResult]
    references: list[ReferenceResult] = Field(default_factory=list)
    stats: RunStats


# --------------------------------------------------------------------------- evaluation


class MethodMetrics(BaseModel):
    method: str  # e.g. "gemini", "megaloc", "gemini+verify"
    split: Split
    n_queries: int
    n_with_reference: int
    n_without_reference: int
    recall_at_1: float | None
    recall_at_5: float | None
    false_acceptance_rate: float | None  # accepted among queries without a valid reference
    accepted_precision: float | None
    accepted_recall: float | None
    outcome_counts: dict[str, int] = Field(default_factory=dict)
    by_condition: dict[str, dict] = Field(default_factory=dict)
    api_requests: int = 0
    cache_hits: int = 0
    timings_s: dict[str, float] = Field(default_factory=dict)
    # correct_accepts, wrong_accepts, ambiguous_accepts, rejected_valid, excluded, ...
    counts: dict[str, int] = Field(default_factory=dict)
    ci: dict[str, dict] = Field(default_factory=dict)  # metric -> {low, high, method, n_groups}
    extra: dict = Field(default_factory=dict)  # e.g. verification effect


class EvalReport(BaseModel):
    schema_version: str = SCHEMA_VERSION
    manifest: str
    labels: str
    thresholds: str | None
    methods: list[MethodMetrics]
    notes: list[str] = Field(default_factory=list)
