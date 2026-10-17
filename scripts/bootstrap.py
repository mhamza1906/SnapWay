"""Reproduce the locked team environment on Windows, macOS or Linux."""

import json
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTRAS = ["--extra", "ai", "--extra", "geometry", "--extra", "mcp"]


def run(command, cwd=ROOT):
    print(f"Running: {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def main():
    uv = shutil.which("uv")
    npm = shutil.which("npm.cmd" if sys.platform == "win32" else "npm")
    node = shutil.which("node")
    if not all([uv, npm, node]):
        raise SystemExit("Install uv, Node 24.15+ (24.x), and npm 11 before bootstrap.")
    node_version = subprocess.check_output([node, "--version"], text=True).strip().lstrip("v")
    major, minor, *_ = map(int, node_version.split("."))
    if major != 24 or minor < 15:
        raise SystemExit("Use Node 24.x, at least 24.15; see .node-version.")
    npm_major = int(subprocess.check_output([npm, "--version"], text=True).split(".")[0])
    if npm_major != 11:
        raise SystemExit("Use npm 11; see apps/web/package.json.")
    for name in ("env", "logs", "artifacts", "tests", "research", "skills", "media", "static"):
        (ROOT / "local" / name).mkdir(parents=True, exist_ok=True)
    environment_file = ROOT / "local" / "env" / "api.env"
    if not environment_file.exists():
        template = (ROOT / ".env.example").read_text(encoding="utf-8")
        template = template.replace(
            "DJANGO_SECRET_KEY=", f"DJANGO_SECRET_KEY={secrets.token_urlsafe(64)}", 1
        )
        with environment_file.open("x", encoding="utf-8") as target:
            target.write(template)
        print("Created private local/env/api.env with a new development secret.")
    run([uv, "sync", "--locked", "--link-mode", "copy", *EXTRAS])
    run([npm, "ci", "--no-fund", "--no-audit"], ROOT / "apps" / "web")
    run([uv, "run", "--locked", *EXTRAS, "python", "apps/api/manage.py", "migrate", "--noinput"])
    run([uv, "run", "--locked", *EXTRAS, "python", "apps/api/manage.py", "check"])
    run([sys.executable, "scripts/check_docs.py"])
    manifest = {"python": sys.version.split()[0], "node": node_version, "platform": sys.platform}
    (ROOT / "local" / "logs" / "bootstrap.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(
        "Ready. Run python scripts/dev.py api and python scripts/dev.py web in separate terminals."
    )


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from error
