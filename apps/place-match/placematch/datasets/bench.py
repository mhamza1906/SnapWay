"""Build the place-matching benchmark (manifest + labels) from the downloaded subsets.

Inputs (see DATASETS.md for how to fetch them):
  data/raw/7scenes/<scene>/seq-XX/frame-XXXXXX.{color.png,depth.png,pose.txt}
  data/raw/cloc/<building>/...  plus data/raw/cloc/selection.json

Outputs in data/bench/<name>/:
  manifest.json   placematch.schemas.Manifest (references + real and synthetic queries)
  labels.json     placematch.schemas.LabelSet (evaluation only)
  overlaps.json   per-query co-visibility scores behind every label (diagnostics)
  summary.json    counts per dataset / scene / split / condition
  synthetic/      derived synthetic query images

CLI::

    uv run python -m placematch.datasets.bench build [--name placematch-v1]
    uv run python -m placematch.datasets.bench inspect-pairs --out <dir>   # composites
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from placematch.datasets import cloc, sevenscenes
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

BENCH_DIR = DATA_DIR / "bench"
DEFAULT_NAME = "placematch-v1"
INSPECTION_FILE = Path(__file__).with_name("agent_inspection_v1.json")

# ----------------------------------------------------------------------------- 7-Scenes
SEVEN_REF_SCENES = ("chess", "fire", "heads", "stairs")
SEVEN_HELDOUT_SCENES = ("office",)
#: Query sequence -> split. Every sequence is from the original TestSplit; the reference
#: sequences (TrainSplit) are listed in sevenscenes.DEFAULT_SUBSET.
SEVEN_QUERY_SPLITS: dict[str, dict[int, str]] = {
    "chess": {3: "validation", 5: "test"},
    "fire": {3: "validation", 4: "test"},
    "heads": {1: "test"},  # heads has a single test sequence
    "stairs": {1: "validation", 4: "test"},
    "office": {2: "validation", 6: "test"},
}
SEVEN_REF_STRIDE = 25  # frames between consecutive references (30 Hz capture)
SEVEN_QUERIES_PER_SEQ = 20
SEVEN_QUERY_OFFSET = 10
SEVEN_POS = 0.30  # co-visible fraction of valid query depth pixels => positive
SEVEN_AMB = 0.10  # [SEVEN_AMB, SEVEN_POS) => ambiguous
SEVEN_K = PinholeK(
    sevenscenes.DEPTH_FX,
    sevenscenes.DEPTH_FY,
    sevenscenes.DEPTH_CX,
    sevenscenes.DEPTH_CY,
    sevenscenes.WIDTH,
    sevenscenes.HEIGHT,
)
BLUR_LAPVAR = 40.0  # variance of Laplacian (grey, full res) below => real:motion_blur

# ----------------------------------------------------------------------------- CLoc
CLOC_POS = {"shared": 50, "coverage_query": 0.30, "coverage_reference": 0.20}
CLOC_AMB = {"shared": 15, "coverage_any": 0.10}
CLOC_QUERY_SIZE = (1024, 576)
CLOC_METHOD = "sfm_covisibility(shared>=50,covq>=0.3,covr>=0.2;amb:shared>=15,cov>=0.1)"

SYNTHETIC_EDITS = ("dark", "motion_blur", "crop")
SYNTH_PER_SCENE = 3
CROP_FRACTION = 0.7  # keep the central 70% x 70% of the image

DEFINITION = (
    "A reference is a correct match for a query when the two images show a substantial "
    "common part of the same physical place, decided from ground-truth poses plus 3D "
    "structure (never camera position alone). 7-Scenes: back-project the query depth map "
    "(grid stride 4 px, default depth intrinsics fx=fy=585, cx=320, cy=240), transform it "
    "into the reference camera with both camera-to-world poses, and count a pixel as "
    "co-visible when it projects inside the reference image onto a valid reference depth "
    "within max(5 cm, 5%); overlap = co-visible / valid query pixels; positive if "
    f">= {SEVEN_POS}, ambiguous if in [{SEVEN_AMB}, {SEVEN_POS}). CLoc: the reference's "
    "observed SfM points that are predicted visible from the ground-truth query pose "
    "(inside the undistorted-projected image, viewing angle <= 45 deg to an observing "
    "database camera, coarse z-buffer); positive if >= 50 such points covering >= 30% of "
    "the query's and >= 20% of the reference's 128-px grid cells; ambiguous if >= 15 points "
    "and either coverage >= 10%. Only poses in the same scene frame are compared; "
    "references from other scenes/buildings are different places. Ambiguous references "
    "count neither as right nor wrong. Queries whose scene/building is held out of the "
    "reference pool have has_valid_reference=False."
)


@dataclass
class _Builder:
    out_dir: Path
    entries: list[ManifestEntry] = field(default_factory=list)
    labels: dict[str, QueryLabel] = field(default_factory=dict)
    overlaps: dict[str, dict] = field(default_factory=dict)

    def rel(self, p: Path) -> str:
        return os.path.relpath(Path(p).resolve(), self.out_dir.resolve())


def _lapvar(path: Path) -> float:
    g = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


def _seven_source() -> SourceInfo:
    return SourceInfo(
        url=sevenscenes.PROJECT_URL, license=sevenscenes.LICENSE, citation=sevenscenes.CITATION
    )


def _cloc_source() -> SourceInfo:
    return SourceInfo(url=cloc.REPO_URL, license=cloc.LICENSE, citation=cloc.CITATION)


def _seq_len(scene: str, seq: int) -> int:
    marker = sevenscenes.RAW_DIR / scene / f"seq-{seq:02d}" / ".complete.json"
    return int(json.loads(marker.read_text())["frames_in_sequence"])


def _seven_entry(b: _Builder, f: sevenscenes.Frame, role: str, split: str | None) -> ManifestEntry:
    conditions = []
    blur = _lapvar(f.color)
    if role == "query" and blur < BLUR_LAPVAR:
        conditions.append("real:motion_blur")
    return ManifestEntry(
        image_id=f"7scenes:{f.scene}:{f.frame_id}",
        path=b.rel(f.color),
        role=role,  # type: ignore[arg-type]
        dataset="7scenes",
        scene_id=f.scene,
        location_id=f"7scenes:{f.scene}",
        sequence_id=f"7scenes:{f.scene}:seq-{f.seq:02d}",
        frame_id=f.frame_id,
        timestamp_s=None,  # 7-Scenes provides no per-frame timestamps
        orientation=1,
        pose=Pose(
            matrix=f.pose().tolist(),
            convention="camera_to_world",
            frame=f"7scenes:{f.scene}:world",
        ),
        intrinsics=None,  # RGB camera is uncalibrated; depth intrinsics are in extra
        depth_path=b.rel(f.depth),
        conditions=conditions,
        split=split,  # type: ignore[arg-type]
        source=_seven_source(),
        extra={
            "depth_intrinsics": {"fx": 585.0, "fy": 585.0, "cx": 320.0, "cy": 240.0},
            "depth_units": "mm (uint16), 0 and 65535 invalid",
            "original_split": "train" if role == "reference" else "test",
            "laplacian_var": round(blur, 2),
        },
    )


def build_7scenes(b: _Builder) -> dict[str, list[sevenscenes.Frame]]:
    refs: dict[str, list[sevenscenes.Frame]] = {}
    for scene in SEVEN_REF_SCENES:
        refs[scene] = []
        for seq in sevenscenes.DEFAULT_SUBSET[scene]["train"]:
            for f in sevenscenes.list_frames(scene, seq):
                if f.index % SEVEN_REF_STRIDE == 0:
                    refs[scene].append(f)
                    b.entries.append(_seven_entry(b, f, "reference", None))
    ref_cache = {
        s: [(f, sevenscenes.load_depth_m(f.depth), f.pose()) for f in fr] for s, fr in refs.items()
    }
    for scene, seqs in SEVEN_QUERY_SPLITS.items():
        for seq, split in seqs.items():
            stride = _seq_len(scene, seq) // SEVEN_QUERIES_PER_SEQ
            for f in sevenscenes.list_frames(scene, seq):
                if f.index % stride != SEVEN_QUERY_OFFSET:
                    continue
                e = _seven_entry(b, f, "query", split)
                b.entries.append(e)
                _label_7scenes(b, e, f, ref_cache.get(scene), split)
    return refs


def _label_7scenes(b, e, f, ref_cache, split, *, mask=None, extra_note="") -> None:
    if ref_cache is None:
        b.labels[e.image_id] = QueryLabel(
            query_id=e.image_id,
            has_valid_reference=False,
            method="held_out_scene(7scenes)",
            conditions=e.conditions,
            split=split,
            notes=f"scene '{f.scene}' has no references in the pool{extra_note}",
        )
        b.overlaps[e.image_id] = {}
        return
    dq, Tq = sevenscenes.load_depth_m(f.depth), f.pose()
    scores = {}
    for rf, rd, rT in ref_cache:
        scores[f"7scenes:{rf.scene}:{rf.frame_id}"] = depth_overlap(
            dq, Tq, rd, rT, SEVEN_K, query_mask=mask
        )[0]
    pos = sorted([r for r, v in scores.items() if v >= SEVEN_POS], key=lambda r: -scores[r])
    amb = sorted(
        [r for r, v in scores.items() if SEVEN_AMB <= v < SEVEN_POS], key=lambda r: -scores[r]
    )
    best = max(scores.values())
    b.labels[e.image_id] = QueryLabel(
        query_id=e.image_id,
        has_valid_reference=bool(pos),
        positives=pos,
        ambiguous=amb,
        method=f"depth_reprojection_overlap>={SEVEN_POS}(amb>={SEVEN_AMB})",
        conditions=e.conditions,
        split=split,
        notes=f"best overlap {best:.3f} over {len(scores)} same-scene refs{extra_note}",
    )
    b.overlaps[e.image_id] = {
        r: round(v, 4) for r, v in sorted(scores.items(), key=lambda kv: -kv[1]) if v > 0
    }


# ----------------------------------------------------------------------------- CLoc


def _cloc_query_entry(b, building, member, split, K, dist, gt) -> ManifestEntry:
    rel = member.split("/query_sequences/")[1]
    session, chunk, fname = rel.split("/")
    t, q = gt[rel]
    w2c = np.eye(4)
    from placematch.datasets.colmap_io import qvec_to_rotmat

    w2c[:3, :3] = qvec_to_rotmat(q)
    w2c[:3, 3] = t
    conditions = ["real:different_camera"]
    if building in cloc.REFERENCE_BUILDINGS:
        conditions.append("real:long_term")
    path = cloc.RAW_DIR / building / member.split("/", 1)[1]
    return ManifestEntry(
        image_id=f"cloc:{building}:{rel}",
        path=b.rel(path),
        role="query",
        dataset="cloc",
        scene_id=building,
        location_id=f"cloc:{building}",
        sequence_id=f"cloc:{building}:{session}/{chunk}",
        frame_id=rel,
        timestamp_s=None,  # frame numbers are given but no frame rate/clock
        orientation=1,
        pose=Pose(matrix=w2c.tolist(), convention="world_to_camera", frame=f"cloc:{building}:sfm"),
        intrinsics=Intrinsics(
            fx=K[0, 0], fy=K[1, 1], cx=K[0, 2], cy=K[1, 2], width=1024, height=576
        ),
        conditions=conditions,
        split=split,
        source=_cloc_source(),
        extra={
            "distortion_opencv_k1k2p1p2k3": dist.tolist(),
            "session": session,
            "capture_date_from_session": session.split("-")[1],
        },
    )


def build_cloc(b: _Builder) -> None:
    from placematch.datasets import colmap_io

    sel = json.loads((cloc.RAW_DIR / "selection.json").read_text())
    for building, e in sel["buildings"].items():
        K, dist = cloc.load_intrinsics(building)
        gt = cloc.load_gt(building)
        vis_model = None
        ref_imgs = {}
        if building in cloc.REFERENCE_BUILDINGS:
            d = cloc.RAW_DIR / building / "Database" / "sfm_model"
            images = colmap_io.read_images(d / "images.bin")
            cams = colmap_io.read_cameras(d / "cameras.bin")
            vis_model = SfmVisibility(colmap_io.read_points3D(d / "points3D.bin"), images)
            by_name = {im.name: im for im in images.values()}
            for member in e["references"]:
                name = member.split("/Database/images/")[1]
                im, cam = by_name[name], cams[by_name[name].camera_id]
                rid = f"cloc:{building}:db/{name}"
                ref_imgs[rid] = (im, cam)
                Kr = cam.K()
                b.entries.append(
                    ManifestEntry(
                        image_id=rid,
                        path=b.rel(cloc.RAW_DIR / building / member.split("/", 1)[1]),
                        role="reference",
                        dataset="cloc",
                        scene_id=building,
                        location_id=f"cloc:{building}",
                        sequence_id=f"cloc:{building}:database",
                        frame_id=name,
                        timestamp_s=None,
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
                        ),
                        conditions=[],
                        split=None,
                        source=_cloc_source(),
                        extra={
                            "camera_model": cam.model,
                            "camera_params": cam.params.tolist(),
                            "capture_unix_time_from_name": float(
                                name.split("/")[-1].rsplit("_", 1)[0]
                            ),
                            "rig_camera": int(name.rsplit("_", 1)[1].split(".")[0]),
                            "sfm_observed_points": int((im.point3D_ids >= 0).sum()),
                        },
                    )
                )
        for split in ("validation", "test"):
            for member in e["queries"][split]:
                qe = _cloc_query_entry(b, building, member, split, K, dist, gt)
                b.entries.append(qe)
                if vis_model is None:
                    b.labels[qe.image_id] = QueryLabel(
                        query_id=qe.image_id,
                        has_valid_reference=False,
                        method="held_out_scene(cloc)",
                        conditions=qe.conditions,
                        split=split,
                        notes=f"building '{building}' has no references in the pool",
                    )
                    b.overlaps[qe.image_id] = {}
                    continue
                w2c = np.array(qe.pose.matrix)
                vis, uv = vis_model.visible(w2c, K, dist, *CLOC_QUERY_SIZE)
                stats = {
                    rid: vis_model.pair_stats(vis, uv, CLOC_QUERY_SIZE, im, (cam.width, cam.height))
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

                b.labels[qe.image_id] = QueryLabel(
                    query_id=qe.image_id,
                    has_valid_reference=bool(pos),
                    positives=sorted(pos, key=key),
                    ambiguous=sorted(amb, key=key),
                    method=CLOC_METHOD,
                    conditions=qe.conditions,
                    split=split,
                    notes=f"{int(vis.sum())} model points predicted visible in the query",
                )
                b.overlaps[qe.image_id] = {
                    rid: {
                        "shared": s.shared,
                        "covq": round(s.coverage_query, 3),
                        "covr": round(s.coverage_reference, 3),
                    }
                    for rid, s in sorted(stats.items(), key=lambda kv: -kv[1].shared)
                    if s.shared > 0
                }


# ----------------------------------------------------------------------------- synthetic


def _edit(img: np.ndarray, edit: str) -> tuple[np.ndarray, np.ndarray | None]:
    """Apply a synthetic edit. Returns (image, crop mask in original pixel grid or None)."""
    if edit == "dark":
        out = np.clip(img.astype(np.float32) * 0.25, 0, 255).astype(np.uint8)
        return out, None
    if edit == "motion_blur":
        k = np.zeros((1, 21), np.float32)
        k[0, :] = 1.0 / 21
        return cv2.filter2D(img, -1, k, borderType=cv2.BORDER_REFLECT), None
    if edit == "crop":
        h, w = img.shape[:2]
        ch, cw = int(round(h * CROP_FRACTION)), int(round(w * CROP_FRACTION))
        y0, x0 = (h - ch) // 2, (w - cw) // 2
        mask = np.zeros((h, w), bool)
        mask[y0 : y0 + ch, x0 : x0 + cw] = True
        return img[y0 : y0 + ch, x0 : x0 + cw].copy(), mask
    raise ValueError(edit)


def build_synthetic(b: _Builder, refs: dict[str, list[sevenscenes.Frame]]) -> None:
    ref_cache = {
        s: [(f, sevenscenes.load_depth_m(f.depth), f.pose()) for f in fr] for s, fr in refs.items()
    }
    by_id = {e.image_id: e for e in b.entries}
    synth_dir = b.out_dir / "synthetic"
    sources: list[ManifestEntry] = []
    for scene in (*SEVEN_REF_SCENES, *SEVEN_HELDOUT_SCENES):
        cands = [
            e
            for e in b.entries
            if e.dataset == "7scenes"
            and e.scene_id == scene
            and e.role == "query"
            and e.split == "test"
            and (scene in SEVEN_HELDOUT_SCENES or b.labels[e.image_id].has_valid_reference)
        ]
        cands.sort(key=lambda e: e.image_id)
        idx = np.linspace(0, len(cands) - 1, SYNTH_PER_SCENE).round().astype(int)
        sources += [cands[i] for i in sorted(set(idx.tolist()))]
    for src in sources:
        scene = src.scene_id
        seq = int(src.sequence_id.rsplit("seq-", 1)[1])
        index = int(src.frame_id.rsplit("frame-", 1)[1])
        frame = next(f for f in sevenscenes.list_frames(scene, seq) if f.index == index)
        img = cv2.imread(str(frame.color), cv2.IMREAD_COLOR)
        for edit in SYNTHETIC_EDITS:
            out_img, mask = _edit(img, edit)
            out = synth_dir / edit / f"{scene}_{src.frame_id.replace('/', '_')}.png"
            out.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(out), out_img)
            e = src.model_copy(deep=True)
            e.image_id = f"{src.image_id}:synthetic:{edit}"
            e.path = b.rel(out)
            e.conditions = [f"synthetic:{edit}"]
            e.depth_path = None if edit == "crop" else src.depth_path
            e.extra = {
                **src.extra,
                "derived_from": src.image_id,
                "synthetic_edit": edit,
                "edit_params": {
                    "dark": "pixel values x0.25",
                    "motion_blur": "horizontal box kernel, 21 px",
                    "crop": f"central {CROP_FRACTION:.0%} x {CROP_FRACTION:.0%}, not resized",
                }[edit],
            }
            if edit == "crop":
                e.extra["crop_note"] = "pose and depth refer to the uncropped source frame"
            b.entries.append(e)
            note = f"; synthetic '{edit}' of {src.image_id}"
            if edit == "crop":
                _label_7scenes(
                    b, e, frame, ref_cache.get(scene), "test", mask=mask, extra_note=note
                )
            else:
                lab = b.labels[src.image_id].model_copy(deep=True)
                lab.query_id = e.image_id
                lab.conditions = e.conditions
                lab.method += "+copied_from_source(photometric edit, same geometry)"
                if lab.agent_inspected:
                    lab.agent_inspected = False  # the edited image itself was not inspected
                    lab.notes += "; inherits the source's agent-inspected decision"
                lab.notes += note
                b.labels[e.image_id] = lab
                b.overlaps[e.image_id] = b.overlaps[src.image_id]
    assert len({e.image_id for e in b.entries}) == len(b.entries), "duplicate image ids"
    del by_id


# ----------------------------------------------------------------------------- inspection


def apply_inspection(b: _Builder, path: Path = INSPECTION_FILE) -> list[dict]:
    """Apply agent-inspected pair decisions (never marks anything as human-reviewed)."""
    if not path.is_file():
        return []
    records = json.loads(path.read_text())
    for r in records:
        lab = b.labels.get(r["query_id"])
        if lab is None:
            raise KeyError(f"inspection refers to unknown query {r['query_id']}")
        ref, decision = r["reference_id"], r["decision"]
        auto = (
            "positive"
            if ref in lab.positives
            else "ambiguous"
            if ref in lab.ambiguous
            else "negative"
        )
        r["auto_label"] = auto
        lab.agent_inspected = True
        lab.reviewed = False
        if decision != auto:
            lab.positives = [x for x in lab.positives if x != ref]
            lab.ambiguous = [x for x in lab.ambiguous if x != ref]
            if decision == "positive":
                lab.positives.append(ref)
            elif decision == "ambiguous":
                lab.ambiguous.append(ref)
            lab.has_valid_reference = bool(lab.positives)
            lab.method += "+agent_override"
        lab.notes += f"; agent-inspected {ref}: auto={auto}, agent={decision} ({r['note']})"
    return records


# ----------------------------------------------------------------------------- build


def summarize(manifest: Manifest, labels: LabelSet) -> dict:
    """Counts per scene, split, kind (real/synthetic), reference status and condition."""
    lab = {lb.query_id: lb for lb in labels.labels}
    refs: Counter = Counter()
    by_split: dict = defaultdict(lambda: {"by_scene": Counter(), "by_reference_status": Counter()})
    status_total: Counter = Counter()
    conditions: dict = defaultdict(Counter)
    for e in manifest.entries:
        key = f"{e.dataset}:{e.scene_id}"
        if e.role == "reference":
            refs[key] += 1
            continue
        lb = lab[e.image_id]
        kind = "synthetic" if any(c.startswith("synthetic:") for c in e.conditions) else "real"
        if lb.has_valid_reference:
            status = "with_valid_reference"
        elif lb.ambiguous:
            status = "ambiguous_only"
        else:
            status = "no_valid_reference"
        status_total[f"{kind}:{status}"] += 1
        by_split[f"{e.split}:{kind}"]["by_scene"][key] += 1
        by_split[f"{e.split}:{kind}"]["by_reference_status"][status] += 1
        for c in e.conditions or ["none"]:
            conditions[e.split][c] += 1
    out = {
        "n_references": sum(refs.values()),
        "n_queries": sum(status_total.values()),
        "references_by_scene": refs,
        "queries_by_reference_status": status_total,
        "queries_by_split": by_split,
        "query_conditions_by_split": conditions,
        "agent_inspected_queries": sum(1 for lb in labels.labels if lb.agent_inspected),
    }
    return json.loads(json.dumps(out))


def build(name: str = DEFAULT_NAME, *, out_root: Path = BENCH_DIR, synthetic: bool = True):
    out_dir = out_root / name
    out_dir.mkdir(parents=True, exist_ok=True)
    b = _Builder(out_dir)
    refs = build_7scenes(b)
    build_cloc(b)
    inspected = apply_inspection(b)  # before synthetic copies so they inherit corrections
    if synthetic:
        build_synthetic(b, refs)
    sel = json.loads((cloc.RAW_DIR / "selection.json").read_text())
    notes = {
        "sources": {
            "7scenes": {
                "url": sevenscenes.PROJECT_URL,
                "license": sevenscenes.LICENSE,
                "subset": sevenscenes.DEFAULT_SUBSET,
                "reference_frames": f"TrainSplit sequences, every {SEVEN_REF_STRIDE}th frame",
                "query_frames": (
                    f"TestSplit sequences, {SEVEN_QUERIES_PER_SEQ} per sequence "
                    f"(index % (len//{SEVEN_QUERIES_PER_SEQ}) == {SEVEN_QUERY_OFFSET})"
                ),
                "query_splits": SEVEN_QUERY_SPLITS,
                "held_out_scenes": list(SEVEN_HELDOUT_SCENES),
                "limitations": [
                    "RGB and depth cameras are uncalibrated and not registered; labels use "
                    "depth geometry only, RGB content is offset by a few pixels",
                    "poses are KinectFusion estimates of the depth camera",
                    "no per-frame timestamps",
                    "cross-scene co-visibility assumed zero (separate captures, separate "
                    "world frames)",
                ],
            },
            "cloc": {
                "url": cloc.REPO_URL,
                "data": cloc.DRIVE_FOLDER,
                "license": cloc.LICENSE,
                "selection": {k: v for k, v in sel.items() if k != "buildings"},
                "sfb_split_sessions": cloc.SFB_SPLIT_SESSIONS,
                "held_out_buildings": ["SFB"],
                "limitations": [
                    "labels come from sparse SfM visibility (no depth); textureless walls "
                    "contain no points; treat CLoc labels as lower confidence than 7-Scenes",
                    "NEB validation and test queries come from the same recording session, "
                    "split by alternating <=50-frame chunks",
                    "NEB1 (floor 1) and NEB2 (basement) are different floors of one "
                    "building and share no labelled co-visibility",
                ],
            },
        },
        "thresholds": {
            "7scenes": {"positive": SEVEN_POS, "ambiguous": SEVEN_AMB},
            "cloc": {"positive": CLOC_POS, "ambiguous": CLOC_AMB},
        },
        "conditions": {
            "real:motion_blur": (
                f"7-Scenes queries with variance of Laplacian < {BLUR_LAPVAR} (grey, full "
                "resolution); measured, can also fire on low-texture views"
            ),
            "real:long_term": (
                "CLoc NEB queries (2022-08 sessions) vs database captured 2021-03 (NEB2) / "
                "2021-12 (NEB1), from file names"
            ),
            "real:different_camera": "CLoc smartphone queries vs 4-camera rig database",
            "synthetic:*": "derived from real 7-Scenes test queries; never replace real ones",
        },
        "agent_inspection": {
            "file": "placematch/datasets/agent_inspection_v1.json",
            "n_pairs": len(inspected),
            "note": "agent-inspected only; no human review",
        },
    }
    manifest = Manifest(
        name=name,
        description=(
            "Small place-matching benchmark: 7-Scenes (chess, fire, heads, stairs references; "
            "office held out) and CLoc (NEB1, NEB2 references; SFB held out)."
        ),
        entries=b.entries,
        notes=notes,
    )
    labels = LabelSet(
        manifest="manifest.json",
        definition=DEFINITION,
        labels=[b.labels[e.image_id] for e in b.entries if e.role == "query"],
    )
    (out_dir / "manifest.json").write_text(manifest.model_dump_json(indent=1))
    (out_dir / "labels.json").write_text(labels.model_dump_json(indent=1))
    (out_dir / "overlaps.json").write_text(json.dumps(b.overlaps, indent=1))
    (out_dir / "agent_inspection_applied.json").write_text(json.dumps(inspected, indent=1))
    summary = summarize(manifest, labels)
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    return manifest, labels, summary


# ----------------------------------------------------------------------------- composites


def make_composite(paths: list[Path], out: Path, height: int = 300) -> None:
    from PIL import Image

    ims = []
    for p in paths:
        im = Image.open(p).convert("RGB")
        ims.append(im.resize((max(1, round(im.width * height / im.height)), height)))
    canvas = Image.new("RGB", (sum(i.width for i in ims) + 8 * (len(ims) - 1), height), "white")
    x = 0
    for im in ims:
        canvas.paste(im, (x, 0))
        x += im.width + 8
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, quality=88)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m placematch.datasets.bench")
    sub = ap.add_subparsers(dest="cmd", required=True)
    bp = sub.add_parser("build")
    bp.add_argument("--name", default=DEFAULT_NAME)
    bp.add_argument("--no-synthetic", action="store_true")
    bp.add_argument(
        "--version", choices=["v1", "v2"], default="v1", help="v2: placematch.datasets.bench_v2"
    )
    ip = sub.add_parser("composite", help="side-by-side image of a query and references")
    ip.add_argument("--bench", type=Path, default=BENCH_DIR / DEFAULT_NAME)
    ip.add_argument("--out", type=Path, required=True)
    ip.add_argument("ids", nargs="+", help="query id followed by reference ids")
    args = ap.parse_args(argv)
    if args.cmd == "build" and args.version == "v2":
        from placematch.datasets import bench_v2

        _, _, summary = bench_v2.build()
        print(json.dumps(summary["totals"], indent=2))
    elif args.cmd == "build":
        _, _, summary = build(args.name, synthetic=not args.no_synthetic)
        print(json.dumps(summary, indent=2))
    else:
        m = Manifest.model_validate_json((args.bench / "manifest.json").read_text())
        by = {e.image_id: e for e in m.entries}
        mp = args.bench / "manifest.json"
        make_composite([m.resolve(by[i], mp) for i in args.ids], args.out)


if __name__ == "__main__":
    main()
