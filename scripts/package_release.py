"""Package committed backend source and the validated Angular browser artifact."""

import argparse
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release")
    parser.add_argument("--web", type=Path, default=Path("apps/web/dist/snapway/browser"))
    parser.add_argument("--output", type=Path, default=Path("local/release.tar.gz"))
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}-[0-9]+-[0-9]+", args.release):
        parser.error("Invalid release ID")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if args.release.split("-")[0] != commit:
        parser.error("Release ID must match the checked-out commit")
    if not (args.web / "index.html").is_file():
        parser.error("Angular browser artifact is missing")
    # git archive excludes local environments, credentials and uncommitted files.
    source = subprocess.check_output(
        [
            "git",
            "archive",
            "--format=tar",
            "--prefix=source/",
            "HEAD",
            "apps/api",
            "apps/mcp",
            "packages",
            "pyproject.toml",
            "uv.lock",
            ".python-version",
        ]
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(args.output, "w:gz") as archive:
        with tarfile.open(fileobj=io.BytesIO(source)) as backend:
            for member in backend:
                if not member.isfile() and not member.isdir():
                    raise ValueError("Backend archives must contain only regular files/directories")
                archive.addfile(member, backend.extractfile(member) if member.isfile() else None)
        for file in sorted(args.web.rglob("*")):
            if file.is_symlink():
                raise ValueError("Frontend assets must not contain symbolic links")
            if file.is_file():
                archive.add(file, arcname="web/" + file.relative_to(args.web).as_posix())
        manifest = json.dumps({"release": args.release, "commit": commit}).encode()
        member = tarfile.TarInfo("release.json")
        member.size = len(manifest)
        member.mode = 0o644
        archive.addfile(member, io.BytesIO(manifest))
    digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
    args.output.with_suffix(args.output.suffix + ".sha256").write_text(
        f"{digest}  {args.output.name}\n", encoding="ascii"
    )
    print(f"Packaged {args.release}: {digest}")


if __name__ == "__main__":
    main()
