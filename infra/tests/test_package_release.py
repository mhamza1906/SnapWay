"""Verify release boundaries using a disposable repository, never production data."""

import hashlib
import json
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from scripts.ci_changes import classify_changes


def test_package_contains_committed_source_and_browser_but_no_local_secrets(tmp_path):
    tracked = {
        "apps/api/app.py": "committed application",
        "apps/mcp/server.py": "scaffold",
        "packages/geometry/__init__.py": "",
        "pyproject.toml": "[project]\nname='fixture'\n",
        "uv.lock": "lock fixture",
        ".python-version": "3.12.14",
        ".env.example": "ENV_SCHEMA_VERSION=fixture\n",
        "scripts/env_contract.py": "# public validator fixture\n",
    }
    for name, content in tracked.items():
        file = tmp_path / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)

    def git(*args):
        return subprocess.check_output(["git", "-C", str(tmp_path), *args], text=True).strip()

    git("init", "--quiet")
    git("add", ".")
    git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "--quiet",
        "-m",
        "fixture",
    )
    commit = git("rev-parse", "HEAD")
    # Neither the working-tree edit nor this private file may enter the package.
    (tmp_path / "apps/api/app.py").write_text("uncommitted edit")
    (tmp_path / "local").mkdir()
    (tmp_path / "local/api.env").write_text("DATABASE_URL=private-secret")
    web = tmp_path / "browser"
    web.mkdir()
    (web / "index.html").write_text("validated frontend")
    (web / "main-HASH1234.js").write_text("browser chunk")
    output = tmp_path / "release.tar.gz"
    release = commit + "-12-1"
    script = Path(__file__).parents[2] / "scripts/package_release.py"
    subprocess.run(
        [sys.executable, str(script), release, "--web", str(web), "--output", str(output)],
        cwd=tmp_path,
        check=True,
    )
    with tarfile.open(output) as archive:
        assert archive.extractfile("source/apps/api/app.py").read() == b"committed application"
        assert archive.extractfile("web/index.html").read() == b"validated frontend"
        assert archive.extractfile("source/.env.example").read().decode().splitlines() == [
            "ENV_SCHEMA_VERSION=fixture"
        ]
        assert archive.extractfile("source/scripts/env_contract.py").read()
        assert json.load(archive.extractfile("release.json")) == {
            "release": release,
            "commit": commit,
        }
        assert all(
            "local/" not in name and not name.endswith(".env") for name in archive.getnames()
        )
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    assert output.with_suffix(".gz.sha256").read_text() == f"{digest}  release.tar.gz\n"


@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        (["infra/deploy.py"], (True, True, True)),
        (["infra/install-server.sh"], (True, True, True)),
        (["infra/README.md", "docs/deployment.md"], (False, False, False)),
        (["local/.env"], (False, False, False)),
        (["apps/api/config/settings/production.py"], (True, False, False)),
        (["apps/web/src/main.ts"], (False, True, False)),
        (["docs/deployment.md", "apps/api/app.py"], (True, False, False)),
        ([".env.example"], (True, False, True)),
    ],
)
def test_deployment_inputs_preserve_documentation_exclusions(paths, expected):
    assert classify_changes(paths) == expected
