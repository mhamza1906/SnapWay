"""Render the saved catalog snapshot offline with Python and installed Graphviz.

Run from the repository root: python docs/assets/database-schema/render.py
No database connection or application environment is used.
"""

import json
import re
import subprocess
import xml.etree.ElementTree as ET
from collections import defaultdict
from html import escape, unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SNAPSHOT = ROOT / "2026-10-17-snapway-catalog.json"
data = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
tables = {t["name"]: t for t in data["tables"]}
fks = [k for k in data["constraints"] if k["kind"] == "f"]
groups = {
    "Places & contributions": (
        "#2563eb",
        [
            "maps_building",
            "maps_floor",
            "maps_maptarget",
            "maps_membership",
            "maps_contribution",
            "maps_changeset",
            "maps_auditevent",
        ],
    ),
    "Revision & walkable graph": (
        "#7c3aed",
        ["maps_revision", "maps_mapobject", "maps_room", "maps_node", "maps_edge"],
    ),
    "Assets & scene evidence": (
        "#0891b2",
        ["maps_asset", "maps_referencephoto", "maps_scenerelationship"],
    ),
    "Review & publication": (
        "#059669",
        ["maps_review", "maps_revisionartifact", "maps_publication"],
    ),
    "Visitor navigation": (
        "#ea580c",
        [
            "navigation_navigationsession",
            "navigation_capture",
            "navigation_localizationresult",
            "navigation_route",
        ],
    ),
    "Durable jobs": ("#be185d", ["jobs_job", "jobs_jobattempt"]),
    "Identity & framework": (
        "#475569",
        [t for t in tables if not t.startswith(("maps_", "jobs_", "navigation_"))],
    ),
}
colors = {t: color for color, names in groups.values() for t in names}
short = {name: name.split("_", 1)[1] for name in tables}
# Selected physical FKs form a readable backbone; the full map contains all FKs.
backbone = {
    ("maps_floor", "building_id"),
    ("maps_maptarget", "floor_id"),
    ("maps_membership", "target_id"),
    ("maps_contribution", "target_id"),
    ("maps_changeset", "contribution_id"),
    ("maps_auditevent", "target_id"),
    ("maps_revision", "contribution_id"),
    ("maps_mapobject", "revision_id"),
    ("maps_room", "map_object_id"),
    ("maps_node", "room_id"),
    ("maps_edge", "from_node_id"),
    ("maps_edge", "to_node_id"),
    ("maps_asset", "target_id"),
    ("maps_referencephoto", "asset_id"),
    ("maps_scenerelationship", "reference_id"),
    ("maps_review", "revision_id"),
    ("maps_revisionartifact", "revision_id"),
    ("maps_publication", "revision_id"),
    ("maps_publication", "approval_id"),
    ("navigation_navigationsession", "publication_id"),
    ("navigation_capture", "session_id"),
    ("navigation_localizationresult", "capture_id"),
    ("navigation_route", "localization_id"),
    ("navigation_route", "destination_id"),
    ("jobs_job", "revision_id"),
    ("jobs_jobattempt", "job_id"),
    ("navigation_capture", "job_id"),
}


def quoted(value):
    return json.dumps(str(value))


def render(full):
    mode = "full" if full else "overview"
    selected = (
        list(tables)
        if full
        else [t for t in tables if t.startswith(("maps_", "jobs_", "navigation_"))]
    )
    selected_fks = (
        fks
        if full
        else [
            k for k in fks if len(k["columns"]) == 1 and (k["table"], k["columns"][0]) in backbone
        ]
    )
    edges = defaultdict(list)
    for k in selected_fks:
        assert k["table"] in selected and k["target_table"] in selected
        edges[(k["table"], k["target_table"])].append(k)
    direction = "LR" if full else "TB"
    lines = [
        "digraph schema {",
        f'graph [rankdir={direction}, bgcolor="#f8fafc", pad="0.5", nodesep="0.3", '
        'ranksep="0.6", splines=spline, fontname="Arial", compound=true, '
        "labeljust=l, labelloc=t];",
        'node [shape=plain, fontname="Arial", fontsize=11];',
        'edge [fontname="Arial", fontsize=9, color="#94a3b8", '
        'fontcolor="#475569", arrowsize=0.65];',
    ]
    for i, (label, (color, names)) in enumerate(groups.items()):
        names = [n for n in names if n in selected]
        if not names:
            continue
        lines.append(
            f'subgraph cluster_{i} {{ label={quoted(label)}; style="rounded,filled"; '
            f'fillcolor="white"; color="#e2e8f0"; fontcolor={quoted(color)}; '
            "fontsize=15; margin=18;"
        )
        for name in names:
            table = tables[name]
            keys = [k for k in data["constraints"] if k["table"] == name and k["kind"] == "p"]
            pk = ", ".join(c for k in keys for c in k["columns"])
            label_html = (
                '<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="7" '
                f'BGCOLOR="#f1f5f9"><TR><TD BGCOLOR="{color}"><FONT COLOR="white">'
                f'<B>{escape(name)}</B></FONT></TD></TR><TR><TD ALIGN="LEFT">'
                f'<FONT COLOR="#334155">PK {escape(pk)} · {len(table["columns"])} '
                "columns</FONT></TD></TR></TABLE>"
            )
            lines.append(
                f"{quoted(name)} [id={quoted(mode + '-' + name)}, label=<{label_html}>, "
                f"tooltip={quoted('snapway.' + name)}];"
            )
        lines.append("}")
    for i, ((child, parent), keys) in enumerate(edges.items()):
        tooltip = "\n".join(k["definition"] for k in keys)
        label = f"{len(keys)} FKs" if len(keys) > 1 else ", ".join(keys[0]["columns"])
        # Parent-to-child layout keeps the diagram readable; arrowheads at the
        # parent still represent the actual child-to-referenced-parent FK.
        lines.append(
            f"{quoted(parent)} -> {quoted(child)} "
            f"[dir=back, id={quoted(mode + '-edge-' + str(i))}, "
            f"label={quoted(label)}, tooltip={quoted(tooltip)}];"
        )
    lines.append("}")
    dot = ROOT / f"snapway-{mode}.dot"
    dot.write_text("\n".join(lines) + "\n", encoding="utf-8")
    subprocess.run(["dot", "-Tsvg", str(dot), "-o", str(ROOT / f"snapway-{mode}.svg")], check=True)
    # No external stylesheet, font, network request or live database connection.
    svg_path = ROOT / f"snapway-{mode}.svg"
    svg = svg_path.read_text(encoding="utf-8")
    svg = svg[svg.index("<svg") :]

    # Both SVGs share one HTML document; namespace Graphviz's automatic IDs too.
    def namespace_id(match):
        identifier = unescape(match[1])
        if not identifier.startswith(mode + "-"):
            identifier = mode + "-" + identifier
        return f'id="{escape(identifier, quote=True)}"'

    svg = re.sub(r'id="([^"]+)"', namespace_id, svg)
    # Graphviz point dimensions are retained for a useful 1:1 zoom level.
    root = ET.fromstring(svg)
    assert len(root.findall(".//{http://www.w3.org/2000/svg}g[@class='node']")) == len(selected)
    svg_path.write_text(svg, encoding="utf-8")
    return svg, {
        f"{mode}-edge-{i}": {"child": child, "parent": parent}
        for i, (child, parent) in enumerate(edges)
    }


overview, overview_edges = render(False)
full, full_edges = render(True)
serialized = json.dumps(data, ensure_ascii=True).replace("<", "\\u003c")
edge_data = json.dumps(overview_edges | full_edges)
template = (ROOT / "viewer.html.template").read_text(encoding="utf-8")
output = template.replace("__SNAPSHOT__", serialized).replace("__EDGES__", edge_data)
output = output.replace("__OVERVIEW__", overview).replace("__FULL__", full)
assert all(
    token not in output for token in ("__SNAPSHOT__", "__EDGES__", "__OVERVIEW__", "__FULL__")
)
(ROOT / "snapway-schema-map.html").write_text(output, encoding="utf-8")
print(
    f"Rendered {len(tables)} tables, {len(fks)} FKs, "
    f"{sum(len(t['columns']) for t in tables.values())} columns."
)
