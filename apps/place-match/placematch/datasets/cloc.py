"""CLoc indoor localisation datasets (NEB1, NEB2, SFB): subset download and loading.

Source: https://github.com/kimjh069/CLoc (data on the authors' public Google Drive folder
https://drive.google.com/drive/folders/12e2J_Eg7lICdEyDwDxKJHEDBoy5ytwAS).
Licence: CC BY-NC 4.0 (repository LICENSE).

Each building zip contains ``Database/images`` (reference images captured earlier),
``Database/sfm_model`` (COLMAP binary model: reference poses + sparse 3D points) and
``Query/{query_sequences,ground_truth,intrinsic}`` (smartphone query sequences captured
months later, with 6-DoF ground-truth poses in pickle files).

The archives are 2.6-8 GB; this module reads their central directories with HTTP range
requests and fetches only the metadata plus the images that are selected.

The ground-truth pickles are untrusted input. They are loaded with a restricted
unpickler that only resolves the three numpy names needed to rebuild plain arrays and
refuses everything else.

CLI::

    uv run python -m placematch.datasets.cloc metadata      # sfm models, GT, intrinsics
    uv run python -m placematch.datasets.cloc images --select data/raw/cloc/selection.json
"""

from __future__ import annotations

import argparse
import io
import json
import pickle
import zipfile
from pathlib import Path

import numpy as np

from placematch.datasets.remote_zip import HttpRangeFile, extract_member
from placematch.env import DATA_DIR

REPO_URL = "https://github.com/kimjh069/CLoc"
DRIVE_FOLDER = "https://drive.google.com/drive/folders/12e2J_Eg7lICdEyDwDxKJHEDBoy5ytwAS"
LICENSE = "CC BY-NC 4.0 (https://github.com/kimjh069/CLoc/blob/main/LICENSE)"
CITATION = (
    "J. Kim et al. CLoc: Confident Initial Estimation of Long-Term Visual Localization Using "
    "a Few Sequential Images in Large-Scale Spaces. IEEE Sensors Journal 23(8), 2023."
)
FILE_IDS = {
    "NEB1": "1bG_Yr5pQ-n7EU4yG9V2j7Gk7VUyWNdhA",
    "NEB2": "1Iy75zUNXaRM9_0QJ_Mc4tPRWR64Gm5TO",
    "SFB": "1ySgRnf4HOfapdZhrfeLLngMNKqn10Myr",
}
RAW_DIR = DATA_DIR / "raw" / "cloc"


def drive_url(building: str) -> str:
    return (
        "https://drive.usercontent.google.com/download?"
        f"id={FILE_IDS[building]}&export=download&confirm=t"
    )


class _NumpyOnlyUnpickler(pickle.Unpickler):
    """Resolves only the globals numpy uses to pickle a plain ndarray."""

    _ALLOWED = {
        ("numpy.core.multiarray", "_reconstruct"),
        ("numpy._core.multiarray", "_reconstruct"),
        ("numpy", "ndarray"),
        ("numpy", "dtype"),
    }

    def find_class(self, module: str, name: str):
        if (module, name) not in self._ALLOWED:
            raise pickle.UnpicklingError(f"refusing global {module}.{name}")
        if name == "_reconstruct":
            from numpy._core.multiarray import _reconstruct

            return _reconstruct
        return getattr(np, name)


def safe_load_gt_pickle(data: bytes) -> dict[str, list[np.ndarray]]:
    obj = _NumpyOnlyUnpickler(io.BytesIO(data)).load()
    if not isinstance(obj, dict):
        raise ValueError("ground-truth pickle is not a dict")
    out = {}
    for k, v in obj.items():
        if not isinstance(k, str):
            raise ValueError("non-string key in ground-truth pickle")
        out[k] = [np.asarray(x, dtype=np.float64) for x in v]
    return out


def _open(building: str) -> tuple[HttpRangeFile, zipfile.ZipFile]:
    raw = HttpRangeFile(drive_url(building))
    return raw, zipfile.ZipFile(io.BufferedReader(raw, 1 << 20))


def download_metadata(building: str, *, root: Path = RAW_DIR, sfm: bool = True) -> dict:
    """Fetch intrinsics, all GT pickles (merged into gt_poses.json) and the SfM model."""
    raw, z = _open(building)
    out = root / building
    names = [i.filename for i in z.infolist() if not i.filename.endswith("/")]
    wanted = [n for n in names if "/Query/intrinsic/" in n or n.endswith(".pickle")]
    if sfm:
        wanted += [n for n in names if "/Database/sfm_model/" in n]
    for n in wanted:
        extract_member(z, n, out / n.split("/", 1)[1])
    gt: dict[str, list[list[float]]] = {}
    for n in names:
        if n.endswith(".pickle"):
            for key, (pos, quat) in safe_load_gt_pickle(z.read(n)).items():
                gt[key] = [pos.tolist(), quat.tolist()]
    (out / "gt_poses.json").write_text(json.dumps(gt, indent=1))
    listing = {
        "building": building,
        "url": drive_url(building),
        "archive_bytes": raw.size,
        "db_images": [n for n in names if "/Database/images/" in n],
        "query_images": [n for n in names if "/Query/query_sequences/" in n],
        "sizes": {i.filename: i.file_size for i in z.infolist()},
    }
    (out / "listing.json").write_text(json.dumps(listing, indent=1))
    log = {"building": building, "metadata_bytes_downloaded": raw.bytes_fetched}
    (out / "metadata_log.json").write_text(json.dumps(log, indent=2))
    raw.close()
    return log


def download_images(building: str, members: list[str], *, root: Path = RAW_DIR) -> dict:
    raw, z = _open(building)
    out = root / building
    for n in members:
        extract_member(z, n, out / n.split("/", 1)[1])
    log = {"building": building, "images": len(members), "bytes_downloaded": raw.bytes_fetched}
    prev = out / "images_log.json"
    hist = json.loads(prev.read_text()) if prev.is_file() else []
    hist.append(log)
    prev.write_text(json.dumps(hist, indent=2))
    raw.close()
    return log


def load_intrinsics(building: str, root: Path = RAW_DIR) -> tuple[np.ndarray, np.ndarray]:
    d = root / building / "Query" / "intrinsic"
    K = np.loadtxt(d / "intrinsic.txt", dtype=np.float64).reshape(3, 3)
    dist = np.loadtxt(d / "distortion.txt", dtype=np.float64).reshape(-1)
    return K, dist


def load_gt(building: str, root: Path = RAW_DIR) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    raw = json.loads((root / building / "gt_poses.json").read_text())
    return {k: (np.array(v[0]), np.array(v[1])) for k, v in raw.items()}


#: Buildings whose database images form part of the reference pool. SFB is held out
#: (queries only) so it provides real "place absent from the references" queries.
REFERENCE_BUILDINGS = ("NEB1", "NEB2")
#: SFB query sessions used per split (whole recording sessions, never mixed).
SFB_SPLIT_SESSIONS = {
    "validation": "query-20210526-151031-10",
    "test": "query-20210607-083715-10",
}


def _rig_groups(names: list[str]) -> dict[str, list[str]]:
    """Database images are 4-camera rig captures named ``<timestamp>_<cam>.png``."""
    groups: dict[str, list[str]] = {}
    for n in sorted(names):
        groups.setdefault(n.rsplit("_", 1)[0], []).append(n)
    return groups


def farthest_point_order(points: np.ndarray, k: int) -> list[int]:
    """Deterministic farthest-point sampling starting from index 0."""
    chosen = [0]
    d = np.linalg.norm(points - points[0], axis=1)
    while len(chosen) < min(k, len(points)):
        nxt = int(np.argmax(d))
        chosen.append(nxt)
        d = np.minimum(d, np.linalg.norm(points - points[nxt], axis=1))
    return chosen


def _chunks(query_members: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for n in sorted(query_members):
        rel = n.split("/query_sequences/")[1]
        out.setdefault("/".join(rel.split("/")[:2]), []).append(n)
    return out


def _spread(items: list[str], k: int) -> list[str]:
    return [items[int(len(items) * (i + 0.5) / k)] for i in range(min(k, len(items)))]


def select_subset(
    *,
    root: Path = RAW_DIR,
    target_refs: int = 45,
    min_points: int = 150,
    queries_per_chunk: int = 2,
) -> dict:
    """Choose reference and query members deterministically from metadata only.

    References: only database images with >= ``min_points`` registered SfM points (the
    ground-truth co-visibility test needs observed structure; about half of the rig images
    have almost none). Rig positions holding at least one such image are ordered by
    farthest-point sampling over their camera centres; all qualifying images at each
    position are taken until ``target_refs`` images are reached.
    Queries: ``queries_per_chunk`` evenly spaced frames from every query chunk (chunks of
    <=50 consecutive frames as distributed). NEB chunks alternate validation/test by sorted
    chunk order; SFB uses one whole recording session per split.
    """
    from placematch.datasets import colmap_io

    sel: dict = {
        "rules": select_subset.__doc__.strip(),
        "params": {
            "target_refs": target_refs,
            "min_points": min_points,
            "queries_per_chunk": queries_per_chunk,
        },
        "buildings": {},
    }
    for b in ("NEB1", "NEB2", "SFB"):
        lst = json.loads((root / b / "listing.json").read_text())
        entry: dict = {"references": [], "queries": {"validation": [], "test": []}}
        if b in REFERENCE_BUILDINGS:
            ims = colmap_io.read_images(root / b / "Database" / "sfm_model" / "images.bin")
            by_name = {i.name: i for i in ims.values()}
            good = {
                n for n, im in by_name.items() if int((im.point3D_ids >= 0).sum()) >= min_points
            }
            groups = {k: [n for n in v if n in good] for k, v in _rig_groups(list(by_name)).items()}
            groups = {k: v for k, v in groups.items() if v}
            keys = list(groups)
            centres = np.array(
                [
                    np.mean(
                        [
                            -colmap_io.qvec_to_rotmat(by_name[n].qvec).T @ by_name[n].tvec
                            for n in groups[k]
                        ],
                        axis=0,
                    )
                    for k in keys
                ]
            )
            chosen: list[str] = []
            for i in farthest_point_order(centres, len(keys)):
                if len(chosen) >= target_refs:
                    break
                chosen += groups[keys[i]]
            entry["references"] = [f"{b}/Database/images/{n}" for n in sorted(chosen)]
            for ci, (_chunk, members) in enumerate(_chunks(lst["query_images"]).items()):
                split = "validation" if ci % 2 == 0 else "test"
                entry["queries"][split] += _spread(members, queries_per_chunk)
        else:
            for split, session in SFB_SPLIT_SESSIONS.items():
                for chunk, members in _chunks(lst["query_images"]).items():
                    if chunk.startswith(session + "/"):
                        entry["queries"][split] += _spread(members, queries_per_chunk)
        sel["buildings"][b] = entry
    return sel


#: placematch-v2: SFB becomes a reference building; its third recording (never a bench-v1
#: query) provides the new held-out test queries. NEB query sessions were bench-v1 queries
#: and are development data only.
V2_TEST_SESSIONS = {"SFB": "query-20210607-083241-10"}
V2_SFB_TARGET_REFS = 90
V2_QUERY_STRIDE = 1  # every listed frame is a candidate (the session is already 1/10)
V2_QUERY_SPACING = (1.0, 20.0)  # metres / degrees from every query already chosen
V2_MAX_QUERIES = 120


def _gt_pose_w2c(t: np.ndarray, q: np.ndarray) -> np.ndarray:
    from placematch.datasets.colmap_io import qvec_to_rotmat

    m = np.eye(4)
    m[:3, :3] = qvec_to_rotmat(q)
    m[:3, 3] = t
    return m


def spaced_queries(
    members: list[str], gt: dict, *, stride: int, spacing: tuple[float, float], k: int
) -> list[str]:
    """Pose-spaced subsample of a query session (no consecutive near-duplicates)."""
    import re

    def num(n: str) -> int:
        return int(re.search(r"(\d+)\.jpg$", n).group(1))

    cands = []
    ordered = sorted(members, key=lambda n: (n.rsplit("/", 1)[0], num(n)))
    for i, n in enumerate(ordered):
        rel = n.split("/query_sequences/")[1]
        if i % stride == 0 and rel in gt:
            cands.append((n, _gt_pose_w2c(*gt[rel])))
    chosen: list[tuple[str, np.ndarray]] = []
    for n, w2c in cands:
        c = -w2c[:3, :3].T @ w2c[:3, 3]
        ok = True
        for _, o in chosen:
            co = -o[:3, :3].T @ o[:3, 3]
            r = w2c[:3, :3] @ o[:3, :3].T
            ang = np.degrees(np.arccos(np.clip((np.trace(r) - 1) / 2, -1, 1)))
            if np.linalg.norm(c - co) < spacing[0] and ang < spacing[1]:
                ok = False
                break
        if ok:
            chosen.append((n, w2c))
    names = [n for n, _ in chosen]
    if len(names) > k:  # keep an even spread over the session
        names = [names[int(len(names) * (i + 0.5) / k)] for i in range(k)]
    return names


def select_v2(*, root: Path = RAW_DIR) -> dict:
    """placematch-v2 CLoc selection (v1 selection kept for NEB references + dev queries)."""
    from placematch.datasets import colmap_io

    v1 = json.loads((root / "selection.json").read_text())
    sel: dict = {
        "rules": (
            "NEB1/NEB2 references and all bench-v1 queries are kept from selection.json "
            "(bench-v1 queries are development data). SFB references: same rule as v1 "
            f"(>= 150 registered SfM points, farthest-point rig positions) with target "
            f"{V2_SFB_TARGET_REFS}. New test queries: SFB session "
            f"{V2_TEST_SESSIONS['SFB']} (never used in bench-v1; distributed as every 10th "
            f"camera frame), every {V2_QUERY_STRIDE}. listed frame, kept only when >= "
            f"{V2_QUERY_SPACING[0]} m or >= "
            f"{V2_QUERY_SPACING[1]} deg from every query already kept, at most "
            f"{V2_MAX_QUERIES} (even spread)."
        ),
        "buildings": {},
    }
    for b in ("NEB1", "NEB2", "SFB"):
        e1 = v1["buildings"][b]
        entry = {
            "references": list(e1["references"]),
            "dev_queries": e1["queries"]["validation"] + e1["queries"]["test"],
            "test_queries": [],
        }
        if b == "SFB":
            ims = colmap_io.read_images(root / b / "Database" / "sfm_model" / "images.bin")
            by_name = {i.name: i for i in ims.values()}
            good = {n for n, im in by_name.items() if int((im.point3D_ids >= 0).sum()) >= 150}
            groups = {k: [n for n in v if n in good] for k, v in _rig_groups(list(by_name)).items()}
            groups = {k: v for k, v in groups.items() if v}
            keys = list(groups)
            centres = np.array(
                [
                    np.mean(
                        [
                            -colmap_io.qvec_to_rotmat(by_name[n].qvec).T @ by_name[n].tvec
                            for n in groups[k]
                        ],
                        axis=0,
                    )
                    for k in keys
                ]
            )
            chosen: list[str] = []
            for i in farthest_point_order(centres, len(keys)):
                if len(chosen) >= V2_SFB_TARGET_REFS:
                    break
                chosen += groups[keys[i]]
            entry["references"] = [f"{b}/Database/images/{n}" for n in sorted(chosen)]
            lst = json.loads((root / b / "listing.json").read_text())
            sess = V2_TEST_SESSIONS[b]
            members = [n for n in lst["query_images"] if f"/query_sequences/{sess}/" in n]
            entry["test_queries"] = spaced_queries(
                members,
                load_gt(b, root),
                stride=V2_QUERY_STRIDE,
                spacing=V2_QUERY_SPACING,
                k=V2_MAX_QUERIES,
            )
        sel["buildings"][b] = entry
    return sel


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m placematch.datasets.cloc")
    sub = ap.add_subparsers(dest="cmd", required=True)
    md = sub.add_parser("metadata")
    md.add_argument("--buildings", nargs="*", default=["NEB1", "NEB2", "SFB"])
    md.add_argument("--no-sfm", nargs="*", default=["SFB"], help="buildings to skip SfM for")
    sl = sub.add_parser("select", help="write data/raw/cloc/selection.json from metadata")
    sl.add_argument("--target-refs", type=int, default=45)
    sl.add_argument("--min-points", type=int, default=150)
    sl.add_argument("--queries-per-chunk", type=int, default=2)
    sub.add_parser("select-v2", help="write data/raw/cloc/selection_v2.json")
    im = sub.add_parser("images", help="fetch the selected images")
    im.add_argument("--select", type=Path, default=RAW_DIR / "selection.json")
    args = ap.parse_args(argv)
    if args.cmd == "metadata":
        for b in args.buildings:
            print(download_metadata(b, sfm=b not in args.no_sfm))
    elif args.cmd == "select":
        sel = select_subset(
            target_refs=args.target_refs,
            min_points=args.min_points,
            queries_per_chunk=args.queries_per_chunk,
        )
        (RAW_DIR / "selection.json").write_text(json.dumps(sel, indent=1))
        for b, e in sel["buildings"].items():
            q = {k: len(v) for k, v in e["queries"].items()}
            print(b, "refs", len(e["references"]), "queries", q)
    elif args.cmd == "select-v2":
        sel = select_v2()
        (RAW_DIR / "selection_v2.json").write_text(json.dumps(sel, indent=1))
        for b, e in sel["buildings"].items():
            print(b, "refs", len(e["references"]), "test queries", len(e["test_queries"]))
    else:
        sel = json.loads(args.select.read_text())
        for b, e in sel["buildings"].items():
            if "queries" in e:
                members = e["references"] + e["queries"]["validation"] + e["queries"]["test"]
            else:
                members = e["references"] + e["dev_queries"] + e["test_queries"]
            print(download_images(b, members))


if __name__ == "__main__":
    main()
