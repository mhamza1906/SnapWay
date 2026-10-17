"""Build a MegaLoc reference index for a Django revision photo tree.

Invoked by the SnapWay API as::

    uv run python -m placematch.ops.revision_embed \\
        --references DIR --root WORK --name SET

``DIR`` uses first-level subfolders as ``location_id`` (graph node ids).
Prints one JSON object to stdout (summary from ``build_reference_set``).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--references", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True, help="Reference-set parent directory")
    parser.add_argument("--name", required=True, help="Reference set name (letters/digits/._-)")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args(argv)

    from placematch.backends import get_backend
    from placematch.reference_sets import build_reference_set

    summary = build_reference_set(
        args.references.resolve(),
        args.name,
        get_backend("megaloc"),
        limit=args.limit,
        root=args.root.resolve(),
        log=lambda _msg: None,
    )
    print(json.dumps(summary, default=str))
    return 0 if summary.get("built") else 1


if __name__ == "__main__":
    sys.exit(main())
