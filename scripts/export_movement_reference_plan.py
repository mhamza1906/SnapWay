#!/usr/bin/env python3
"""Restore the experiment's graph from the original photographed-node export, without DB writes."""

import argparse
import hashlib
import json
from pathlib import Path


def export(manifest, template):
    walk = next(w for w in manifest["walks"] if w["title"] == "Sam Ibrahim · Level 1 circulation 2")
    refs = [r for r in manifest["references"] if r["target_id"] == walk["target_id"]]
    ids = {r["node_id"] for r in refs}
    plan = dict(template)
    plan.update(
        title=walk["title"],
        floor=walk["floor"],
        width=walk["coordinate_frame"]["width"],
        height=walk["coordinate_frame"]["height"],
        sourceRevision=walk["revision_id"],
        metresPerUnit=walk["metres_per_unit"],
        northDegrees=walk["north_degrees"],
    )
    plan["nodes"] = [
        {k: n[k] for k in ["id", "label", "kind", "x", "y"]} for n in walk["graph"]["nodes"]
    ]
    plan["edges"] = [
        {"from": e["from_node"], "to": e["to_node"]} for e in walk["graph"]["edges"] if e["is_open"]
    ]
    assert plan["entryId"] in ids, "The entry must retain its original reference-node identity."
    plan["referenceEvidence"] = {
        "source": walk["photo_walk_source"],
        "photographedNodes": len(ids),
        "photoCount": len(refs),
        "newPhotoStopsCreated": 0,
        "originalReferencePositionsPreserved": True,
        "visualNodeIds": sorted(ids),
        "manifestSha256": hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest(),
    }
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument(
        "--plan", type=Path, default=Path("apps/web/public/experiments/entrance-node19.json")
    )
    args = parser.parse_args()
    plan = export(json.loads(args.manifest.read_text()), json.loads(args.plan.read_text()))
    args.plan.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
    print(
        f"Restored {plan['referenceEvidence']['photographedNodes']} photographed points, "
        f"{len(plan['nodes'])} graph vertices; IDs and coordinates unchanged."
    )


if __name__ == "__main__":
    main()
