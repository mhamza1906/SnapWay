"""Local, resumable MegaLoc embeddings for exported graph photos and a held-out video.

Run with the existing place-match environment. No app writes or remote inference.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, default=str))


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


EMBEDDING_FILES = (
    "reference-rows.json",
    "reference-manifest.json",
    "frames.json",
    "frame-quality.json",
    "embedding-summary.json",
    "embeddings/reference-vectors.npy",
    "embeddings/query-vectors.npy",
)


def guard_reference_resume(output: Path, manifest_hash: str, references: list[dict]) -> None:
    """A changed export requires a new run directory, never mixed descriptor rows."""
    summary = output / "embedding-summary.json"
    rows = output / "reference-rows.json"
    if (
        summary.exists()
        and json.loads(summary.read_text())["reference_manifest_sha256"] != manifest_hash
    ):
        raise ValueError("Reference manifest changed; use a new output directory.")
    if rows.exists() and json.loads(rows.read_text()) != references:
        raise ValueError("Reference row order/content changed; use a new output directory.")


def seal_embedding_artifacts(output: Path) -> None:
    write_json(
        output / "embedding-state.json",
        {"state": "ready", "sha256": {name: file_hash(output / name) for name in EMBEDDING_FILES}},
    )


def validate_embedding_artifacts(output: Path) -> None:
    state = json.loads((output / "embedding-state.json").read_text())
    if state.get("state") != "ready":
        raise ValueError("Embedding run is incomplete; finish the embedding step first.")
    for name in EMBEDDING_FILES:
        if state.get("sha256", {}).get(name) != file_hash(output / name):
            raise ValueError(f"Embedding artifact changed or mixed with another run: {name}")


def validate_source_video(output: Path, video: Path) -> None:
    expected = json.loads((output / "frames.json").read_text())["video_sha256"]
    if file_hash(video) != expected:
        raise ValueError("Video content differs from the video used for embeddings.")


def save_point_vectors(output: Path, references: list[dict], vectors: np.ndarray) -> None:
    """Package each point's separate direction vectors without averaging views."""
    point_root = output / "embeddings" / "points"
    point_root.parent.mkdir(parents=True, exist_ok=True)
    targets = {ref["target_id"] for ref in references}
    groups: dict[str, list[int]] = {}
    for index, ref in enumerate(references):
        groups.setdefault(ref["node_id"], []).append(index)
    with tempfile.TemporaryDirectory(prefix=".point-packages-", dir=point_root.parent) as temporary:
        staging = Path(temporary) / "new"
        staging.mkdir()
        for node_id, indices in groups.items():
            rows = [references[index] for index in indices]
            first = rows[0]
            destination = staging
            if len(targets) > 1:
                destination = destination / first["target_id"]
                destination.mkdir(exist_ok=True)
            np.savez_compressed(
                destination / f"point-{int(first['point_number']):02d}.npz",
                vectors=vectors[indices],
                directions=np.asarray([row["direction"] for row in rows]),
                reference_ids=np.asarray([row["reference_id"] for row in rows]),
                node_id=np.asarray(node_id),
                target_id=np.asarray(first["target_id"]),
                x=np.asarray(first["x"]),
                y=np.asarray(first["y"]),
            )
        old = Path(temporary) / "old"
        if point_root.exists():
            point_root.rename(old)
        try:
            staging.rename(point_root)
        except BaseException:
            if old.exists():
                old.rename(point_root)
            raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--references", type=Path, required=True, help="Export manifest.json")
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--fps", type=float, default=2)
    parser.add_argument("--batch-size", type=int, default=4)
    args = parser.parse_args()
    if not 0 < args.fps <= 10:
        parser.error("Use a positive sampling rate up to 10 fps.")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / "embeddings").mkdir(exist_ok=True)
    manifest = json.loads(args.references.read_text())
    references = manifest["references"]
    if not references:
        raise ValueError("No exported reference photographs.")
    guard_reference_resume(output, file_hash(args.references), references)
    reference_root = args.references.resolve().parent
    reference_paths = [reference_root / ref["path"] for ref in references]
    for ref, path in zip(references, reference_paths, strict=True):
        if file_hash(path) != ref["sha256"]:
            raise ValueError(f"Reference content changed: {ref['reference_id']}")
    source_hash = file_hash(args.video)
    frames_file = output / "frames.json"
    from placematch.frames import extract_video

    if frames_file.exists():
        frames_data = json.loads(frames_file.read_text())
        if frames_data["video_sha256"] != source_hash or frames_data["fps"] != args.fps:
            raise ValueError("Existing frames belong to another video or sampling rate.")
        frames = frames_data["frames"]
    else:
        print("Extracting upright frames with source presentation timestamps", flush=True)
        entries = extract_video(args.video.resolve(), output / "frames", fps=args.fps)
        frames = []
        for entry in entries:
            row = entry.model_dump(mode="json")
            row["path"] = str(Path(entry.path).relative_to(output))
            row["sha256"] = file_hash(Path(entry.path))
            frames.append(row)
        frames_data = {
            "video": str(args.video.resolve()),
            "video_sha256": source_hash,
            "fps": args.fps,
            "frames": frames,
        }
        write_json(frames_file, frames_data)
    query_paths = [output / frame["path"] for frame in frames]
    if any(not path.is_file() for path in query_paths):
        raise ValueError("An extracted frame is missing.")
    for frame, path in zip(frames, query_paths, strict=True):
        if file_hash(path) != frame["sha256"]:
            raise ValueError(f"Extracted frame content changed: {frame['path']}")
    if {ref["sha256"] for ref in references} & {frame["sha256"] for frame in frames}:
        raise ValueError("Reference/query byte overlap: refuse a leaked evaluation.")
    print(f"Embedding {len(references)} references and {len(frames)} video samples", flush=True)
    write_json(output / "embedding-state.json", {"state": "building"})
    write_json(output / "reference-rows.json", references)
    write_json(output / "reference-manifest.json", manifest)

    import torch

    from placematch.backends import megaloc
    from placematch.backends.base import EmbedStats, RequestBudget

    model_cache = args.model_cache.resolve()
    megaloc.CODE_PATH = model_cache / f"repo-{megaloc.COMMIT}" / "megaloc_model.py"
    megaloc.WEIGHTS_PATH = model_cache / f"hf-{megaloc.HF_REVISION}" / "model.safetensors"
    backend = megaloc.MegaLocBackend(batch_size=args.batch_size, cache_root=output / "cache")
    budget = RequestBudget(limit=0)
    t0 = time.perf_counter()
    model = megaloc.load_model(backend.telemetry)
    model_load_s = time.perf_counter() - t0
    print(f"MegaLoc loaded on {megaloc.device_name()} in {model_load_s:.2f}s", flush=True)
    summary = {
        "model": backend.config(),
        "torch_version": torch.__version__,
        "reference_root": str(reference_root),
        "reference_manifest_sha256": file_hash(args.references),
        "video_sha256": source_hash,
        "sample_fps": args.fps,
        "batch_size": args.batch_size,
        "model_load_s": model_load_s,
        "remote_inference_requests": 0,
    }
    for name, paths in (("reference", reference_paths), ("query", query_paths)):
        stats = EmbedStats()
        chunks = []
        started = time.perf_counter()
        for i in range(0, len(paths), 16):
            chunks.append(backend.embed_paths(paths[i : i + 16], budget=budget, stats=stats))
            print(f"{name}: {min(i + 16, len(paths))}/{len(paths)}", flush=True)
        vectors = np.concatenate(chunks).astype(np.float32)
        if vectors.shape != (len(paths), 8448) or not np.isfinite(vectors).all():
            raise ValueError("Invalid MegaLoc descriptors.")
        norms = np.linalg.norm(vectors, axis=1)
        if not np.allclose(norms, 1, atol=1e-4):
            raise ValueError("Descriptors are not unit-normalized.")
        np.save(output / "embeddings" / f"{name}-vectors.npy", vectors)
        if name == "reference":
            save_point_vectors(output, references, vectors)
        summary[name] = {
            **asdict(stats),
            "total_s": time.perf_counter() - started,
            "shape": list(vectors.shape),
            "norm_min": float(norms.min()),
            "norm_max": float(norms.max()),
        }
        write_json(output / "embedding-summary.json", summary)
    # Measure uncached single-frame work, including decode/preprocess and GPU completion.
    latencies = []
    device = next(model.parameters()).device
    for path in query_paths[:12]:
        if device.type == "mps":
            torch.mps.synchronize()
        started = time.perf_counter()
        tensor = backend._tensor(path).unsqueeze(0).to(device)
        with torch.inference_mode():
            descriptor = model(tensor).float().cpu().numpy()
        assert descriptor.shape == (1, 8448)
        latencies.append(1000 * (time.perf_counter() - started))
    summary["warm_single_frame_ms"] = {
        "samples": len(latencies),
        "median": float(np.median(latencies)),
        "p95": float(np.percentile(latencies, 95)),
        "values": latencies,
        "includes": "JPEG decode, upright preprocessing, model and GPU-to-CPU completion",
    }
    summary["remote_inference_requests"] = budget.used
    write_json(output / "embedding-summary.json", summary)
    from placematch.quality import assess

    write_json(output / "frame-quality.json", [assess(p).model_dump() for p in query_paths])
    # Keep the standard vectors/index.txt form available for future catalog packaging.
    from placematch.backends.base import EmbeddingIndex

    EmbeddingIndex(
        backend.key,
        [ref["reference_id"] for ref in references],
        np.load(output / "embeddings/reference-vectors.npy"),
    ).save(output / "reference-index")
    write_json(
        output / "reference-index/locations.json",
        {
            ref["reference_id"]: {
                key: ref[key]
                for key in (
                    "node_id",
                    "point_number",
                    "direction",
                    "target_id",
                    "revision_id",
                    "x",
                    "y",
                    "floor",
                )
            }
            for ref in references
        },
    )
    write_json(output / "reference-index/meta.json", summary["model"])
    seal_embedding_artifacts(output)
    print(
        json.dumps(
            {
                "references": len(references),
                "query_frames": len(frames),
                "device": megaloc.device_name(),
                "remote_requests": budget.used,
            }
        ),
        flush=True,
    )
    backend.release()


if __name__ == "__main__":
    main()
