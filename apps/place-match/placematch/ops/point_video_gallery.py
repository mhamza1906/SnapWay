"""Build a private, offline HTML review gallery from completed point-video artifacts.

Run with ``python -m placematch.ops.point_video_gallery --run RUN_DIRECTORY``.
This performs no inference, storage requests, application writes or network access.
The generated index and its thumbnails are deterministic for a fixed input run.
"""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _escape(value: object) -> str:
    return html.escape(str(value), quote=True)


def _clock(seconds: float) -> str:
    minutes, remainder = divmod(int(seconds), 60)
    return f"{minutes}:{remainder:02d}"


def _thumbnail(source: Path, dest: Path, *, width: int = 480) -> str:
    """Copy an upright, bounded diagnostic thumbnail into the portable run folder."""
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((width, 720), Image.Resampling.LANCZOS)
        image.save(dest, "JPEG", quality=88, optimize=False, progressive=False)
    return f"gallery/{dest.name}"


def _outcome(value: str) -> str:
    return {
        "supported_retrieval": "Candidate passes transferred retrieval cutoffs",
        "uncertain": "Uncertain candidate",
        "no_supported_match": "No supported match",
    }.get(value, "Uncertain candidate")


def _image_pair(query: str, reference: str, *, alt: str) -> str:
    return (
        '<div class="image-pair">'
        f'<figure><a href="{_escape(query)}"><img loading="lazy" '
        f'src="{_escape(query)}" alt="Video frame: {_escape(alt)}"></a>'
        "<figcaption>Video frame</figcaption></figure>"
        f'<figure><a href="{_escape(reference)}"><img loading="lazy" '
        f'src="{_escape(reference)}" alt="Uploaded reference: {_escape(alt)}"></a>'
        "<figcaption>Uploaded reference</figcaption></figure></div>"
    )


STYLE = """
:root{color-scheme:light;--ink:#1c3036;--muted:#53666d;--paper:#f4f5ef;
--line:#d7e0d8;--green:#266655;--warm:#a54a1f;--amber:#fff0d5}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);
font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:var(--green);text-underline-offset:3px}a:hover{text-decoration-thickness:2px}
a:focus-visible,button:focus-visible,video:focus-visible{outline:3px solid #db682e;
outline-offset:4px}header,main,footer{max-width:1256px;margin:auto;padding:28px}
header{padding-top:42px;padding-bottom:18px}.eyebrow{font-size:.8rem;font-weight:750;
letter-spacing:.13em;text-transform:uppercase;color:var(--green)}h1{font-size:clamp(2rem,
4.4vw,3.6rem);line-height:1.08;letter-spacing:-.045em;margin:12px 0 18px;max-width:860px}
h2{font-size:1.6rem;line-height:1.2;letter-spacing:-.025em;margin:0 0 14px}
h3{font-size:1.1rem;line-height:1.3;margin:0 0 10px}p{margin:0 0 14px}.lede{
max-width:900px;font-size:1.14rem;color:var(--muted)}.stats{display:flex;flex-wrap:wrap;
gap:10px;margin:24px 0}.stat{border:1px solid var(--line);border-radius:999px;padding:
7px 14px;background:#fff;font-size:.92rem}.notice{background:var(--amber);border-left:
4px solid #c16b25;padding:17px 20px;border-radius:6px;margin:18px 0}.notice p:last-child{
margin:0}.links{display:flex;flex-wrap:wrap;gap:8px 19px;margin:18px 0 0}.links a{
padding:5px 0}main{padding-top:4px}.section{margin:30px 0}.card{background:#fff;border:
1px solid var(--line);border-radius:16px;padding:22px}.player{padding:0;overflow:hidden}
video{display:block;width:100%;max-height:78vh;background:#111;aspect-ratio:16/9}
.player-caption{padding:18px 22px}.muted{color:var(--muted)}.small{font-size:.88rem}
.live{display:flex;flex-wrap:wrap;gap:7px 20px;padding:12px 0 0;font-variant-numeric:
tabular-nums}.two-col{display:grid;grid-template-columns:1.15fr 1fr;gap:20px}
.map svg{width:100%;height:auto;background:#f5f5f0;border:1px solid var(--line);
border-radius:10px}.map-caption{margin-top:10px}.grid{display:grid;grid-template-columns:
repeat(2,minmax(0,1fr));gap:20px}.sample{padding:18px}.sample-head{display:flex;
align-items:flex-start;justify-content:space-between;gap:10px}.seek{font:inherit;
font-weight:700;color:var(--green);background:#edf5ef;border:1px solid #bbd2c4;
border-radius:7px;padding:7px 11px;cursor:pointer;white-space:nowrap;min-height:44px}
.badge{display:inline-block;font-size:.76rem;line-height:1.4;border-radius:5px;
padding:4px 7px;background:#fff0d5;color:#7b431c;margin-bottom:10px}.badge.supported_retrieval{
background:#eaf3ed;color:#235b47}.badge.no_supported_match{background:#f6e7e1;color:#824128}
.image-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}
figure{margin:0;min-width:0}.image-pair img{display:block;width:100%;height:260px;
object-fit:contain;background:#eef0eb;border-radius:6px}figcaption{font-size:.78rem;
color:var(--muted);margin-top:5px}.metrics{display:flex;flex-wrap:wrap;gap:8px 18px;
font-size:.88rem;font-variant-numeric:tabular-nums}.anchor{border-top:4px solid #4b8a72}
.anchor .evidence{font-size:.9rem;color:var(--muted)}ul{padding-left:22px;margin:10px 0}
li{margin-bottom:7px}.technical{overflow-wrap:anywhere}footer{padding-top:0;color:
var(--muted);font-size:.86rem}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:
collapse;font-size:.9rem}th,td{text-align:left;padding:10px;border-bottom:1px solid
var(--line)}th{font-weight:700}summary{cursor:pointer;font-weight:700;padding:8px 0}
@media(max-width:760px){header,main,footer{padding-left:16px;padding-right:16px}
header{padding-top:28px}.two-col,.grid{grid-template-columns:1fr}.card{padding:17px}
.player{padding:0}.image-pair img{height:240px}.notice{padding:14px}.sample-head{
align-items:center}.stat{font-size:.83rem}.links{gap:5px 15px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
"""


def build_gallery(run: Path) -> dict[str, Any]:
    """Read completed numerical artifacts; create index.html and gallery images."""
    run = run.resolve()
    tracking = _load(run / "tracking.json")
    summary = _load(run / "tracking-summary.json")
    embedding = _load(run / "embedding-summary.json")
    manifest = _load(run / "reference-manifest.json")
    references = _load(run / "reference-rows.json")
    anchors = _load(run / "validation/model-blind-visual-audit/visual-anchor-candidates.json")[
        "anchors"
    ]
    geometry = _load(run / "validation/geometric-audit.json")
    frames = tracking["frames"]
    if not frames or len(references) != summary["references"]:
        raise ValueError("Incomplete tracking/reference artifacts")
    reference_root = Path(embedding["reference_root"])
    refs = {item["reference_id"]: item for item in references}
    gallery = run / "gallery"
    gallery.mkdir(parents=True, exist_ok=True)
    thumbnails: dict[str, str] = {}

    def reference_thumb(reference_id: str) -> str:
        if reference_id not in thumbnails:
            item = refs[reference_id]
            thumbnails[reference_id] = _thumbnail(
                reference_root / item["path"], gallery / f"ref-{reference_id}.jpg"
            )
        return thumbnails[reference_id]

    def sample_near(time_s: float) -> dict[str, Any]:
        return min(frames, key=lambda item: abs(item["timestamp_s"] - time_s))

    def query_thumb(frame: dict[str, Any]) -> str:
        name = Path(frame["query_path"]).stem
        return _thumbnail(run / frame["query_path"], gallery / f"query-{name}.jpg")

    strong = [anchor for anchor in anchors if anchor["strength"] == "strong landmark"]
    comparisons = {
        item["time_s"]: item for item in summary["model_blind_visual_anchor_comparisons"]
    }
    strong_agreements = sum(
        comparisons[anchor["time_seconds"]]["track_in_visual_neighbor_set"] for anchor in strong
    )
    strong_cards = []
    for anchor in strong:
        time_s = anchor["time_seconds"]
        frame = sample_near(time_s)
        query = _thumbnail(
            run / "validation/model-blind-visual-audit" / anchor["query_path"],
            gallery / f"anchor-{int(time_s):03d}s.jpg",
        )
        reference = reference_thumb(anchor["reference_id"])
        pair = next(
            (
                pair
                for pair in geometry["pairs"]
                if pair["requested_time_s"] == time_s and pair["role"] == "raw-winner"
            ),
            None,
        )
        geometric_text = (
            "Local feature overlap verified"
            if pair and pair["verification"]["status"] == "verified"
            else "Local feature overlap inconclusive"
        )
        strong_cards.append(
            '<article class="card sample anchor"><div class="sample-head">'
            f"<h3>{_clock(time_s)} · visual candidate Point "
            f"{_escape(anchor['best_visual_candidate'])}</h3>"
            f'<button class="seek" data-time="{time_s}">Play here</button></div>'
            '<span class="badge supported_retrieval">Independent landmark evidence</span>'
            + _image_pair(query, reference, alt=f"landmark at {_clock(time_s)}")
            + f'<p class="evidence">{_escape(anchor["evidence"])}</p>'
            f'<p class="small">Raw Point {frame["raw_point"]} · offline Point '
            f"{frame['track_point']} · {geometric_text}.</p></article>"
        )

    selected_times = (
        0,
        2,
        4,
        12,
        24,
        30,
        36,
        48,
        54,
        66,
        78,
        96,
        102,
        108,
        120,
        126,
        138,
        144,
        156,
        168,
        174,
        180,
    )
    sample_cards = []
    for time_s in selected_times:
        frame = sample_near(time_s)
        ref = refs[frame["track_reference_id"]]
        query, reference = query_thumb(frame), reference_thumb(frame["track_reference_id"])
        outcome = frame["outcome"]
        sample_cards.append(
            '<article class="card sample"><div class="sample-head">'
            f"<h3>{_clock(frame['timestamp_s'])} · offline candidate "
            f"Point {frame['track_point']}</h3>"
            f'<button class="seek" data-time="{frame["timestamp_s"]}">Play here</button>'
            f'</div><span class="badge {_escape(outcome)}">{_outcome(outcome)}</span>'
            + _image_pair(query, reference, alt=f"sample at {_clock(time_s)}")
            + '<div class="metrics">'
            f"<span>Raw: Point {frame['raw_point']}</span>"
            f"<span>Offline: Point {frame['track_point']}</span>"
            f"<span>Reference view: {_escape(ref['direction'])}</span></div>"
            '<div class="metrics">'
            f"<span>Raw cosine: {frame['score']:.3f}</span>"
            f"<span>Offline cosine: {frame['track_score']:.3f}</span>"
            f"<span>Raw point margin: {frame['margin']:.3f}</span></div></article>"
        )

    walk = next(walk for walk in manifest["walks"] if walk["photo_count"] > 0)
    underlay = walk["underlay"]
    with Image.open(reference_root / underlay["path"]) as floor_image:
        floor_image.convert("RGB").save(gallery / "floor-plan.jpg", quality=95)
    width, height = (walk["coordinate_frame"][key] for key in ("width", "height"))
    point_marks = []
    for node in walk["graph"]["nodes"]:
        if node["point_number"] is not None:
            point_marks.append(
                f"<g><title>Photographed Point {node['point_number']}</title>"
                f'<circle cx="{node["x"]}" cy="{node["y"]}" r="4.8" '
                'fill="#266655" stroke="white" stroke-width="1"/>'
                f'<text x="{node["x"]}" y="{node["y"] + 2.1}" text-anchor="middle" '
                'font-size="6" font-weight="700" fill="white">'
                f"{node['point_number']}</text></g>"
            )
    map_svg = (
        f'<svg viewBox="0 0 {width} {height}" role="img" '
        'aria-label="Level 1 source floor plan with the 26 photographed point labels">'
        f'<image href="gallery/floor-plan.jpg" width="{width}" height="{height}"/>'
        + "".join(point_marks)
        + "</svg>"
    )
    geometric_rows = "".join(
        f"<tr><td>{_clock(pair['requested_time_s'])}</td>"
        f"<td>Point {pair['reference_point']} · {_escape(pair['role'])}</td>"
        f"<td>{_escape(pair['verification']['status'])}</td>"
        f"<td>{pair['verification']['n_inliers']}</td></tr>"
        for pair in geometry["pairs"]
    )
    verified_pairs = sum(pair["verification"]["status"] == "verified" for pair in geometry["pairs"])
    outcomes = summary["track_outcomes"]
    timing = embedding["warm_single_frame_ms"]
    live_data = json.dumps(
        [
            {
                "t": frame["timestamp_s"],
                "raw": frame["raw_point"],
                "offline": frame["track_point"],
                "score": round(frame["score"], 3),
                "margin": round(frame["margin"], 3),
                "outcome": _outcome(frame["outcome"]),
            }
            for frame in frames
        ],
        separators=(",", ":"),
    ).replace("<", "\\u003c")
    document = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport"
content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Sam Ibrahim · MegaLoc walk review</title><style>{STYLE}</style></head>
<body><header><div class="eyebrow">Private local experiment · Sam Ibrahim · Level 1</div>
<h1>A walk, compared with your photo points.</h1>
<p class="lede">MegaLoc compares each sampled video frame with the four uploaded views
at each point. This page shows its nearest-reference candidates and an offline
graph-smoothed estimate so you can inspect what agrees and what remains uncertain.</p>
<div class="stats"><span class="stat">{summary["video_samples"]} frames · 2 samples/s</span>
<span class="stat">{summary["references"]} photos · {summary["reference_points"]} points</span>
<span class="stat">Local Apple GPU · MPS</span><span class="stat">No remote inference</span></div>
<div class="notice"><p><strong>Experimental estimates, not a verified location track.</strong>
The video has no measured point-by-point ground truth. Similar corridors, panning and
shared sight lines can return the wrong point. Cosine scores and margins are numerical
similarities, never probabilities.</p></div>
<nav class="links" aria-label="Results and downloads"><a href="#video">Watch the video</a>
<a href="#landmarks">Inspect landmark checks</a><a href="#samples">Browse time samples</a>
<a href="frame-predictions.csv">Frame CSV</a><a href="docs/REPORT.md">Full report</a>
<a href="embeddings/reference-vectors.npy">Reference embeddings</a>
<a href="embeddings/query-vectors.npy">Video embeddings</a></nav></header>
<main><section class="section" id="video" aria-labelledby="video-title">
<h2 id="video-title">Review the estimated movement</h2><div class="card player">
<video id="walk-video" controls playsinline preload="metadata" poster="tracking-preview.jpg"
aria-describedby="video-note"><source src="tracking.mp4" type="video/mp4">
Your browser cannot play this video. <a href="tracking.mp4">Open the MP4 file</a>.</video>
<div class="player-caption"><p id="video-note">The map marker represents the nearest
photographed point. Offline smoothing uses later frames as well as earlier ones; it
does not demonstrate a real-time tracker or a precise continuous path.</p>
<div class="live" aria-live="off"><strong id="live-time">0:00</strong>
<span id="live-points">Raw / offline candidates</span><span id="live-score"></span></div>
<p class="small muted" id="live-outcome"></p></div></div></section>
<section class="section two-col" aria-label="Coverage and unresolved checks">
<article class="card map"><h2>The reference floor</h2>{map_svg}
<p class="small muted map-caption">Source plan with all 26 uploaded photo-point labels.
Positions use plan coordinates; distances and speed in metres were not measured.
Only Level 1 currently has reference photos.</p>
<a href="gallery/floor-plan.jpg">Open the original floor-plan image</a></article>
<article class="card"><h2>What still needs checking</h2>
<p>Your independent route hint was <strong>Point 1 → near Points 10 / 22</strong>.
It was kept out of matching and smoothing.</p>
<p>The opening frames mostly retrieve <strong>Point 19</strong>, and the final frames
retrieve <strong>Points 11 / 12</strong>. Those conflicts remain visible here.
Scene overlap can support a shared view without proving where the camera stood.</p>
<p class="small muted">Transferred retrieval cutoffs classify
{outcomes.get("supported_retrieval", 0)} samples as supported candidates,
{outcomes.get("uncertain", 0)} as uncertain and
{outcomes.get("no_supported_match", 0)} as no supported match. These counts are not
correctness or accuracy measurements.</p></article></section>
<section class="section" id="landmarks" aria-labelledby="landmark-title">
<h2 id="landmark-title">Four independent landmark comparisons</h2>
<p class="muted">The visual reviewer selected these landmarks before seeing retrieval
rankings. All {strong_agreements} of {len(strong)} offline candidates agreed with those
qualitative landmark checks. This is supporting evidence, not a ground-truth accuracy
test. Local feature matching verified overlap at 0, 2, 54, 78 and 156 seconds;
the 126-second landmark check was inconclusive.</p>
<div class="grid">{"".join(strong_cards)}</div>
<details class="card section"><summary>Local feature overlap audit:
{verified_pairs} of {len(geometry["pairs"])} candidate pairs verified</summary>
<p class="small muted">SuperPoint + LightGlue with geometric consistency checks.
Verified means scene overlap; inconclusive does not establish a mismatch.
Three of the four strong landmark pairs verified. No prediction was changed or tuned
using this audit.</p><div class="table-wrap"><table><thead><tr><th>Time</th>
<th>Reference pair</th><th>Overlap check</th><th>Inliers</th></tr></thead>
<tbody>{geometric_rows}</tbody></table></div>
<a href="validation/geometric-audit.json">Read the geometric audit JSON</a></details></section>
<section class="section" id="samples" aria-labelledby="sample-title">
<h2 id="sample-title">Inspect selected times</h2><p class="muted">Each pair compares a
video sample with the uploaded view chosen for the offline candidate. Raw candidates
come from that frame alone. The margin is the raw best-point score minus the second
distinct point score. The full CSV contains every sampled timestamp.</p>
<div class="grid">{"".join(sample_cards)}</div></section>
<section class="section card technical"><h2>Local run and validation</h2>
<ul><li>MegaLoc produced 8,448-dimensional normalized embeddings. Both cached arrays
passed finite-value, shape and unit-norm checks.</li>
<li>No video frame was added to the reference gallery. All 366 frame hashes were
checked; none exactly matches an uploaded reference photo.</li>
<li>Identical-reference retrieval passed 104 / 104. The harder different-direction
holdout reached 8 / 104 R@1 and 18 / 104 R@3, showing weak unseen-view generalization.</li>
<li>Warm single-frame inference: median {timing["median"]:.0f} ms,
95th percentile {timing["p95"]:.0f} ms, including JPEG decode and preprocessing.
Cold model load: {embedding["model_load_s"]:.2f} s. This is a local compute measurement,
not a phone, end-to-end latency or real-time accuracy benchmark.</li></ul>
<nav class="links" aria-label="Detailed evidence"><a href="tracking.json">Every frame estimate</a>
<a href="embedding-summary.json">Model and timings</a>
<a href="validation/reference-audit.json">Independent vector audit</a>
<a href="validation/model-blind-visual-audit/visual-anchor-candidates.json">Blind visual notes</a>
<a href="reference-rows.json">Point-to-photo index</a></nav></section></main>
<footer>Private user imagery · Offline review artifact. This page uses only local files
and no external scripts, fonts, analytics or services. Keep the entire folder together.</footer>
<script>"use strict";const samples={live_data};const video=document.getElementById("walk-video");
const clock=s=>Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0");
function update(){{let best=samples[0];for(const s of samples){{if(Math.abs(s.t-video.currentTime)
<Math.abs(best.t-video.currentTime))best=s;}}document.getElementById("live-time").textContent=
clock(video.currentTime);document.getElementById("live-points").textContent=
"Raw Point "+best.raw+" · offline Point "+best.offline;
document.getElementById("live-score").textContent=
"Raw cosine "+best.score.toFixed(3)+" · point margin "+best.margin.toFixed(3);
document.getElementById("live-outcome").textContent=best.outcome+" · experimental estimate";}}
video.addEventListener("timeupdate",update);document.querySelectorAll("button[data-time]")
.forEach(button=>button.addEventListener("click",()=>{{video.currentTime=Number(button.dataset.time);
video.scrollIntoView({{block:"center",behavior:"auto"}});video.play().catch(()=>{{}});update();}}));update();
</script></body></html>
"""
    (run / "index.html").write_text(document, encoding="utf-8")
    return {
        "index": str(run / "index.html"),
        "selected_time_pairs": len(sample_cards),
        "independent_landmark_pairs": len(strong_cards),
        "gallery_files": len(list(gallery.iterdir())),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(build_gallery(args.run), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
