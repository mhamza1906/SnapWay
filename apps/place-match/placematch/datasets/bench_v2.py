"""Build ``placematch-v2``: four dataset families, recording-level splits, raw label scores.

Run ``uv run python -m placematch.datasets.bench build --version v2`` (deterministic: no
randomness except seeded orderings). Inputs are the subsets fetched by
``sevenscenes download --subset v2``, ``twelvescenes fetch``, ``cloc select-v2 / images``
and ``mapfree fetch`` (see DATASETS.md).

Outputs in ``data/bench/placematch-v2/``: ``manifest.json``, ``labels.json``,
``raw_scores.json`` (every co-visibility score behind every label), ``summary.json``,
``splits.json``, ``paired_subset.json``, ``robustness_vertex_subset.json``,
``label_changelog.jsonl``, ``duplicates.json`` and ``robustness/`` (derived images).

Split rules (INTERFACES.md, v2 phase):
* ``development``: every bench-v1 query recording (7-Scenes chess 03/05, fire 03/04,
  heads 01, stairs 01/04, office 02/06; CLoc NEB1/NEB2 sessions and SFB sessions
  20210526-151031 / 20210607-083715). Agent-inspected pairs are all bench-v1 queries.
* ``validation`` / ``test``: whole recordings never used as bench-v1 queries; a recording
  is in exactly one split. ``eval_sets=["location_disjoint"]`` marks test queries whose
  location has no validation query.
* Robustness variants: ``eval_sets=["robustness"]``, same split as their source,
  ``derived_from`` set; never part of the main tables.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from placematch.datasets import cloc, mapfree, sevenscenes, twelvescenes
from placematch.datasets.imagestats import (
    NEAR_DUP_BITS,
    StatsCache,
    near_duplicate_pairs,
)
from placematch.datasets.overlap import PinholeK, SfmVisibility, depth_overlap
from placematch.env import DATA_DIR
from placematch.schemas import (
    Intrinsics,
    LabelSet,
    Manifest,
    ManifestEntry,
    Pose,
    QueryLabel,
    SourceInfo,
)

NAME = "placematch-v2"
BENCH_DIR = DATA_DIR / "bench"
V1_DIR = BENCH_DIR / "placematch-v1"
INSPECTION_FILE = Path(__file__).with_name("agent_inspection_v1.json")
LABEL_VERSION = "v2"
AGENT_INSPECTOR = "agent (Claude, bench-v1 datasets subagent); not human reviewed"
SEED = "placematch-v2"
PAIRED_MAX_IMAGES = 4500
ROBUSTNESS_MAX_IMAGES = 400

# ----------------------------------------------------------------------- label boundaries
DEPTH_POS, DEPTH_AMB = 0.30, 0.10  # 7-Scenes and 12-Scenes depth re-projection overlap
CLOC_POS = {"shared": 50, "coverage_query": 0.30, "coverage_reference": 0.20}
CLOC_AMB = {"shared": 15, "coverage_any": 0.10}
MAPFREE_POS, MAPFREE_AMB = mapfree.POSITIVE_OVERLAP, mapfree.AMBIGUOUS_OVERLAP
BOUNDARIES = {
    "7scenes": {"positive": DEPTH_POS, "ambiguous": DEPTH_AMB, "score": "depth_overlap"},
    "12scenes": {"positive": DEPTH_POS, "ambiguous": DEPTH_AMB, "score": "depth_overlap"},
    "cloc": {"positive": CLOC_POS, "ambiguous": CLOC_AMB, "score": "sfm_covisibility"},
    "mapfree": {
        "positive": MAPFREE_POS,
        "ambiguous": MAPFREE_AMB,
        "score": "mapfree_overlaps_npz (dataset-native SfM co-visibility)",
    },
}

# ----------------------------------------------------------------------- conditions
BLUR_LAPVAR = 40.0  # variance of Laplacian at 640 px long side, below => real:motion_blur
VIEWPOINT_DEG = 30.0  # relative rotation to the best positive >= => real:viewpoint_change
DISTANCE_M = 1.0  # camera-centre distance to the best positive >= => real:distance_change
PARTIAL_DEPTH = 0.5  # best depth overlap < => real:partial_view (7-/12-Scenes)
PARTIAL_MAPFREE = 0.4  # best Map-free overlap <
PARTIAL_CLOC = 0.5  # best positive's query coverage <
EXPOSURE_DELTA = 30.0  # |mean luma(query) - mean luma(best positive)| >= => exposure change
LOW_LIGHT_LUMA = 50.0  # mean luma below => real:low_light

# ----------------------------------------------------------------------- 7-Scenes design
SEVEN_REFS = {"chess": [1], "fire": [1], "heads": [2], "stairs": [2, 3], "redkitchen": [1]}
SEVEN_REFS["pumpkin"] = [2]
SEVEN_REF_STRIDE = 25
SEVEN_HELD_OUT = ("office",)
SEVEN_QUERIES = {  # (scene, seq) -> split; recordings never used as bench-v1 queries
    ("chess", 2): "validation",
    ("stairs", 5): "validation",
    ("redkitchen", 3): "validation",
    ("pumpkin", 1): "validation",
    ("office", 7): "validation",
    ("chess", 4): "test",
    ("fire", 2): "test",
    ("stairs", 6): "test",
    ("redkitchen", 4): "test",
    ("pumpkin", 7): "test",
    ("office", 9): "test",
}
SEVEN_DEV = {  # bench-v1 query recordings, same frames as bench-v1
    ("chess", 3),
    ("chess", 5),
    ("fire", 3),
    ("fire", 4),
    ("heads", 1),
    ("stairs", 1),
    ("stairs", 4),
    ("office", 2),
    ("office", 6),
}
SEVEN_QUERY_FRAMES_PER = 25  # one query per 25 frames of the recording at most
SEVEN_QUERY_SPACING = (0.15, 10.0)  # metres / degrees from every query already chosen
SEVEN_K = PinholeK(585.0, 585.0, 320.0, 240.0, 640, 480)

# ----------------------------------------------------------------------- 12-Scenes design
TWELVE_SPLITS = {
    "apt2-bed": "validation",
    "apt2-kitchen": "validation",
    "apt2-living": "validation",
    "apt2-luke": "validation",
    "apt1-kitchen": "test",
    "apt1-living": "test",
    "office1-gates362": "test",
    "office1-gates381": "test",
    "office1-lounge": "test",
    "office1-manolis": "test",
    "office2-5a": "test",
    "office2-5b": "test",
}
TWELVE_HELD_OUT = {"apt2-luke", "office1-manolis", "office2-5a", "office2-5b"}
#: Scans excluded as query recordings because they duplicate another scan (found by the
#: leakage check; see DATASETS.md): not independent recordings.
TWELVE_EXCLUDED_SCANS = {
    "office1-gates381": {
        3: (
            "near-duplicate of scan 2: 36 of 40 selected scan-2 frames lie within 3 cm of a "
            "scan-3 pose on the same trajectory; 32 pHash pairs <= 6 bits"
        )
    }
}
TWELVE_K = PinholeK(572.0, 572.0, 320.0, 240.0, 640, 480)
#: Rooms of one site are separate reconstructions; their co-visibility cannot be computed,
#: so references of *other rooms of the same site* are ambiguous (never right or wrong).
TWELVE_CROSS_ROOM = "ambiguous"

# ----------------------------------------------------------------------- Map-free design
MAPFREE_N_VALIDATION = 50  # first scenes of the seeded order; the rest are test
MAPFREE_HELD_OUT_FRACTION = 0.2  # last 20% of each split's scenes contribute no refs

# ----------------------------------------------------------------------- robustness
ROBUST_EDITS = ("dark", "bright", "gaussian_blur", "jpeg_q15", "rotate90", "crop")
ROBUST_PER_GROUP = 5  # with valid reference, per (dataset, split)
ROBUST_ABSENT_PER_GROUP = 1
ROBUST_CROP = 0.7

DEFINITION = (
    "A reference is a correct match for a query when both images show a substantial common "
    "part of the same physical place, decided from ground-truth poses plus 3D structure "
    "(never camera position, room or building alone). 7-Scenes and 12-Scenes: depth "
    "re-projection overlap (fraction of valid query depth pixels that land inside the "
    "reference image on a consistent reference depth, max(5 cm, 5%)); positive >= 0.30, "
    "ambiguous [0.10, 0.30). CLoc: SfM co-visibility from the ground-truth query pose "
    "(shared observed points, grid coverage); positive shared >= 50 & covq >= 0.30 & covr >= "
    "0.20, ambiguous shared >= 15 & max cov >= 0.10. Map-free: the dataset's own "
    "overlaps.npz score between the two scans' frames (SfM co-visibility); positive >= 0.20 "
    "(the dataset's training minimum), ambiguous [0.05, 0.20). Different scenes, rooms "
    "(7-Scenes, Map-free) or buildings are different places; other rooms of the same "
    "12-Scenes site are ambiguous because their co-visibility cannot be computed. Ambiguous "
    "references count as neither right nor wrong; an accepted ambiguous reference is never "
    "a correct rejection. Queries without any positive have has_valid_reference=False "
    "(either the place is held out of the reference pool, or no reference sees the view)."
)


# ======================================================================= builder state


@dataclass
class Ref:
    entry: ManifestEntry
    depth: np.ndarray | None = None
    pose: np.ndarray | None = None


@dataclass
class Builder:
    out_dir: Path
    stats: StatsCache
    entries: list[ManifestEntry] = field(default_factory=list)
    labels: dict[str, QueryLabel] = field(default_factory=dict)
    raw: dict[str, dict] = field(default_factory=dict)  # query -> ref -> raw score(s)
    diag: dict[str, dict] = field(default_factory=dict)  # query -> best-positive geometry
    changelog: list[dict] = field(default_factory=list)

    def rel(self, p: Path) -> str:
        return os.path.relpath(Path(p).resolve(), self.out_dir.resolve())

    def add(self, e: ManifestEntry, path: Path) -> ManifestEntry:
        st = self.stats.get(path)
        e.content_sha256 = st["sha256"]
        e.extra.setdefault("image_stats", {k: st[k] for k in ("lapvar", "mean_luma", "phash")})
        self.entries.append(e)
        return e


def _sha_order(items: list[str], salt: str) -> list[str]:
    return sorted(items, key=lambda s: hashlib.sha256(f"{SEED}:{salt}:{s}".encode()).hexdigest())


def _rot_deg(r1: np.ndarray, r2: np.ndarray) -> float:
    r = r1 @ r2.T
    return float(np.degrees(np.arccos(np.clip((np.trace(r) - 1) / 2, -1.0, 1.0))))


def _c2w(e: ManifestEntry) -> np.ndarray:
    m = np.array(e.pose.matrix)
    return m if e.pose.convention == "camera_to_world" else np.linalg.inv(m)


def _source(url, lic, cit) -> SourceInfo:
    return SourceInfo(url=url, license=lic, citation=cit)


def _depth_label(
    b: Builder,
    qe: ManifestEntry,
    q_depth: np.ndarray,
    refs: list[Ref],
    K: PinholeK,
    *,
    method: str,
    mask: np.ndarray | None = None,
    extra_amb: list[str] | None = None,
) -> QueryLabel:
    Tq = _c2w(qe)
    scores = {}
    for r in refs:
        scores[r.entry.image_id] = depth_overlap(q_depth, Tq, r.depth, r.pose, K, query_mask=mask)[
            0
        ]
    pos = sorted([r for r, v in scores.items() if v >= DEPTH_POS], key=lambda r: -scores[r])
    amb = sorted(
        [r for r, v in scores.items() if DEPTH_AMB <= v < DEPTH_POS], key=lambda r: -scores[r]
    )
    amb += sorted(extra_amb or [])
    best = max(scores.values()) if scores else 0.0
    b.raw[qe.image_id] = {
        r: {"overlap": round(v, 4)}
        for r, v in sorted(scores.items(), key=lambda kv: -kv[1])
        if v > 0
    }
    return QueryLabel(
        query_id=qe.image_id,
        has_valid_reference=bool(pos),
        positives=pos,
        ambiguous=amb,
        method=method,
        split=qe.split,
        notes=f"best overlap {best:.3f} over {len(scores)} same-frame refs",
        label_version=LABEL_VERSION,
        group_id=qe.group_id,
        scores={r: round(v, 4) for r, v in scores.items() if v >= 0.01},
    )


# ======================================================================= 7-Scenes


def _seven_entry(b: Builder, f: sevenscenes.Frame, role: str, split: str | None) -> ManifestEntry:
    seq_id = f"7scenes:{f.scene}:seq-{f.seq:02d}"
    orig = "train" if f.seq in sevenscenes.read_splits(f.scene)["train"] else "test"
    e = ManifestEntry(
        image_id=f"7scenes:{f.scene}:{f.frame_id}",
        path=b.rel(f.color),
        role=role,  # type: ignore[arg-type]
        dataset="7scenes",
        scene_id=f.scene,
        location_id=f"7scenes:{f.scene}",
        sequence_id=seq_id,
        group_id=seq_id if role == "query" else None,
        frame_id=f.frame_id,
        orientation=1,
        pose=Pose(
            matrix=f.pose().tolist(), convention="camera_to_world", frame=f"7scenes:{f.scene}:world"
        ),
        depth_path=b.rel(f.depth),
        split=split,  # type: ignore[arg-type]
        source=_source(sevenscenes.PROJECT_URL, sevenscenes.LICENSE, sevenscenes.CITATION),
        extra={
            "depth_intrinsics": {"fx": 585.0, "fy": 585.0, "cx": 320.0, "cy": 240.0},
            "depth_units": "mm (uint16), 0 and 65535 invalid",
            "original_split": orig,
            "site": "7scenes",
        },
    )
    return b.add(e, f.color)


def _seq_len(scene: str, seq: int) -> int:
    marker = sevenscenes.RAW_DIR / scene / f"seq-{seq:02d}" / ".complete.json"
    return int(json.loads(marker.read_text())["frames_in_sequence"])


def _v1_dev_frames(scene: str, seq: int) -> list[sevenscenes.Frame]:
    stride = _seq_len(scene, seq) // 20  # bench-v1 rule (SEVEN_QUERIES_PER_SEQ=20, offset 10)
    return [f for f in sevenscenes.list_frames(scene, seq) if f.index % stride == 10]


def _spaced_frames(frames: list[sevenscenes.Frame], k: int) -> list[sevenscenes.Frame]:
    poses = {f.index: f.pose() for f in frames}
    keep = set(twelvescenes.spaced(poses, k, SEVEN_QUERY_SPACING))
    return [f for f in frames if f.index in keep]


def build_7scenes(b: Builder) -> None:
    refs: dict[str, list[Ref]] = defaultdict(list)
    for scene, seqs in SEVEN_REFS.items():
        for seq in seqs:
            for f in sevenscenes.list_frames(scene, seq):
                if f.index % SEVEN_REF_STRIDE == 0:
                    e = _seven_entry(b, f, "reference", None)
                    refs[scene].append(Ref(e, sevenscenes.load_depth_m(f.depth), f.pose()))
    plan = [(s, q, "development") for s, q in sorted(SEVEN_DEV)]
    plan += [(s, q, sp) for (s, q), sp in sorted(SEVEN_QUERIES.items())]
    for scene, seq, split in plan:
        frames = sevenscenes.list_frames(scene, seq)
        if split == "development":
            chosen = _v1_dev_frames(scene, seq)
        else:
            chosen = _spaced_frames(frames, _seq_len(scene, seq) // SEVEN_QUERY_FRAMES_PER)
        for f in chosen:
            e = _seven_entry(b, f, "query", split)
            if scene in SEVEN_HELD_OUT:
                b.labels[e.image_id] = _held_out_label(e, "7scenes", f"scene '{scene}'")
                continue
            method = f"depth_reprojection_overlap>={DEPTH_POS}(amb>={DEPTH_AMB})"
            b.labels[e.image_id] = _depth_label(
                b, e, sevenscenes.load_depth_m(f.depth), refs[scene], SEVEN_K, method=method
            )


def _held_out_label(e: ManifestEntry, dataset: str, what: str, amb=None) -> QueryLabel:
    return QueryLabel(
        query_id=e.image_id,
        has_valid_reference=False,
        ambiguous=sorted(amb or []),
        method=f"held_out_scene({dataset})",
        split=e.split,  # type: ignore[arg-type]
        notes=f"{what} has no references in the pool",
        label_version=LABEL_VERSION,
        group_id=e.group_id,
    )


# ======================================================================= 12-Scenes


def build_12scenes(b: Builder) -> None:
    frames = twelvescenes.load_frames()
    refs: dict[str, list[Ref]] = defaultdict(list)
    src = _source(twelvescenes.PROJECT_URL, twelvescenes.LICENSE, twelvescenes.CITATION)

    def entry(f: twelvescenes.Frame, role: str, split: str | None) -> ManifestEntry:
        scene = f"{f.site}-{f.room}"
        seq_id = f"12scenes:{scene}:scan-{f.scan}"
        info = twelvescenes.parse_info(
            (twelvescenes.RAW_DIR / f.site / f.room / "info.txt").read_text()
        )
        ci = [float(x) for x in info["m_calibrationColorIntrinsic"].split()]
        e = ManifestEntry(
            image_id=f"12scenes:{scene}:{f.frame_id}",
            path=b.rel(f.path("color.jpg")),
            role=role,  # type: ignore[arg-type]
            dataset="12scenes",
            scene_id=scene,
            location_id=f"12scenes:{scene}",
            sequence_id=seq_id,
            group_id=seq_id if role == "query" else None,
            frame_id=f.frame_id,
            orientation=1,
            pose=Pose(
                matrix=f.pose().tolist(),
                convention="camera_to_world",
                frame=f"12scenes:{scene}:world",
            ),
            intrinsics=Intrinsics(
                fx=ci[0],
                fy=ci[5],
                cx=ci[2],
                cy=ci[6],
                width=int(info["m_colorWidth"]),
                height=int(info["m_colorHeight"]),
            ),  # fmt: skip
            depth_path=b.rel(f.path("depth.png")),
            split=split,  # type: ignore[arg-type]
            source=src,
            extra={
                "depth_intrinsics": {"fx": 572.0, "fy": 572.0, "cx": 320.0, "cy": 240.0},
                "depth_units": "mm (uint16), 0 invalid; aligned to the colour image",
                "intrinsics_note": "default intrinsics from info.txt (no calibration)",
                "original_split": f.original_split,
                "scan": f.scan,
                "site": f"12scenes:{f.site}",
            },
        )
        return b.add(e, f.path("color.jpg"))

    for f in frames:
        scene = f"{f.site}-{f.room}"
        if f.role == "reference" and scene not in TWELVE_HELD_OUT:
            e = entry(f, "reference", None)
            refs[scene].append(Ref(e, twelvescenes.load_depth_m(f.path("depth.png")), f.pose()))
    for f in frames:
        scene = f"{f.site}-{f.room}"
        if f.role != "query" or f.scan in TWELVE_EXCLUDED_SCANS.get(scene, {}):
            continue
        split = TWELVE_SPLITS[scene]
        e = entry(f, "query", split)
        same_site = [
            r.entry.image_id
            for s, rs in refs.items()
            if s != scene and s.split("-")[0] == f.site
            for r in rs
        ]
        amb = same_site if TWELVE_CROSS_ROOM == "ambiguous" else []
        if scene in TWELVE_HELD_OUT:
            lab = _held_out_label(e, "12scenes", f"room '{scene}'", amb)
            if amb:
                lab.notes += f"; {len(amb)} refs of other rooms of site {f.site} are ambiguous"
            b.labels[e.image_id] = lab
            continue
        method = f"depth_reprojection_overlap>={DEPTH_POS}(amb>={DEPTH_AMB})+same_site_rooms_amb"
        lab = _depth_label(
            b, e, twelvescenes.load_depth_m(f.path("depth.png")), refs[scene], TWELVE_K,
            method=method, extra_amb=amb,
        )  # fmt: skip
        if amb:
            lab.notes += f"; {len(amb)} refs of other rooms of site {f.site} are ambiguous"
        b.labels[e.image_id] = lab


# ======================================================================= CLoc


def build_cloc(b: Builder) -> None:
    from placematch.datasets import colmap_io

    sel = json.loads((cloc.RAW_DIR / "selection_v2.json").read_text())
    src = _source(cloc.REPO_URL, cloc.LICENSE, cloc.CITATION)
    floors = {"NEB1": "NEB:f1", "NEB2": "NEB:b1", "SFB": None}
    sites = {"NEB1": "cloc:NEB", "NEB2": "cloc:NEB", "SFB": "cloc:SFB"}
    v1_split = {}
    for _bld, e1 in json.loads((cloc.RAW_DIR / "selection.json").read_text())["buildings"].items():
        for sp, members in e1["queries"].items():
            for m in members:
                v1_split[m] = sp
    for building, e in sel["buildings"].items():
        K, dist = cloc.load_intrinsics(building)
        gt = cloc.load_gt(building)
        d = cloc.RAW_DIR / building / "Database" / "sfm_model"
        images = colmap_io.read_images(d / "images.bin")
        cams = colmap_io.read_cameras(d / "cameras.bin")
        vis_model = SfmVisibility(colmap_io.read_points3D(d / "points3D.bin"), images)
        by_name = {im.name: im for im in images.values()}
        ref_imgs = {}
        for member in e["references"]:
            name = member.split("/Database/images/")[1]
            im, cam = by_name[name], cams[by_name[name].camera_id]
            rid = f"cloc:{building}:db/{name}"
            ref_imgs[rid] = (im, cam)
            Kr = cam.K()
            path = cloc.RAW_DIR / building / member.split("/", 1)[1]
            ent = ManifestEntry(
                image_id=rid,
                path=b.rel(path),
                role="reference",
                dataset="cloc",
                scene_id=building,
                location_id=f"cloc:{building}",
                sequence_id=f"cloc:{building}:database",
                frame_id=name,
                orientation=1,
                pose=Pose(
                    matrix=im.world_to_camera().tolist(),
                    convention="world_to_camera",
                    frame=f"cloc:{building}:sfm",
                ),
                intrinsics=Intrinsics(
                    fx=Kr[0, 0],
                    fy=Kr[1, 1],
                    cx=Kr[0, 2],
                    cy=Kr[1, 2],
                    width=cam.width,
                    height=cam.height,
                ),  # fmt: skip
                floor_id=floors[building],
                source=src,
                extra={
                    "camera_model": cam.model,
                    "camera_params": cam.params.tolist(),
                    **_cloc_db_name_fields(name),
                    "sfm_observed_points": int((im.point3D_ids >= 0).sum()),
                    "site": sites[building],
                },
            )
            b.add(ent, path)
        plan = [(m, "development") for m in e["dev_queries"]]
        plan += [(m, "test") for m in e["test_queries"]]
        for member, split in plan:
            rel = member.split("/query_sequences/")[1]
            session, chunk, fname = rel.split("/")
            t, q = gt[rel]
            w2c = np.eye(4)
            w2c[:3, :3] = colmap_io.qvec_to_rotmat(q)
            w2c[:3, 3] = t
            path = cloc.RAW_DIR / building / member.split("/", 1)[1]
            conds = ["real:different_camera"]
            if building in ("NEB1", "NEB2"):
                conds.append("real:long_term")
            ent = ManifestEntry(
                image_id=f"cloc:{building}:{rel}",
                path=b.rel(path),
                role="query",
                dataset="cloc",
                scene_id=building,
                location_id=f"cloc:{building}",
                sequence_id=f"cloc:{building}:{session}/{chunk}",
                group_id=f"cloc:{building}:{session}",
                frame_id=rel,
                orientation=1,
                pose=Pose(
                    matrix=w2c.tolist(), convention="world_to_camera", frame=f"cloc:{building}:sfm"
                ),
                intrinsics=Intrinsics(
                    fx=K[0, 0], fy=K[1, 1], cx=K[0, 2], cy=K[1, 2], width=1024, height=576
                ),
                conditions=conds,
                split=split,  # type: ignore[arg-type]
                floor_id=floors[building],
                source=src,
                extra={
                    "distortion_opencv_k1k2p1p2k3": dist.tolist(),
                    "session": session,
                    "chunk": chunk,
                    "capture_date_from_session": session.split("-")[1],
                    "site": sites[building],
                    "bench_v1_split": v1_split.get(member),
                },
            )
            b.add(ent, path)
            vis, uv = vis_model.visible(w2c, K, dist, 1024, 576)
            stats = {
                rid: vis_model.pair_stats(vis, uv, (1024, 576), im, (cam.width, cam.height))
                for rid, (im, cam) in ref_imgs.items()
            }
            pos, amb = [], []
            for rid, s in stats.items():
                if (
                    s.shared >= CLOC_POS["shared"]
                    and s.coverage_query >= CLOC_POS["coverage_query"]
                    and s.coverage_reference >= CLOC_POS["coverage_reference"]
                ):
                    pos.append(rid)
                elif (
                    s.shared >= CLOC_AMB["shared"]
                    and max(s.coverage_query, s.coverage_reference) >= CLOC_AMB["coverage_any"]
                ):
                    amb.append(rid)

            def key(r, stats=stats):
                return -stats[r].shared

            b.raw[ent.image_id] = {
                rid: {
                    "shared": s.shared,
                    "covq": round(s.coverage_query, 3),
                    "covr": round(s.coverage_reference, 3),
                }
                for rid, s in sorted(stats.items(), key=lambda kv: -kv[1].shared)
                if s.shared > 0
            }  # fmt: skip
            b.labels[ent.image_id] = QueryLabel(
                query_id=ent.image_id,
                has_valid_reference=bool(pos),
                positives=sorted(pos, key=key),
                ambiguous=sorted(amb, key=key),
                method=bench_cloc_method(),
                split=split,  # type: ignore[arg-type]
                notes=f"{int(vis.sum())} model points predicted visible in the query",
                label_version=LABEL_VERSION,
                group_id=ent.group_id,
                scores={rid: float(s.shared) for rid, s in stats.items() if s.shared > 0},
            )


def _cloc_db_name_fields(name: str) -> dict:
    """NEB: ``<unix time>_<rig camera>.png``; SFB: cubemap faces of panoramas
    ``cubemap_<id>_rdy(..)_rdz(..)_surface<k>.png``."""
    stem = name.split("/")[-1].rsplit(".", 1)[0]
    if stem.startswith("cubemap_"):
        return {
            "panorama": stem.rsplit("_surface", 1)[0],
            "cubemap_face": int(stem.rsplit("_surface", 1)[1]),
        }
    t, cam = stem.rsplit("_", 1)
    return {"capture_unix_time_from_name": float(t), "rig_camera": int(cam)}


def bench_cloc_method() -> str:
    return "sfm_covisibility(shared>=50,covq>=0.3,covr>=0.2;amb:shared>=15,cov>=0.1)"


# ======================================================================= Map-free


def mapfree_plan() -> dict[str, dict]:
    """scene -> {"split", "held_out"} from the seeded scene order of the fetch."""
    scenes = mapfree.chosen_scenes()
    plan = {}
    for split, group in (
        ("validation", scenes[:MAPFREE_N_VALIDATION]),
        ("test", scenes[MAPFREE_N_VALIDATION:]),
    ):
        n_hold = int(round(len(group) * MAPFREE_HELD_OUT_FRACTION))
        for i, sc in enumerate(group):
            plan[sc] = {"split": split, "held_out": i >= len(group) - n_hold}
    return plan


def build_mapfree(b: Builder) -> None:
    src = _source(mapfree.PROJECT_URL, mapfree.LICENSE, mapfree.CITATION)
    plan = mapfree_plan()
    root = mapfree.RAW_DIR / "train"
    for sc, p in plan.items():
        meta = mapfree.load_scene(sc)

        def entry(f: str, role: str, split, meta=meta, sc=sc) -> ManifestEntry:
            seq = f.split("/")[0]
            fx, fy, cx, cy, w, h = meta["intrinsics_fx_fy_cx_cy_w_h"][f]
            path = root / sc / f
            e = ManifestEntry(
                image_id=f"mapfree:{sc}:{f}",
                path=b.rel(path),
                role=role,  # type: ignore[arg-type]
                dataset="mapfree",
                scene_id=sc,
                location_id=f"mapfree:{sc}",
                sequence_id=f"mapfree:{sc}:{seq}",
                group_id=f"mapfree:{sc}:{seq}" if role == "query" else None,
                frame_id=f,
                orientation=1,
                pose=Pose(
                    matrix=meta["poses_w2c"][f],
                    convention="world_to_camera",
                    frame=f"mapfree:{sc}:world",
                ),
                intrinsics=Intrinsics(fx=fx, fy=fy, cx=cx, cy=cy, width=int(w), height=int(h)),
                split=split,
                source=src,
                extra={"original_split": "train", "scan": seq, "site": f"mapfree:{sc}"},
            )
            return b.add(e, path)

        ref_ids = []
        if not p["held_out"]:
            for f in meta["references"]:
                ref_ids.append(entry(f, "reference", None).image_id)
        for f in meta["queries"]:
            e = entry(f, "query", p["split"])
            if p["held_out"]:
                b.labels[e.image_id] = _held_out_label(e, "mapfree", f"scene '{sc}'")
                continue
            ov = meta["query_overlaps_vs_seq0"][f]
            scores = {f"mapfree:{sc}:{r}": float(ov.get(r, 0.0)) for r in meta["references"]}
            pos = sorted(
                [r for r, v in scores.items() if v >= MAPFREE_POS], key=lambda r: -scores[r]
            )
            amb = sorted(
                [r for r, v in scores.items() if MAPFREE_AMB <= v < MAPFREE_POS],
                key=lambda r: -scores[r],
            )  # fmt: skip
            any_seq0 = max(ov.values()) if ov else 0.0
            b.raw[e.image_id] = {r: {"overlap": round(v, 4)} for r, v in scores.items() if v > 0}
            b.labels[e.image_id] = QueryLabel(
                query_id=e.image_id,
                has_valid_reference=bool(pos),
                positives=pos,
                ambiguous=amb,
                method=f"mapfree_overlap>={MAPFREE_POS}(amb>={MAPFREE_AMB})",
                split=p["split"],
                notes=(
                    f"best overlap to a selected ref {max(scores.values()):.3f}; best to any "
                    f"seq0 frame {any_seq0:.3f} ({len(ov)} seq0 frames with non-zero overlap)"
                ),
                label_version=LABEL_VERSION,
                group_id=e.group_id,
                scores={r: round(v, 4) for r, v in scores.items() if v > 0},
            )


# ======================================================================= inspection


def apply_v1_inspection(b: Builder) -> list[dict]:
    """Re-apply the bench-v1 agent decisions to the same pairs (development queries) and
    record each change in the change log. Agent inspection, never human review."""
    if not INSPECTION_FILE.is_file():
        return []
    applied = []
    for r in json.loads(INSPECTION_FILE.read_text()):
        lab = b.labels.get(r["query_id"])
        ref = r["reference_id"]
        if lab is None or ref not in {e.image_id for e in b.entries if e.role == "reference"}:
            applied.append({**r, "status": "not_applicable_in_v2"})
            continue
        auto = (
            "positive"
            if ref in lab.positives
            else "ambiguous"
            if ref in lab.ambiguous
            else "negative"
        )
        lab.agent_inspected = True
        lab.reviewed = False
        if r["decision"] != auto:
            lab.positives = [x for x in lab.positives if x != ref]
            lab.ambiguous = [x for x in lab.ambiguous if x != ref]
            if r["decision"] == "positive":
                lab.positives.append(ref)
            elif r["decision"] == "ambiguous":
                lab.ambiguous.append(ref)
            lab.has_valid_reference = bool(lab.positives)
            lab.method += "+agent_override"
            b.changelog.append(
                {
                    "label_version": LABEL_VERSION,
                    "query_id": lab.query_id,
                    "reference_id": ref,
                    "old": auto,
                    "new": r["decision"],
                    "evidence": r["note"],
                    "inspected_by": AGENT_INSPECTOR,
                    "introduced_in": "bench-v1 (placematch/datasets/agent_inspection_v1.json)",
                    "split": lab.split,
                    "reason": "visual inspection of the image pair; no model output was used",
                }
            )
        lab.notes += f"; agent-inspected {ref}: auto={auto}, agent={r['decision']} ({r['note']})"
        applied.append({**r, "auto_label_v2": auto, "status": "applied"})
    return applied


# ======================================================================= conditions


def assign_conditions(b: Builder) -> None:
    by = {e.image_id: e for e in b.entries}
    site_locations: dict[str, set] = defaultdict(set)
    for r in b.entries:
        if r.role == "reference":
            site_locations[r.extra.get("site")].add(r.location_id)
    for e in b.entries:
        if e.role != "query":
            continue
        lab = b.labels[e.image_id]
        st = e.extra["image_stats"]
        conds = [c for c in e.conditions if c.startswith("real:")]
        if st["lapvar"] < BLUR_LAPVAR:
            conds.append("real:motion_blur")
        if st["mean_luma"] < LOW_LIGHT_LUMA:
            conds.append("real:low_light")
        if e.dataset == "7scenes" and e.scene_id == "stairs":
            conds.append("real:repetitive_structure")
        site = e.extra.get("site")
        others_same_site = e.dataset in ("cloc", "12scenes") and bool(
            site_locations.get(site, set()) - {e.location_id}
        )
        if others_same_site:
            conds.append("real:same_site_distractors")
        if not lab.has_valid_reference:
            held = lab.method.startswith("held_out")
            conds.append("real:absent_location" if held else "real:absent_view")
        else:
            best = lab.positives[0]
            r = by[best]
            Tq, Tr = _c2w(e), _c2w(r)
            ang = _rot_deg(Tq[:3, :3], Tr[:3, :3])
            dist = float(np.linalg.norm(Tq[:3, 3] - Tr[:3, 3]))
            min_ang = min(_rot_deg(Tq[:3, :3], _c2w(by[p])[:3, :3]) for p in lab.positives)
            raw = b.raw.get(e.image_id, {}).get(best, {})
            if e.dataset == "cloc":
                partial = raw.get("covq", 1.0) < PARTIAL_CLOC
                score = raw.get("covq")
            elif e.dataset == "mapfree":
                score = raw.get("overlap")
                partial = (score or 1.0) < PARTIAL_MAPFREE
            else:
                score = raw.get("overlap")
                partial = (score or 1.0) < PARTIAL_DEPTH
            dl = abs(st["mean_luma"] - r.extra["image_stats"]["mean_luma"])
            if min_ang >= VIEWPOINT_DEG:
                conds.append("real:viewpoint_change")
            if dist >= DISTANCE_M:
                conds.append("real:distance_change")
            if partial:
                conds.append("real:partial_view")
            if dl >= EXPOSURE_DELTA:
                conds.append("real:exposure_change")
            b.diag[e.image_id] = {
                "best_positive": best,
                "rel_rotation_deg": round(ang, 2),
                "min_rotation_to_any_positive_deg": round(min_ang, 2),
                "rel_translation_m": round(dist, 3),
                "best_score": score,
                "luma_delta_to_best_positive": round(dl, 2),
                "n_positives": len(lab.positives),
            }
            e.extra["relative_to_best_positive"] = b.diag[e.image_id]
        e.conditions = sorted(set(conds))
        lab.conditions = e.conditions


# ======================================================================= eval sets


def assign_eval_sets(b: Builder) -> dict:
    val_locations = {
        e.location_id for e in b.entries if e.role == "query" and e.split == "validation"
    }
    disjoint = set()
    for e in b.entries:
        if e.role == "query" and e.split == "test" and e.location_id not in val_locations:
            b.labels[e.image_id].eval_sets = ["location_disjoint"]
            disjoint.add(e.location_id)
    return {
        "validation_locations": sorted(val_locations),
        "location_disjoint_test": sorted(disjoint),
    }


# ======================================================================= robustness


def _edit(img: np.ndarray, edit: str) -> tuple[np.ndarray, np.ndarray | None, str]:
    """Return (edited image, crop mask in source pixels or None, parameters)."""
    if edit == "dark":
        return np.clip(img.astype(np.float32) * 0.35, 0, 255).astype(np.uint8), None, "x0.35"
    if edit == "bright":
        out = np.clip(img.astype(np.float32) * 1.8 + 20, 0, 255).astype(np.uint8)
        return out, None, "x1.8 + 20, clipped"
    if edit == "gaussian_blur":
        s = max(img.shape[:2]) / 640 * 3.0
        return cv2.GaussianBlur(img, (0, 0), s), None, f"sigma {s:.2f} px (3 px at 640)"
    if edit == "jpeg_q15":
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 15])
        return cv2.imdecode(buf, cv2.IMREAD_COLOR), None, "JPEG quality 15"
    if edit == "rotate90":
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE), None, "90 deg clockwise, pixels rotated"
    if edit == "crop":
        h, w = img.shape[:2]
        ch, cw = int(round(h * ROBUST_CROP)), int(round(w * ROBUST_CROP))
        y0, x0 = (h - ch) // 2, (w - cw) // 2
        mask = np.zeros((h, w), bool)
        mask[y0 : y0 + ch, x0 : x0 + cw] = True
        return img[y0 : y0 + ch, x0 : x0 + cw].copy(), mask, "central 70% x 70%, not resized"
    raise ValueError(edit)


def build_robustness(b: Builder, manifest_dir: Path) -> list[str]:
    by = {e.image_id: e for e in b.entries}
    groups: dict[tuple, list[ManifestEntry]] = defaultdict(list)
    for e in b.entries:
        if e.role == "query" and e.split in ("validation", "test"):
            groups[(e.dataset, e.split)].append(e)
    sources: list[ManifestEntry] = []
    for key in sorted(groups):
        es = _sha_order([e.image_id for e in groups[key]], "robustness")
        valid = [i for i in es if b.labels[i].has_valid_reference][:ROBUST_PER_GROUP]
        absent = [i for i in es if not b.labels[i].has_valid_reference][:ROBUST_ABSENT_PER_GROUP]
        sources += [by[i] for i in sorted(valid + absent)]
    out_ids = []
    for src in sources:
        img = cv2.imread(str(manifest_dir / src.path), cv2.IMREAD_COLOR)
        for edit in ROBUST_EDITS:
            depth_ok = src.dataset in ("7scenes", "12scenes")
            if edit == "crop" and not depth_ok:
                continue  # crop labels can only be recomputed where depth exists
            out_img, mask, params = _edit(img, edit)
            ext = ".jpg" if edit == "jpeg_q15" else ".png"
            safe = src.image_id.replace(":", "_").replace("/", "_")
            path = b.out_dir / "robustness" / edit / f"{safe}{ext}"
            path.parent.mkdir(parents=True, exist_ok=True)
            if edit == "jpeg_q15":
                cv2.imwrite(str(path), img, [cv2.IMWRITE_JPEG_QUALITY, 15])
            else:
                cv2.imwrite(str(path), out_img)
            e = src.model_copy(deep=True)
            e.image_id = f"{src.image_id}:synthetic:{edit}"
            e.path = b.rel(path)
            e.conditions = [f"synthetic:{edit}"]
            e.derived_from = src.image_id
            e.depth_path = None if edit in ("crop", "rotate90") else src.depth_path
            e.intrinsics = None if edit in ("crop", "rotate90") else src.intrinsics
            e.extra = {
                "site": src.extra.get("site"),
                "synthetic_edit": edit,
                "edit_params": params,
                "pose_note": "pose refers to the unedited source frame",
            }
            b.add(e, path)
            slab = b.labels[src.image_id]
            if edit == "crop" and not slab.method.startswith("held_out"):
                dataset_refs = [
                    Ref(by[r], _load_depth(by[r], manifest_dir), _c2w(by[r]))
                    for r in _same_frame_refs(b, src)
                ]
                depth = _load_depth(src, manifest_dir)
                K = SEVEN_K if src.dataset == "7scenes" else TWELVE_K
                dmask = cv2.resize(
                    mask.astype(np.uint8), (K.width, K.height), interpolation=cv2.INTER_NEAREST
                ).astype(bool)
                extra_amb = [a for a in slab.ambiguous if by[a].location_id != src.location_id]
                lab = _depth_label(
                    b, e, depth, dataset_refs, K, method=slab.method + "+crop_mask",
                    mask=dmask, extra_amb=extra_amb,
                )  # fmt: skip
            else:
                lab = slab.model_copy(deep=True)
                lab.query_id = e.image_id
                lab.method += "+copied_from_source(same geometry)"
                lab.agent_inspected = False
                lab.notes += f"; synthetic '{edit}' of {src.image_id}"
                if src.image_id in b.raw:
                    b.raw[e.image_id] = b.raw[src.image_id]
            lab.split = src.split  # type: ignore[assignment]
            lab.conditions = e.conditions
            lab.eval_sets = ["robustness"]
            lab.derived_from = src.image_id
            lab.group_id = src.group_id
            b.labels[e.image_id] = lab
            out_ids.append(e.image_id)
    return out_ids


def _same_frame_refs(b: Builder, q: ManifestEntry) -> list[str]:
    return [
        e.image_id
        for e in b.entries
        if e.role == "reference" and e.pose is not None and e.pose.frame == q.pose.frame
    ]


def _load_depth(e: ManifestEntry, manifest_dir: Path) -> np.ndarray:
    p = manifest_dir / e.depth_path
    return (sevenscenes if e.dataset == "7scenes" else twelvescenes).load_depth_m(p)


# ======================================================================= leakage


def duplicates_report(b: Builder) -> dict:
    by = {e.image_id: e for e in b.entries}
    real = [e for e in b.entries if not e.derived_from]
    sha: dict[str, list[str]] = defaultdict(list)
    for e in real:
        sha[e.content_sha256].append(e.image_id)
    exact = [ids for ids in sha.values() if len(ids) > 1]
    hashes = {e.image_id: int(e.extra["image_stats"]["phash"], 16) for e in real}
    pairs = near_duplicate_pairs(hashes)
    kinds: Counter = Counter()
    listed = []
    for a, c, d in pairs:
        ea, ec = by[a], by[c]
        roles = "-".join(sorted([ea.role, ec.role]))
        if ea.role == ec.role == "query":
            rel = "cross_split" if ea.split != ec.split else "same_split"
        else:
            rel = "query_reference" if roles == "query-reference" else "reference_reference"
        same_loc = ea.location_id == ec.location_id
        lab_pair = ""
        if roles == "query-reference":
            q, r = (ea, ec) if ea.role == "query" else (ec, ea)
            lb = b.labels[q.image_id]
            lab_pair = (
                "positive"
                if r.image_id in lb.positives
                else "ambiguous"
                if r.image_id in lb.ambiguous
                else "negative"
            )
        k = f"{rel}:{'same_location' if same_loc else 'different_location'}"
        if lab_pair:
            k += f":{lab_pair}"
        kinds[k] += 1
        listed.append(
            {
                "a": a,
                "b": c,
                "hamming": d,
                "kind": k,
                "same_sequence": ea.sequence_id == ec.sequence_id,
            }
        )
    # cross-split recordings / locations
    rec_split: dict[str, set] = defaultdict(set)
    for e in real:
        if e.role == "query":
            rec_split[e.group_id or e.sequence_id].add(e.split)
    shared_recordings = sorted(k for k, v in rec_split.items() if len(v) > 1)
    ref_seqs = {e.sequence_id for e in real if e.role == "reference"}
    q_in_ref_seq = sorted(
        {e.sequence_id for e in real if e.role == "query" and e.sequence_id in ref_seqs}
    )
    return {
        "method": (
            f"exact: SHA-256 of file bytes; near: 64-bit DCT pHash, Hamming <= {NEAR_DUP_BITS}, "
            "all real images (references and queries of every split); no learned model used"
        ),
        "n_images_checked": len(real),
        "exact_duplicate_groups": exact,
        "near_duplicate_pairs_by_kind": dict(sorted(kinds.items())),
        "near_duplicate_pairs": listed,
        "recordings_in_more_than_one_split": shared_recordings,
        "query_sequences_that_are_also_reference_sequences": q_in_ref_seq,
        "interpretation": (
            "A near-duplicate between a query and its positive reference is an easy case, not "
            "leakage (independent recordings of the same view). Leakage would be an exact "
            "duplicate, a recording in two splits, or a query taken from a reference recording."
        ),
    }


# ======================================================================= subsets


def paired_subset(b: Builder, robustness_ids: list[str]) -> tuple[dict, dict]:
    refs = sorted(e.image_id for e in b.entries if e.role == "reference")
    q_all = [
        e for e in b.entries
        if e.role == "query" and e.split in ("validation", "test") and not e.derived_from
    ]  # fmt: skip
    budget = PAIRED_MAX_IMAGES - len(refs)
    if budget <= 0:
        raise ValueError("references alone exceed the paired-subset image budget")
    strata: dict[tuple, list[str]] = defaultdict(list)
    for e in q_all:
        lab = b.labels[e.image_id]
        status = "with_ref" if lab.has_valid_reference else "no_ref"
        strata[(e.dataset, e.scene_id, e.split, status)].append(e.image_id)
    chosen: list[str] = []
    if len(q_all) <= budget:
        chosen = sorted(e.image_id for e in q_all)
        rule = "all validation + test real queries fit the budget; nothing sampled"
    else:  # proportional allocation per stratum, seeded order inside each stratum
        total = len(q_all)
        for key in sorted(strata):
            ids = _sha_order(strata[key], "paired:" + "|".join(key))
            n = max(1, int(len(ids) * budget / total))
            chosen += ids[:n]
        chosen = sorted(chosen)[:budget]
        rule = "proportional per (dataset, scene, split, reference status), seeded order"
    by = {e.image_id: e for e in b.entries}
    counts: Counter = Counter()
    for q in chosen:
        e = by[q]
        counts[f"{e.split}:{e.dataset}"] += 1
    paired = {
        "description": "Paired Vertex / MegaLoc comparison: queries and the full reference pool",
        "rule": rule,
        "reference_ids": refs,
        "query_ids": chosen,
        "n_references": len(refs),
        "n_queries": len(chosen),
        "unique_images": len(set(refs) | set(chosen)),
        "expected_vertex_requests_uncached": len(set(refs) | set(chosen)),
        "request_note": "one embedding request per image (Vertex multimodal embeddings); "
        "vectors are cached, so a re-run costs 0 requests",
        "queries_by_split_dataset": dict(sorted(counts.items())),
        "max_images": PAIRED_MAX_IMAGES,
    }
    src = sorted({by[i].derived_from for i in robustness_ids})
    new_imgs = sorted(set(robustness_ids) | (set(src) - set(chosen)))
    ec = Counter(i.rsplit(":synthetic:", 1)[1] for i in robustness_ids)
    robust = {
        "description": (
            "Robustness study: synthetic variants of a fixed set of real validation/test "
            "queries. Retrieval uses the paired subset's reference pool (already embedded)."
        ),
        "variant_ids": sorted(robustness_ids),
        "source_query_ids": src,
        "reference_ids_from": "paired_subset.json",
        "n_variants": len(robustness_ids),
        "n_sources": len(src),
        "variants_by_edit": dict(sorted(ec.items())),
        "unique_images_including_sources": len(set(robustness_ids) | set(src)),
        "expected_vertex_requests_uncached_beyond_paired_subset": len(new_imgs),
        "max_images": ROBUSTNESS_MAX_IMAGES,
    }
    if robust["unique_images_including_sources"] > ROBUSTNESS_MAX_IMAGES:
        raise ValueError("robustness subset exceeds its image budget")
    return paired, robust


# ======================================================================= summary / splits


def summarize(manifest: Manifest, labels: LabelSet) -> dict:
    lab = {lb.query_id: lb for lb in labels.labels}
    refs: Counter = Counter()
    out: dict = {
        "references_by_dataset_scene": {},
        "queries": defaultdict(lambda: defaultdict(Counter)),
        "conditions_by_split": defaultdict(Counter),
        "eval_sets_by_split": defaultdict(Counter),
    }
    for e in manifest.entries:
        key = f"{e.dataset}:{e.scene_id}"
        if e.role == "reference":
            refs[key] += 1
            continue
        lb = lab[e.image_id]
        kind = "robustness" if e.derived_from else "real"
        status = (
            "with_valid_reference"
            if lb.has_valid_reference
            else "absent_location"
            if lb.method.startswith("held_out")
            else "absent_view_ambiguous_only"
            if lb.ambiguous
            else "absent_view"
        )
        out["queries"][f"{e.split}:{kind}"][key][status] += 1
        if kind == "real":
            for c in e.conditions or ["none"]:
                out["conditions_by_split"][e.split][c] += 1
        for s in lb.eval_sets or ["main"]:
            out["eval_sets_by_split"][e.split][s] += 1
    out["references_by_dataset_scene"] = dict(sorted(refs.items()))
    tot: Counter = Counter()
    for split_kind, scenes in out["queries"].items():
        for st in scenes.values():
            for k, v in st.items():
                tot[f"{split_kind}:{k}"] += v
    real = [e for e in manifest.queries() if not e.derived_from]
    out["totals"] = {
        "n_references": sum(refs.values()),
        "n_real_queries": len(real),
        "n_robustness_variants": sum(1 for e in manifest.queries() if e.derived_from),
        "real_queries_by_split": dict(Counter(e.split for e in real)),
        "real_queries_by_dataset": dict(Counter(e.dataset for e in real)),
        "real_queries_by_status": dict(sorted(tot.items())),
        "n_locations": len({e.location_id for e in manifest.entries}),
        "n_locations_with_queries": len({e.location_id for e in real}),
        "n_recordings_with_queries": len({e.group_id for e in real}),
        "n_dataset_families": len({e.dataset for e in manifest.entries}),
        "real_no_valid_reference": sum(1 for e in real if not lab[e.image_id].has_valid_reference),
        "agent_inspected_queries": sum(1 for lb in labels.labels if lb.agent_inspected),
    }
    return json.loads(json.dumps(out))


def splits_report(b: Builder, eval_sets: dict) -> dict:
    out: dict = {"rules": __doc__.split("Split rules (INTERFACES.md, v2 phase):", 1)[1].strip()}
    for split in ("development", "validation", "test"):
        qs = [e for e in b.entries if e.role == "query" and e.split == split and not e.derived_from]
        rec: dict[str, Counter] = defaultdict(Counter)
        for e in qs:
            rec[e.group_id][e.dataset] += 1
        out[split] = {
            "n_queries": len(qs),
            "recordings": {g: sum(c.values()) for g, c in sorted(rec.items())},
            "locations": sorted({e.location_id for e in qs}),
        }
    out["reference_recordings"] = sorted(
        {e.sequence_id for e in b.entries if e.role == "reference"}
    )
    out["eval_sets"] = eval_sets
    sets = {
        k: set(v["recordings"]) for k, v in out.items() if isinstance(v, dict) and "recordings" in v
    }
    out["checks"] = {
        "recordings_shared_between_splits": sorted(
            (sets["validation"] & sets["test"])
            | (sets["development"] & (sets["validation"] | sets["test"]))
        ),
        "query_recordings_used_as_references": sorted(
            set().union(*sets.values()) & set(out["reference_recordings"])
        ),
    }
    return out


# ======================================================================= build


def build(*, out_root: Path = BENCH_DIR, name: str = NAME) -> tuple[Manifest, LabelSet, dict]:
    out_dir = out_root / name
    out_dir.mkdir(parents=True, exist_ok=True)
    b = Builder(out_dir, StatsCache(out_dir / "_cache" / "image_stats.json"))
    build_7scenes(b)
    build_12scenes(b)
    build_cloc(b)
    build_mapfree(b)
    inspected = apply_v1_inspection(b)
    assign_conditions(b)
    eval_sets = assign_eval_sets(b)
    robust_ids = build_robustness(b, out_dir)
    b.stats.save()
    ids = [e.image_id for e in b.entries]
    assert len(ids) == len(set(ids)), "duplicate image ids"
    paired, robust = paired_subset(b, robust_ids)
    manifest = Manifest(
        name=name,
        description=(
            "placematch-v2: 7-Scenes, 12-Scenes, CLoc and Map-free; recording-level "
            "development/validation/test splits, location-disjoint test set, robustness "
            "variants kept separate."
        ),
        entries=b.entries,
        notes={
            "sources": {
                "7scenes": {"url": sevenscenes.PROJECT_URL, "license": sevenscenes.LICENSE},
                "12scenes": {"url": twelvescenes.PROJECT_URL, "license": twelvescenes.LICENSE},
                "cloc": {"url": cloc.REPO_URL, "data": cloc.DRIVE_FOLDER, "license": cloc.LICENSE},
                "mapfree": {"url": mapfree.PROJECT_URL, "license": mapfree.LICENSE},
            },
            "design": {
                "7scenes_references": SEVEN_REFS,
                "7scenes_queries": {f"{s}:seq-{q:02d}": sp for (s, q), sp in SEVEN_QUERIES.items()},
                "7scenes_development": sorted(f"{s}:seq-{q:02d}" for s, q in SEVEN_DEV),
                "7scenes_held_out": list(SEVEN_HELD_OUT),
                "12scenes_splits": TWELVE_SPLITS,
                "12scenes_held_out": sorted(TWELVE_HELD_OUT),
                "12scenes_cross_room": TWELVE_CROSS_ROOM,
                "12scenes_excluded_scans": TWELVE_EXCLUDED_SCANS,
                "cloc_test_sessions": cloc.V2_TEST_SESSIONS,
                "mapfree_plan": mapfree_plan(),
            },
            "boundaries": BOUNDARIES,
            "conditions": CONDITION_DOC,
            "agent_inspection": {"n_pairs": len(inspected), "note": "agent-inspected only"},
        },
    )
    labels = LabelSet(
        manifest="manifest.json",
        definition=DEFINITION,
        labels=[b.labels[e.image_id] for e in b.entries if e.role == "query"],
        version=LABEL_VERSION,
        boundaries=BOUNDARIES,
        changelog="label_changelog.jsonl",
    )
    summary = summarize(manifest, labels)
    dup = duplicates_report(b)
    summary["leakage"] = {
        "exact_duplicate_groups": len(dup["exact_duplicate_groups"]),
        "near_duplicate_pairs_by_kind": dup["near_duplicate_pairs_by_kind"],
        "recordings_in_more_than_one_split": dup["recordings_in_more_than_one_split"],
        "query_sequences_that_are_also_reference_sequences": dup[
            "query_sequences_that_are_also_reference_sequences"
        ],
    }
    summary["paired_subset"] = {k: v for k, v in paired.items() if not k.endswith("_ids")}
    summary["robustness_subset"] = {k: v for k, v in robust.items() if not k.endswith("_ids")}
    files = {
        "manifest.json": manifest.model_dump_json(indent=1),
        "labels.json": labels.model_dump_json(indent=1),
        "raw_scores.json": json.dumps(b.raw, indent=0, sort_keys=True),
        "summary.json": json.dumps(summary, indent=2, sort_keys=True),
        "splits.json": json.dumps(splits_report(b, eval_sets), indent=2),
        "paired_subset.json": json.dumps(paired, indent=1),
        "robustness_vertex_subset.json": json.dumps(robust, indent=1),
        "duplicates.json": json.dumps(dup, indent=1),
        "agent_inspection_applied.json": json.dumps(inspected, indent=1),
        "label_changelog.jsonl": "".join(json.dumps(r, sort_keys=True) + "\n" for r in b.changelog),
    }
    for fn, text in files.items():
        (out_dir / fn).write_text(text)
    return manifest, labels, summary


CONDITION_DOC = {
    "real:motion_blur": (
        f"variance of Laplacian < {BLUR_LAPVAR} (grey, longer side 640 px); measured"
    ),
    "real:low_light": f"mean grey level < {LOW_LIGHT_LUMA} (0..255); measured",
    "real:exposure_change": (
        f"|mean grey(query) - mean grey(best positive)| >= {EXPOSURE_DELTA}; measured"
    ),
    "real:viewpoint_change": (
        f"rotation to every positive >= {VIEWPOINT_DEG} deg (ground-truth poses, same frame)"
    ),
    "real:distance_change": f"camera centre >= {DISTANCE_M} m from the best positive",
    "real:partial_view": (
        f"best positive overlap < {PARTIAL_DEPTH} (depth) / < {PARTIAL_MAPFREE} (Map-free) / "
        f"query coverage < {PARTIAL_CLOC} (CLoc)"
    ),
    "real:repetitive_structure": "7-Scenes stairs (repeated steps; scene-level tag)",
    "real:same_site_distractors": (
        "CLoc / 12-Scenes queries whose building or apartment has references of other "
        "floors or rooms in the pool (scene-level tag)"
    ),
    "real:absent_location": "the query's place has no references (held out)",
    "real:absent_view": "the place has references but none is co-visible with the query",
    "real:long_term": "CLoc NEB queries (2022-08) vs database (2021); dates from file names",
    "real:different_camera": "CLoc smartphone queries vs the 4-camera rig database",
    "synthetic:*": "robustness variants (eval_sets=['robustness']); never in main tables",
}
