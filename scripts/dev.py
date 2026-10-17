"""Portable shortcuts; all Python commands use the selected locked dependency profiles."""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=["api", "web", "mcp", "check"])
    target = parser.parse_args().target
    uv = shutil.which("uv")
    npm = shutil.which("npm.cmd" if sys.platform == "win32" else "npm")
    if not uv or not npm:
        raise SystemExit("Run bootstrap first; uv and npm must be installed.")
    prefix = [
        uv,
        "run",
        "--locked",
        "--extra",
        "ai",
        "--extra",
        "geometry",
        "--extra",
        "mcp",
        "--extra",
        "storage",
    ]
    if target == "api":
        commands = [
            ([*prefix, "python", "apps/api/manage.py", "runserver", "127.0.0.1:8000"], ROOT)
        ]
    elif target == "web":
        commands = [([npm, "start"], ROOT / "apps" / "web")]
    elif target == "mcp":
        commands = [([*prefix, "python", "-m", "apps.mcp.server"], ROOT)]
    else:
        commands = [
            ([sys.executable, "scripts/check_docs.py"], ROOT),
            ([sys.executable, "scripts/env_contract.py", "check"], ROOT),
            ([sys.executable, "scripts/check_audit_evidence.py"], ROOT),
            ([*prefix, "ruff", "check", "."], ROOT),
            ([*prefix, "ruff", "format", "--check", "."], ROOT),
            ([*prefix, "python", "apps/api/manage.py", "check"], ROOT),
            (
                [*prefix, "python", "apps/api/manage.py", "makemigrations", "--check", "--dry-run"],
                ROOT,
            ),
            ([*prefix, "pytest"], ROOT),
            ([npm, "run", "format:check"], ROOT / "apps" / "web"),
            ([npm, "test"], ROOT / "apps" / "web"),
            ([npm, "run", "build"], ROOT / "apps" / "web"),
            ([npm, "run", "build:visitor"], ROOT / "apps" / "web"),
        ]
    try:
        for command, cwd in commands:
            subprocess.run(command, cwd=cwd, check=True)
    except KeyboardInterrupt:
        return 130
    except subprocess.CalledProcessError as error:
        return error.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
