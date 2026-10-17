"""Classify changed inputs for CI without running application builds for docs only."""

import os
import subprocess
from pathlib import Path


def main():
    base = os.environ.get("BASE_SHA", "")
    head = os.environ.get("HEAD_SHA", "HEAD")
    if not base or set(base) == {"0"}:
        paths = subprocess.check_output(["git", "ls-files"], text=True).splitlines()
    else:
        paths = subprocess.check_output(
            ["git", "diff", "--name-only", base, head], text=True
        ).splitlines()
    shared = any(p.startswith(("scripts/", ".github/", "contracts/")) for p in paths)
    backend = shared or any(
        p.startswith(("apps/api/", "apps/mcp/", "packages/"))
        or p in {"pyproject.toml", "uv.lock", ".python-version", ".env.example"}
        for p in paths
    )
    web = shared or any(
        p.startswith("apps/web/") or p in {".node-version", ".editorconfig"} for p in paths
    )
    result = f"backend={str(backend).lower()}\nweb={str(web).lower()}\n"
    print(result, end="")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with Path(output).open("a", encoding="utf-8") as stream:
            stream.write(result)


if __name__ == "__main__":
    main()
