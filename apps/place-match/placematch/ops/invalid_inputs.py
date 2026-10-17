"""Invalid and unsupported inputs: ``python -m placematch.ops.invalid_inputs``.

Builds fixtures under ``runs/ops/fixtures/invalid/`` from a real 7-Scenes frame (read-only
source): truncated JPEG, empty file, text renamed ``.jpg``, real HEIC (macOS ``sips``),
random-bytes / truncated / empty ``.mp4``; plus valid images. Then runs ingest, quality,
MegaLoc and Vertex retrieval (valid images are already cached: 0 Vertex requests; invalid
images fail before any request is sent) and verification, recording every error message.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import sys
import warnings
from pathlib import Path

import numpy as np
from PIL import Image

from placematch.backends import get_backend
from placematch.backends.base import RequestBudget
from placematch.frames import InvalidImage, InvalidVideo, extract_video, ingest_images
from placematch.ops.common import OPS_DIR, ledger_add, now, rel, write_json
from placematch.quality import assess
from placematch.retrieval import estimate, run_retrieval
from placematch.schemas import Manifest, ManifestEntry
from placematch.verify import verify_pair

FIX = OPS_DIR / "fixtures" / "invalid"


def build_fixtures() -> dict[str, Path]:
    if FIX.exists():
        shutil.rmtree(FIX)
    (FIX / "refs").mkdir(parents=True)
    (FIX / "queries").mkdir()
    (FIX / "videos").mkdir()
    subset = Manifest.model_validate_json(
        (OPS_DIR / "vertex_compare_manifest.json").read_text(encoding="utf-8")
    )  # images already embedded by vertex_compare -> Vertex cache hits, 0 requests
    chess = [Path(e.path) for e in subset.entries if e.scene_id == "chess"]
    frames = chess[:3]
    for i, f in enumerate(frames):  # valid: byte copies (same sha256 as bench images)
        shutil.copyfile(f, FIX / "refs" / f"ref{i}.png")
    shutil.copyfile(chess[-1], FIX / "queries" / "valid.png")
    buf = io.BytesIO()
    Image.open(frames[2]).convert("RGB").save(buf, format="JPEG", quality=90)
    jpg = buf.getvalue()
    q = FIX / "queries"
    (q / "corrupt.jpg").write_bytes(jpg[: len(jpg) * 2 // 5])  # truncated JPEG
    (q / "garbage_header.jpg").write_bytes(b"\xff\xd8\xff\xe0" + bytes(range(256)) * 8)
    (q / "empty.jpg").write_bytes(b"")
    (q / "text.jpg").write_text("this is a text file, not a photo\n", encoding="utf-8")
    heic = q / "photo.heic"
    subprocess.run(
        ["sips", "-s", "format", "heic", str(frames[0]), "--out", str(heic)],
        capture_output=True, check=False,
    )  # fmt: skip
    v = FIX / "videos"
    (v / "empty.mp4").write_bytes(b"")
    (v / "garbage.mp4").write_bytes(np.random.default_rng(0).bytes(200_000))
    ok = v / "ok.mp4"
    seq = FIX / "seq"
    seq.mkdir()
    for i, f in enumerate(chess[:6]):
        shutil.copyfile(f, seq / f"{i:03d}.png")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-framerate", "2", "-i", str(seq / "%03d.png"),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(ok)],
        check=True,
    )  # fmt: skip
    shutil.rmtree(seq)
    data = ok.read_bytes()
    (v / "truncated.mp4").write_bytes(data[: len(data) // 3])
    (v / "text.mp4").write_text("not a video\n", encoding="utf-8")
    return {"heic_created": heic.is_file() and heic.stat().st_size > 0}


def main(argv: list[str] | None = None) -> int:
    info = build_fixtures()
    out: dict = {"created_utc": now(), "fixtures": rel(FIX), **info}
    q = FIX / "queries"

    # ingest: unsupported HEIC is skipped with a warning naming the file
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        qe = ingest_images(q, "query")
    out["ingest"] = {
        "indexed": [e.frame_id for e in qe],
        "warnings": [str(x.message) for x in w],
    }
    re = ingest_images(FIX / "refs", "reference", location_map={})
    for e in re:
        e.location_id = "chess"
    # add the HEIC explicitly (as a user-supplied manifest might) to test the loader message
    qe.append(
        ManifestEntry(
            image_id="query:photo.heic", path=str(q / "photo.heic"), role="query",
            dataset="user", scene_id="queries",
        )
    )  # fmt: skip
    qe.append(
        ManifestEntry(
            image_id="query:missing.jpg", path=str(q / "missing.jpg"), role="query",
            dataset="user", scene_id="queries",
        )
    )  # fmt: skip
    m = Manifest(name="invalid-inputs", entries=re + qe)
    mp = FIX / "manifest.json"
    mp.write_text(m.model_dump_json(indent=1), encoding="utf-8")

    # direct loader / quality messages
    msgs = {}
    for e in qe:
        try:
            assess(Path(e.path))
            msgs[Path(e.path).name] = "ok"
        except InvalidImage as exc:
            msgs[Path(e.path).name] = str(exc).replace(str(FIX), "<fixtures>")
    out["load_errors"] = msgs

    runs = {}
    for name in ("megaloc", "vertex"):
        b = get_backend(name)
        est = estimate(m, mp, b)
        print(name, "dry run:", json.dumps({k: est[k] for k in ("n_cached", "n_uncached")}))
        # Budget = estimate: invalid files count as uncached but fail before sending.
        try:
            run = run_retrieval(
                m, mp, b, budget=RequestBudget(limit=est["expected_requests"]),
                out_dir=FIX / f"run-{name}",
            )  # fmt: skip
        except Exception as exc:  # the check is that this does NOT happen
            runs[name] = {"crashed": f"{type(exc).__name__}: {exc}"}
            continue
        if name == "vertex":
            ledger_add("invalid_inputs", run.stats.api_requests, run.stats.http_attempts, "")
        runs[name] = {
            "estimate_expected_requests": est["expected_requests"],
            "unreadable_in_estimate": [
                s.replace(str(FIX), "<fixtures>") for s in est.get("unreadable", [])
            ],
            "api_requests": run.stats.api_requests,
            "http_attempts": run.stats.http_attempts,
            "failed_count": run.stats.failed,
            "failed_images": [
                s.replace(str(FIX), "<fixtures>") for s in run.settings["failed_images"]
            ],
            "embedded_references": run.settings["embedded_references"],
            "embedded_queries": run.settings["embedded_queries"],
            "query_with_candidates": [r.query_id for r in run.queries if r.candidates],
            "queries_without_candidates": [r.query_id for r in run.queries if not r.candidates],
        }
        b.release()
    out["retrieval"] = runs

    v = verify_pair(q / "corrupt.jpg", FIX / "refs" / "ref0.png")
    out["verify_corrupt_pair"] = {
        "status": v.status,
        "message": v.message.replace(str(FIX), "<fixtures>"),
    }
    vids = {}
    for p in sorted((FIX / "videos").iterdir()):
        try:
            entries = extract_video(p, FIX / "frames", fps=1.0)
            vids[p.name] = f"ok: {len(entries)} frames"
        except InvalidVideo as exc:
            vids[p.name] = f"InvalidVideo: {str(exc).replace(str(FIX), '<fixtures>')[:300]}"
        except Exception as exc:
            vids[p.name] = f"UNEXPECTED {type(exc).__name__}: {str(exc)[:300]}"
    out["videos"] = vids
    path = write_json("invalid_inputs.json", out)
    print(json.dumps(out, indent=2)[:6000])
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
