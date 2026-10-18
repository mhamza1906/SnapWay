"""Package committed backend source and the validated Angular browser artifact."""

import argparse
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path, PurePosixPath

MOBILE_SOURCE_PATHS = (
    "apps/pipeline",
    "apps/place-match",
    "experiments/sam-ibrahim-hardcoded",
    ".node-version",
    "infra/units/snapway-pipeline.service",
    "infra/units/snapway-placematch.service",
)
MOBILE_REQUIRED_PATHS = (
    "apps/pipeline/package.json",
    "apps/pipeline/package-lock.json",
    "apps/place-match/pyproject.toml",
    "apps/place-match/uv.lock",
    "experiments/sam-ibrahim-hardcoded/source",
    *MOBILE_SOURCE_PATHS,
)
MOBILE_MOUNT_POINTS = (
    "apps/pipeline/.local",
    "apps/pipeline/output",
    "apps/pipeline/node_modules",
    "apps/place-match/data",
    "apps/place-match/runs",
)


def mobile_runtime_artifact(name):
    """Do not ship local state, secrets or model weights, even if tracked by mistake."""
    path = PurePosixPath(name).relative_to("source")
    if not any(str(path).startswith(prefix + "/") for prefix in MOBILE_SOURCE_PATHS[:3]):
        return False
    if any(
        part
        in {
            ".local",
            "local",
            "node_modules",
            ".venv",
            "__pycache__",
            "output",
            "runs",
            "models",
            "weights",
        }
        for part in path.parts
    ):
        return True
    if path.parts[:3] == ("apps", "place-match", "data"):
        return True
    return (
        (path.name == ".env" or path.name.startswith(".env."))
        and not path.name.endswith(".example")
    ) or path.suffix.lower() in {
        ".safetensors",
        ".pt",
        ".pth",
        ".ckpt",
        ".onnx",
        ".bin",
        ".pyc",
        ".npy",
        ".npz",
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".mov",
        ".mp4",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release")
    parser.add_argument("--web", type=Path, default=Path("apps/web/dist/snapway/browser"))
    parser.add_argument("--output", type=Path, default=Path("local/release.tar.gz"))
    parser.add_argument(
        "--with-mobile-services",
        action="store_true",
        help=(
            "also package existing pipeline/matching sources and reviewed unit templates; "
            "does not enable them"
        ),
    )
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}-[0-9]+-[0-9]+", args.release):
        parser.error("Invalid release ID")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if args.release.split("-")[0] != commit:
        parser.error("Release ID must match the checked-out commit")
    if not (args.web / "index.html").is_file():
        parser.error("Angular browser artifact is missing")
    extra_paths = []
    if args.with_mobile_services:
        for path in MOBILE_REQUIRED_PATHS:
            result = subprocess.run(["git", "cat-file", "-e", f"HEAD:{path}"], capture_output=True)
            if result.returncode:
                parser.error(f"Mobile service source must be committed before packaging: {path}")
        extra_paths = list(MOBILE_SOURCE_PATHS)
    # git archive excludes ignored/uncommitted files; the opt-in filter also
    # excludes accidentally tracked private/runtime/model artifacts. Disable
    # checkout newline conversion so Windows Git emits the committed Linux
    # source bytes rather than CRLF scripts and service templates.
    source = subprocess.check_output(
        [
            "git",
            "-c",
            "core.autocrlf=false",
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
            ".env.example",
            "scripts/env_contract.py",
            *extra_paths,
        ]
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(args.output, "w:gz") as archive:
        with tarfile.open(fileobj=io.BytesIO(source)) as backend:
            for member in backend:
                if args.with_mobile_services and mobile_runtime_artifact(member.name):
                    continue
                if not member.isfile() and not member.isdir():
                    raise ValueError("Backend archives must contain only regular files/directories")
                archive.addfile(member, backend.extractfile(member) if member.isfile() else None)
        if args.with_mobile_services:
            # systemd bind mounts require real destinations in the immutable
            # release. Their contents live in protected shared directories.
            for path in MOBILE_MOUNT_POINTS:
                member = tarfile.TarInfo("source/" + path)
                member.type = tarfile.DIRTYPE
                member.mode = 0o755
                archive.addfile(member)
        for file in sorted(args.web.rglob("*")):
            if file.is_symlink():
                raise ValueError("Frontend assets must not contain symbolic links")
            if file.is_file():
                archive.add(file, arcname="web/" + file.relative_to(args.web).as_posix())
        metadata = {"release": args.release, "commit": commit}
        if args.with_mobile_services:
            metadata["components"] = {
                "api": {"source": "source/apps/api", "lockfile": "source/uv.lock"},
                "mcp": {"source": "source/apps/mcp", "lockfile": "source/uv.lock"},
                "web": {"assets": "web"},
                "pipeline": {
                    "source": "source/apps/pipeline",
                    "lockfile": "source/apps/pipeline/package-lock.json",
                },
                "place_match": {
                    "source": "source/apps/place-match",
                    "lockfile": "source/apps/place-match/uv.lock",
                },
                "sam_ibrahim": {"source": "source/experiments/sam-ibrahim-hardcoded"},
            }
            metadata["service_templates"] = [
                "source/infra/units/snapway-pipeline.service",
                "source/infra/units/snapway-placematch.service",
            ]
        manifest = json.dumps(metadata).encode()
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
