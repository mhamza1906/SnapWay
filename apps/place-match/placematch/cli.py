"""Command-line entry point: ``uv run placematch <command> ...``."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from placematch.app import BACKENDS, DEFAULT_BACKEND
from placematch.env import RUNS_DIR


def _p(value: str | None) -> Path | None:
    return Path(value).expanduser().resolve() if value else None


def cmd_ingest(a) -> None:
    from placematch.app import build_manifest

    path = build_manifest(
        _p(a.references),
        _p(a.out),
        video=_p(a.video),
        queries=_p(a.queries),
        fps=a.fps,
        locations_csv=_p(a.locations),
        timestamps_csv=_p(a.timestamps),
    )
    print(path)


def cmd_estimate(a) -> None:
    from placematch.app import estimate

    print(json.dumps(estimate(_p(a.manifest), a.backend), indent=2))


def cmd_run(a) -> None:
    from placematch.app import run_pipeline

    manifest = _p(a.manifest)
    out = _p(a.out) or manifest.parent / a.backend
    run_pipeline(
        manifest,
        a.backend,
        out,
        top_k=a.top_k,
        limit=a.limit,
        verify=a.verify,
        verify_top=a.verify_top,
        overlays=not a.no_overlays,
        thresholds_path=_p(a.thresholds),
    )


def cmd_match(a) -> None:
    """Ingest + run every requested backend in one go."""
    from placematch.app import build_manifest, run_pipeline

    out = _p(a.out)
    manifest = build_manifest(
        _p(a.references),
        out,
        video=_p(a.video),
        queries=_p(a.queries),
        fps=a.fps,
        locations_csv=_p(a.locations),
        timestamps_csv=_p(a.timestamps),
    )
    for backend in a.backend:
        run_pipeline(
            manifest,
            backend,
            out / backend,
            top_k=a.top_k,
            limit=a.limit,
            verify=a.verify,
            verify_top=a.verify_top,
            overlays=not a.no_overlays,
            thresholds_path=_p(a.thresholds),
        )


def cmd_calibrate(a) -> None:
    """Fit per-backend thresholds on the benchmark's validation labels only."""
    from placematch.decide import calibrate
    from placematch.env import DATA_DIR
    from placematch.export import read_run, write_json
    from placematch.schemas import LabelSet

    labels_path = _p(a.bench) / "labels.json"
    labels = LabelSet.model_validate_json(labels_path.read_text(encoding="utf-8"))
    runs = {str(p): read_run(_p(p)) for p in a.runs}
    thresholds = calibrate(
        runs,
        labels,
        a.split,
        target_far=a.target_far,
        target_precision=a.target_precision,
        labels_path=str(labels_path),
    )
    default = DATA_DIR / "calibration" / _p(a.bench).name / "thresholds.json"
    out = write_json(thresholds, _p(a.out) or default)
    print(out)
    for key, bt in thresholds.backends.items():
        print(
            f"{key}: accept>={bt.accept_cosine:.4f} reject<{bt.reject_cosine:.4f} "
            f"margin>={bt.min_margin:.3f}"
        )


def cmd_embed(a) -> None:
    """Resumable batch: embed up to --limit uncached images, keep every vector cached."""
    from placematch import retrieval
    from placematch.backends import get_backend
    from placematch.backends.base import RequestBudget
    from placematch.export import read_manifest

    manifest_path = _p(a.manifest)
    manifest = read_manifest(manifest_path)
    if a.subset:
        ids = set(json.loads(_p(a.subset).read_text(encoding="utf-8"))["image_ids"])
        manifest.entries = [e for e in manifest.entries if e.image_id in ids]
    backend = get_backend(a.backend)
    est = retrieval.estimate(manifest, manifest_path, backend)
    print(json.dumps(est, indent=2))
    if a.dry_run:
        return
    stats = retrieval.embed_only(
        manifest, manifest_path, backend, budget=RequestBudget(limit=a.limit), allow_partial=True
    )
    print(json.dumps(vars(stats), indent=2, default=str))
    left = retrieval.estimate(manifest, manifest_path, backend)["n_uncached"]
    print(f"remaining uncached images: {left}" + (" (re-run to continue)" if left else ""))


def cmd_activate(a) -> None:
    """Make a calibrated thresholds file the default for run/match/serve."""
    import shutil

    from placematch.app import DEFAULT_THRESHOLDS

    DEFAULT_THRESHOLDS.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(_p(a.thresholds), DEFAULT_THRESHOLDS)
    print(f"{_p(a.thresholds)} -> {DEFAULT_THRESHOLDS}")


def cmd_serve(a) -> None:
    import uvicorn

    print(f"open http://{a.host}:{a.port}/")
    uvicorn.run("placematch.server:app", host=a.host, port=a.port, log_level="warning")


def cmd_build_references(a) -> None:
    """Copy a reference folder into a named set and build one backend's index."""
    from placematch.backends import get_backend
    from placematch.reference_sets import build_reference_set

    summary = build_reference_set(
        _p(a.references), a.name, get_backend(a.backend), limit=a.limit, dry_run=a.dry_run
    )
    print(json.dumps(summary, indent=2, default=str))


def cmd_serve_mobile(a) -> None:
    """Mobile API for the iOS app (bearer token; never tunnel the `serve` UI instead)."""
    import ipaddress
    import os

    import uvicorn

    try:
        loopback = ipaddress.ip_address(a.host).is_loopback
    except ValueError:
        loopback = a.host == "localhost"
    if not loopback and not a.allow_non_loopback:
        sys.exit(
            f"refusing to bind {a.host}: use 127.0.0.1 and a tunnel (ngrok) for development, "
            "or pass --allow-non-loopback deliberately"
        )
    if a.reference_set:
        os.environ["MOBILE_REFERENCE_SET"] = a.reference_set
    print(f"mobile API on http://{a.host}:{a.port}/v1/health (Authorization: Bearer required)")
    uvicorn.run(
        "placematch.mobile_api:app_factory",
        factory=True,
        host=a.host,
        port=a.port,
        log_level="warning",
        access_log=False,
    )


def cmd_mobile_token(a) -> None:
    """Check/rotate the canonical engine token in the shared private file."""
    import os
    import secrets

    from placematch.env import PRIVATE_ENV, load_env

    load_env()
    env_path = PRIVATE_ENV
    if (
        os.environ.get("MOBILE_API_TOKEN") or os.environ.get("PLACEMATCH_ENGINE_TOKEN")
    ) and not a.create:
        print("Engine token is configured; value not shown")
        return
    if not a.create:
        print("Engine token is not set; run with --create")
        return
    if not env_path.is_file():
        raise RuntimeError("Initialize repository local/.env using scripts/env_contract.py init")
    token = secrets.token_urlsafe(32)
    lines = []
    if env_path.is_file():
        lines = [
            line
            for line in env_path.read_text(encoding="utf-8").splitlines()
            if not line.startswith(("MOBILE_API_TOKEN=", "PLACEMATCH_ENGINE_TOKEN="))
        ]
    lines.append(f"PLACEMATCH_ENGINE_TOKEN={token}")
    temporary = env_path.with_name(env_path.name + ".tmp")
    with temporary.open("x", encoding="utf-8") as stream:
        temporary.chmod(0o600)
        stream.write("\n".join(lines) + "\n")
    temporary.replace(env_path)
    print("Engine token updated in repository local/.env; value not shown.")
    print("Restart the engine and Django; distribute private updates through the external channel.")


def add_query_args(p) -> None:
    p.add_argument("--references", required=True, help="reference photo folder")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--video", help="recorded video file")
    src.add_argument("--queries", help="existing query frame/image folder")
    p.add_argument("--fps", type=float, default=1.0, help="video frame extraction rate")
    p.add_argument("--locations", help="CSV path,location_id (default: reference subfolders)")
    p.add_argument("--timestamps", help="CSV path,timestamp_s for a query folder")


def add_run_args(p) -> None:
    p.add_argument("--top-k", type=int, default=5)
    p.add_argument("--limit", type=int, help="maximum uncached API requests for this run")
    p.add_argument(
        "--verify",
        action="store_true",
        help="SuperPoint+LightGlue verification (off by default; ~1.2 s/frame)",
    )
    p.add_argument("--verify-top", type=int, default=3)
    p.add_argument("--no-overlays", action="store_true")
    p.add_argument("--thresholds", help="calibrated thresholds.json")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="placematch", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("ingest", help="build a manifest from references + video/frames")
    add_query_args(p)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_ingest)

    p = sub.add_parser("estimate", help="expected uncached API requests (sends nothing)")
    p.add_argument("--manifest", required=True)
    p.add_argument("--backend", default=DEFAULT_BACKEND, choices=BACKENDS)
    p.set_defaults(func=cmd_estimate)

    p = sub.add_parser("run", help="retrieve (+verify) and decide for one backend")
    p.add_argument("--manifest", required=True)
    p.add_argument("--backend", default=DEFAULT_BACKEND, choices=BACKENDS)
    p.add_argument("--out", help="output folder (default: <manifest dir>/<backend>)")
    add_run_args(p)
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("match", help="ingest and run one or more backends")
    add_query_args(p)
    p.add_argument("--out", default=str(RUNS_DIR / "latest"))
    p.add_argument("--backend", action="append", choices=BACKENDS, help="repeatable")
    add_run_args(p)
    p.set_defaults(func=cmd_match)

    p = sub.add_parser("calibrate", help="fit thresholds on validation labels")
    p.add_argument("--bench", required=True, help="benchmark dir with labels.json")
    p.add_argument("--runs", nargs="+", required=True, help="results.json per backend")
    p.add_argument("--split", default="validation")
    p.add_argument("--target-far", type=float, default=0.05)
    p.add_argument("--target-precision", type=float, default=0.9)
    p.add_argument("--out", help="default data/calibration/thresholds.json")
    p.set_defaults(func=cmd_calibrate)

    p = sub.add_parser("embed", help="resumable embedding batch with a request limit")
    p.add_argument("--manifest", required=True)
    p.add_argument("--backend", default=DEFAULT_BACKEND, choices=BACKENDS)
    p.add_argument("--limit", type=int, required=True, help="max uncached requests this batch")
    p.add_argument("--subset", help='JSON file with {"image_ids": [...]}')
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_embed)

    p = sub.add_parser("activate-thresholds", help="set the default thresholds file")
    p.add_argument("thresholds")
    p.set_defaults(func=cmd_activate)

    sub.add_parser("evaluate", help="metrics report; arguments of placematch.evaluation.run")

    p = sub.add_parser("serve", help="local web interface")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8777)
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser(
        "build-references", help="build a named reference set index for the mobile API"
    )
    p.add_argument("--references", required=True, help="folder; subfolders are location ids")
    p.add_argument("--name", required=True, help="reference set name")
    p.add_argument("--backend", default=DEFAULT_BACKEND, choices=("megaloc", "vertex"))
    p.add_argument("--limit", type=int, help="maximum uncached API requests (remote backends)")
    p.add_argument("--dry-run", action="store_true", help="show expected requests only")
    p.set_defaults(func=cmd_build_references)

    p = sub.add_parser("serve-mobile", help="mobile API for the iOS app (127.0.0.1:8790)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8790)
    p.add_argument("--reference-set", help="default: MOBILE_REFERENCE_SET or 'default'")
    p.add_argument("--allow-non-loopback", action="store_true")
    p.set_defaults(func=cmd_serve_mobile)

    p = sub.add_parser("mobile-token", help="check or create engine token in repository local/.env")
    p.add_argument("--create", action="store_true")
    p.set_defaults(func=cmd_mobile_token)

    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["evaluate"]:
        from placematch.evaluation.run import main as evaluate_main

        return evaluate_main(argv[1:])
    a = parser.parse_args(argv)
    if a.command == "match" and not a.backend:
        a.backend = [DEFAULT_BACKEND]
    try:
        a.func(a)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
