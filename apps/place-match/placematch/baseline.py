"""Check a frozen baseline inventory: ``python -m placematch.baseline verify <inventory.json>``.

Data, thresholds and results must match exactly. Source files are expected to evolve: their
differences are listed for information (the frozen source is in ``source.tar.gz``).
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from placematch.env import APP_DIR


def verify(inventory: Path) -> int:
    data = json.loads(inventory.read_text(encoding="utf-8"))
    bad = info = 0
    for group, files in data["sha256"].items():
        for rel, expected in files.items():
            path = APP_DIR / rel
            state = (
                "MISSING"
                if not path.is_file()
                else "CHANGED"
                if hashlib.sha256(path.read_bytes()).hexdigest() != expected
                else None
            )
            if state is None:
                continue
            if group == "source":
                info += 1
            else:
                print(f"{state}  [{group}] {rel}")
                bad += 1
    frozen = sum(len(v) for g, v in data["sha256"].items() if g != "source")
    print(f"{frozen - bad}/{frozen} frozen data/result files match {inventory}")
    print(f"{info} source files changed since the freeze (expected; see source.tar.gz)")
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "verify":
        sys.exit("usage: python -m placematch.baseline verify <inventory.json>")
    sys.exit(verify(Path(sys.argv[2])))
