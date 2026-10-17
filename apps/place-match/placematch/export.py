"""JSON/CSV exports of a :class:`RunResult`."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from placematch.schemas import Manifest, RunResult

QUERY_COLUMNS = [
    "query_id",
    "frame_id",
    "timestamp_s",
    "quality_flags",
    "outcome",
    "accepted_reference_id",
    "rank",
    "reference_id",
    "location_id",
    "cosine",
    "verify_status",
    "verify_model",
    "correspondences",
    "inliers",
    "inlier_ratio",
    "coverage_query",
    "coverage_reference",
    "decision_reasons",
]


def write_json(model, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(model.model_dump_json(indent=2), encoding="utf-8")
    return path


def read_run(path: Path) -> RunResult:
    return RunResult.model_validate_json(path.read_text(encoding="utf-8"))


def read_manifest(path: Path) -> Manifest:
    return Manifest.model_validate_json(path.read_text(encoding="utf-8"))


def _fmt(value: float | None, digits: int = 4) -> str:
    return "" if value is None else f"{value:.{digits}f}"


def write_query_csv(run: RunResult, path: Path) -> Path:
    """One row per (query, candidate): cosine and geometric evidence in separate columns."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(QUERY_COLUMNS)
        for q in run.queries:
            d = q.decision
            for c in q.candidates:
                v = c.verification
                writer.writerow(
                    [
                        q.query_id,
                        q.frame_id or "",
                        _fmt(q.timestamp_s, 3),
                        ";".join(q.quality.flags) if q.quality else "",
                        d.outcome if d else "",
                        (d.reference_id or "") if d else "",
                        c.rank,
                        c.reference_id,
                        c.location_id or "",
                        _fmt(c.cosine),
                        v.status if v else "",
                        (v.geometry_model or "") if v else "",
                        v.n_correspondences if v else "",
                        v.n_inliers if v else "",
                        _fmt(v.inlier_ratio) if v else "",
                        _fmt(v.coverage_query) if v else "",
                        _fmt(v.coverage_reference) if v else "",
                        " | ".join(d.reasons) if d else "",
                    ]
                )
    return path


def write_reverse_csv(run: RunResult, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(
            ["reference_id", "location_id", "rank", "query_id", "timestamp_s", "cosine"]
        )
        for r in run.references:
            for i, m in enumerate(r.best_queries, 1):
                writer.writerow(
                    [
                        r.reference_id,
                        r.location_id or "",
                        i,
                        m.query_id,
                        _fmt(m.timestamp_s, 3),
                        _fmt(m.cosine),
                    ]
                )
    return path


def export_all(run: RunResult, out_dir: Path) -> dict[str, str]:
    files = {
        "json": write_json(run, out_dir / "results.json"),
        "csv": write_query_csv(run, out_dir / "results.csv"),
        "reverse_csv": write_reverse_csv(run, out_dir / "reverse.csv"),
    }
    (out_dir / "exports.json").write_text(
        json.dumps({k: str(v) for k, v in files.items()}, indent=2), encoding="utf-8"
    )
    return {k: str(v) for k, v in files.items()}
