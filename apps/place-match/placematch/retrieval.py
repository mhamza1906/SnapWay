"""Embed references and queries with one backend, rank by cosine, build a RunResult.

Also: dry-run estimates (requests + estimated cost) and :func:`embed_only`, a resumable
batch that embeds up to a request budget and keeps every vector in the cache.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from placematch.backends.base import (
    EmbeddingBackend,
    EmbeddingIndex,
    EmbedStats,
    RequestBudget,
    RequestLimitExceeded,
)
from placematch.cache import EmbeddingFailed, backend_slug, file_sha256
from placematch.frames import InvalidImage
from placematch.ops.telemetry import hardware, peak_rss_mb, percentiles
from placematch.quality import assess
from placematch.schemas import (
    Candidate,
    Manifest,
    QueryResult,
    ReferenceResult,
    ReverseMatch,
    RunResult,
    RunStats,
)


def _paths(manifest: Manifest, manifest_path: Path) -> dict[str, Path]:
    return {e.image_id: manifest.resolve(e, Path(manifest_path)) for e in manifest.entries}


def cost_estimate(backend: EmbeddingBackend, n_images: int, usage: dict | None = None) -> dict:
    """Estimated USD for ``n_images`` uncached images (None when no verified price)."""
    fn = getattr(backend, "cost_estimate", None)
    if fn is not None:
        return fn(n_images=n_images, usage=usage)
    if not backend.remote:
        return {"usd": 0.0, "pricing_source": "local", "pricing_checked_utc": None}
    return {"usd": None, "pricing_source": None, "pricing_checked_utc": None}


def _readable(paths: list[Path]) -> tuple[list[Path], list[str]]:
    ok, bad = [], []
    for p in paths:
        try:
            if Path(p).stat().st_size == 0:
                bad.append(f"{p}: empty file (0 bytes)")
                continue
            with open(p, "rb"):
                pass
            ok.append(p)
        except OSError as exc:
            bad.append(f"{p}: unreadable: {type(exc).__name__}: {exc.strerror or exc}")
    return ok, bad


def estimate(manifest: Manifest, manifest_path: Path, backend: EmbeddingBackend) -> dict:
    """Count distinct images, cache hits, expected API requests and cost; sends nothing."""
    paths = list(dict.fromkeys(_paths(manifest, manifest_path).values()))
    paths, bad = _readable(paths)
    cache = getattr(backend, "cache", None)
    if cache is None:
        n_cached, n_uncached = 0, len(paths)
    else:
        n_cached, n_uncached = cache.count_uncached(paths)
    expected = backend.requests_for(n_uncached) if backend.remote else 0
    cost = cost_estimate(backend, n_uncached if backend.remote else 0)
    out = {
        "backend": backend.key,
        "provider": backend.config().get("provider"),
        "n_images": len(paths) + len(bad),
        "n_cached": n_cached,
        "n_uncached": n_uncached,
        "expected_requests": expected,
        "cost_usd": cost.get("usd"),
        "pricing_source": cost.get("pricing_source"),
        "pricing_checked_utc": cost.get("pricing_checked_utc"),
        "cost_basis": cost.get("basis"),
    }
    if bad:
        out["unreadable"] = bad
    return out


def _telemetry_delta(backend, mark) -> dict:
    tel = getattr(backend, "telemetry", None)
    return tel.since(mark) if tel is not None else {}


def _run_stats_extra(backend, delta: dict, api_requests: int) -> dict:
    usage = dict(delta.get("usage", {}))
    cost = cost_estimate(backend, api_requests if backend.remote else 0, usage or None)
    lat = {"embed_per_image": percentiles(delta.get("embed_latency_s", []))}
    if delta.get("attempt_latency_s"):
        lat["http_attempt"] = percentiles(delta["attempt_latency_s"])
    if delta.get("events"):
        lat["events"] = delta["events"]
    if delta.get("http_by_host"):
        usage["http_by_host"] = delta["http_by_host"]
    if delta.get("http_status"):
        usage["http_status"] = delta["http_status"]
    return {
        "http_attempts": delta.get("http_attempts", 0),
        "usage": usage,
        "cost_estimate": cost,
        "latency_s": lat,
    }


def embed_only(
    manifest: Manifest,
    manifest_path: Path,
    backend: EmbeddingBackend,
    *,
    budget: RequestBudget,
    allow_partial: bool = True,
    chunk_size: int = 32,
    log: Callable[[str], None] | None = None,
) -> EmbedStats:
    """Resumable batch: embed uncached images (manifest order) up to ``budget``.

    Every vector is written to the backend's cache as soon as it arrives, so an interrupted
    or budget-limited run continues where it stopped on the next call, without repeating
    requests for stored vectors. With ``allow_partial=False`` this keeps the
    :class:`RequestLimitExceeded` semantics (raised before anything is sent). Per-image
    failures are recorded in ``stats.failed`` (each names the file) and do not stop the batch.
    ``stats.telemetry`` carries HTTP attempts, usage and the cost estimate for this call.
    """
    t0 = time.perf_counter()
    stats = EmbedStats()
    tel = getattr(backend, "telemetry", None)
    mark = tel.mark() if tel is not None else None
    paths = list(dict.fromkeys(_paths(manifest, manifest_path).values()))
    paths, bad = _readable(paths)
    stats.failed.extend(bad)
    shas = {}
    for p in paths:
        shas.setdefault(file_sha256(p), p)
    found = backend.cache.get_many(shas)
    stats.cache_hits = len(found)
    pending = [p for s, p in shas.items() if s not in found]
    if pending and backend.remote:
        left = budget.remaining()
        need = backend.requests_for(len(pending))
        if left is not None and need > left:
            if not allow_partial:
                raise RequestLimitExceeded(
                    f"{need} uncached request(s) needed but only {left} left of {budget.limit}"
                )
            n = len(pending)
            while n and backend.requests_for(n) > left:
                n -= 1
            if log:
                log(f"budget allows {n} of {len(pending)} uncached images; rerun to continue")
            pending = pending[:n]
    for i in range(0, len(pending), max(1, chunk_size)):
        chunk = pending[i : i + chunk_size]
        try:
            backend.embed_paths(chunk, budget=budget, stats=stats)
        except EmbeddingFailed:
            pass  # successes are cached; failures are in stats.failed
        if log:
            log(f"embedded {min(i + chunk_size, len(pending))}/{len(pending)}")
    stats.elapsed_s = time.perf_counter() - t0
    delta = _telemetry_delta(backend, mark)
    stats.telemetry = {  # extra attribute (EmbedStats is head-owned); JSON-safe
        **_run_stats_extra(backend, delta, stats.api_requests),
        "remaining_uncached": len(shas) - len(backend.cache.get_many(shas)),
    }
    return stats


def _embed(backend, ids, paths, budget, stats):
    """Embed; on per-image failures keep going with the images that succeeded (all cached)."""
    readable, bad = _readable([paths[i] for i in ids])
    stats.failed.extend(bad)
    ok_paths = {str(p) for p in readable}
    ids = [i for i in ids if str(paths[i]) in ok_paths]
    if not ids:
        return [], None
    try:
        return ids, backend.embed_paths([paths[i] for i in ids], budget=budget, stats=stats)
    except EmbeddingFailed as exc:
        bad = {str(p) for p in exc.failed}
        ok = [i for i in ids if str(paths[i]) not in bad]
        if not ok:
            return [], None
        # Everything left is cached now: no requests, and do not double-count cache hits.
        return ok, backend.embed_paths([paths[i] for i in ok], budget=budget, stats=EmbedStats())


def run_retrieval(
    manifest: Manifest,
    manifest_path: Path,
    backend: EmbeddingBackend,
    *,
    top_k: int = 5,
    reverse_k: int = 5,
    budget: RequestBudget,
    out_dir: Path,
    dry_run: bool = False,
) -> RunResult:
    t_start = time.perf_counter()
    timings: dict[str, float] = {}
    refs, queries = manifest.references(), manifest.queries()
    paths = _paths(manifest, manifest_path)
    est = estimate(manifest, manifest_path, backend)
    base = dict(
        run_id=f"{backend_slug(backend.key)}-{datetime.now(UTC):%Y%m%dT%H%M%S%fZ}",
        created_utc=datetime.now(UTC).isoformat(timespec="seconds"),
        backend=backend.key,
        backend_config=backend.config(),
        manifest=str(manifest_path),
        settings={"top_k": top_k, "reverse_k": reverse_k, "dry_run": dry_run},
    )
    if dry_run:
        stats = RunStats(
            n_references=len(refs),
            n_queries=len(queries),
            expected_uncached_requests=est["expected_requests"],
            api_requests=0,
            cache_hits=est["n_cached"],
            cache_misses=est["n_uncached"],
            timings_s={"total": round(time.perf_counter() - t_start, 4)},
            cost_estimate=cost_estimate(backend, est["n_uncached"] if backend.remote else 0),
        )
        return RunResult(**base, queries=[], stats=stats)
    left = budget.remaining()
    if backend.remote and left is not None and est["expected_requests"] > left:
        raise RequestLimitExceeded(
            f"{est['expected_requests']} uncached request(s) needed, limit leaves {left}"
        )
    cold = getattr(backend, "is_cold", lambda: None)()
    tel = getattr(backend, "telemetry", None)
    mark = tel.mark() if tel is not None else None
    sha_before = set(getattr(tel, "per_sha_s", {})) if tel is not None else set()

    es = EmbedStats()
    t = time.perf_counter()
    quality, q_time = {}, {}
    for q in queries:
        tq = time.perf_counter()
        try:
            quality[q.image_id] = assess(paths[q.image_id])
        except InvalidImage:  # reported once, by the embedding step (same message)
            quality[q.image_id] = None
        except Exception as exc:
            quality[q.image_id] = None
            es.failed.append(f"{paths[q.image_id]}: quality: {type(exc).__name__}: {exc}"[:500])
        q_time[q.image_id] = time.perf_counter() - tq
    timings["quality"] = time.perf_counter() - t

    t = time.perf_counter()
    ref_ids, R = _embed(backend, [e.image_id for e in refs], paths, budget, es)
    qry_ids, Q = _embed(backend, [e.image_id for e in queries], paths, budget, es)
    timings["embed"] = time.perf_counter() - t
    delta = _telemetry_delta(backend, mark)
    per_sha = {  # images embedded during this run only (cache hits cost 0 s here)
        k: v
        for k, v in (getattr(tel, "per_sha_s", {}) if tel else {}).items()
        if k not in sha_before
    }
    base["backend_config"] = backend.config()  # now includes runtime observations

    index_dir = Path(out_dir) / "index" / backend_slug(backend.key)
    ref_index = EmbeddingIndex(backend.key, ref_ids, R if R is not None else np.zeros((0, 0)))
    qry_index = EmbeddingIndex(backend.key, qry_ids, Q if Q is not None else np.zeros((0, 0)))
    ref_index.check_compatible(qry_index)
    ref_index.save(index_dir / "references")
    qry_index.save(index_dir / "queries")

    t = time.perf_counter()
    S = Q @ R.T if (R is not None and Q is not None) else np.zeros((len(qry_ids), len(ref_ids)))
    by_id = {e.image_id: e for e in manifest.entries}
    qrow = {qid: i for i, qid in enumerate(qry_ids)}
    query_results = []
    for e in queries:
        ts = time.perf_counter()
        cands = []
        if e.image_id in qrow and len(ref_ids):
            row = S[qrow[e.image_id]]
            for rank, j in enumerate(np.argsort(-row, kind="stable")[:top_k], start=1):
                rid = ref_ids[j]
                cands.append(
                    Candidate(
                        rank=rank,
                        reference_id=rid,
                        location_id=by_id[rid].location_id,
                        cosine=float(row[j]),
                    )
                )
        search_s = time.perf_counter() - ts
        embed_s = 0.0
        if per_sha and e.image_id in qrow:
            try:  # time spent embedding this image in this run (0 when it was cached)
                embed_s = per_sha.get(file_sha256(paths[e.image_id]), 0.0)
            except OSError:
                pass
        qt = {"quality": q_time[e.image_id], "embed": embed_s, "search": search_s}
        qt["total"] = sum(qt.values())
        query_results.append(
            QueryResult(
                query_id=e.image_id,
                path=str(paths[e.image_id]),
                timestamp_s=e.timestamp_s,
                frame_id=e.frame_id,
                quality=quality[e.image_id],
                candidates=cands,
                timings_s={k: round(v, 5) for k, v in qt.items()},
            )
        )
    ref_results = []
    for j, rid in enumerate(ref_ids):
        col = S[:, j]
        best = np.argsort(-col, kind="stable")[:reverse_k] if len(qry_ids) else []
        ref_results.append(
            ReferenceResult(
                reference_id=rid,
                location_id=by_id[rid].location_id,
                best_queries=[
                    ReverseMatch(
                        query_id=qry_ids[i],
                        cosine=float(col[i]),
                        timestamp_s=by_id[qry_ids[i]].timestamp_s,
                    )
                    for i in best
                ],
            )
        )
    timings["search"] = time.perf_counter() - t
    timings["total"] = time.perf_counter() - t_start

    api_requests = es.api_requests if backend.remote else 0
    stats = RunStats(
        n_references=len(refs),
        n_queries=len(queries),
        expected_uncached_requests=est["expected_requests"],
        api_requests=api_requests,
        cache_hits=es.cache_hits,
        cache_misses=es.cache_misses,
        retries=es.retries,
        failed=len({f.split(": ")[0] for f in es.failed}),
        timings_s={k: round(v, 4) for k, v in timings.items()},
        peak_rss_mb=peak_rss_mb(),
        hardware=hardware(),
        cold_start=cold,
        **_run_stats_extra(backend, delta, api_requests),
    )
    base["settings"].update(
        index_dir=str(index_dir),
        failed_images=sorted(set(es.failed)),
        embedded_references=len(ref_ids),
        embedded_queries=len(qry_ids),
    )
    return RunResult(**base, queries=query_results, references=ref_results, stats=stats)
