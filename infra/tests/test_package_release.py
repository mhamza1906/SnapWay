"""Verify release boundaries using a disposable repository, never production data."""

import hashlib
import json
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from scripts.ci_changes import classify_changes


@pytest.mark.parametrize("with_mobile_services", [False, True])
def test_package_contains_committed_source_and_browser_but_no_local_secrets(
    tmp_path, with_mobile_services
):
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
    mobile_tracked = {
        "apps/pipeline/package.json": '{"dependencies": {}}',
        "apps/pipeline/package-lock.json": '{"lockfileVersion": 3}',
        "apps/pipeline/server/start.js": "// committed pipeline",
        "apps/place-match/pyproject.toml": "[project]\nname='placematch'\n",
        "apps/place-match/uv.lock": "pinned matching lock",
        "apps/place-match/placematch/cli.py": "# committed engine",
        "experiments/sam-ibrahim-hardcoded/source/Level-1-original.svg": "<svg/>",
        "experiments/sam-ibrahim-hardcoded/project.mjs": "// committed project",
        "infra/units/snapway-pipeline.service": "# reviewed pipeline template",
        "infra/units/snapway-placematch.service": "# reviewed engine template",
        ".node-version": "24.15.0",
    }
    # Defensive exclusions cover accidental commits, beyond ignored local files.
    mobile_private = {
        "apps/pipeline/.env.prod": "private-provider-secret",
        "apps/pipeline/.local/building.json": "private draft",
        "apps/pipeline/node_modules/private.txt": "dependency install",
        "apps/place-match/data/models/model.safetensors": "weights",
        "apps/place-match/runs/private.jpg": "retained capture",
        "apps/place-match/unexpected.safetensors": "weights outside data",
        "experiments/sam-ibrahim-hardcoded/output/reference-vectors.npy": "private index",
    }
    tracked.update(mobile_tracked)
    tracked.update(mobile_private)
    for name, content in tracked.items():
        file = tmp_path / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)

    def git(*args):
        return subprocess.check_output(["git", "-C", str(tmp_path), *args], text=True).strip()

    git("init", "--quiet")
    # Exercise Windows-style archive conversion even on Linux/macOS: the
    # release must preserve committed bytes regardless of contributor config.
    git("config", "core.autocrlf", "true")
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
    (tmp_path / "apps/place-match/placematch/cli.py").write_text("uncommitted engine")
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
        [
            sys.executable,
            str(script),
            release,
            "--web",
            str(web),
            "--output",
            str(output),
            *(["--with-mobile-services"] if with_mobile_services else []),
        ],
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
        metadata = json.load(archive.extractfile("release.json"))
        assert metadata["release"] == release
        assert metadata["commit"] == commit
        if with_mobile_services:
            assert set(metadata["components"]) == {
                "api",
                "mcp",
                "web",
                "pipeline",
                "place_match",
                "sam_ibrahim",
            }
            assert metadata["components"]["place_match"]["lockfile"] == (
                "source/apps/place-match/uv.lock"
            )
            assert len(metadata["service_templates"]) == 2
            for path in mobile_tracked:
                # Compare exact committed bytes: Windows fixture files may use
                # CRLF, and git's autocrlf policy may normalize their blobs.
                committed = subprocess.check_output(
                    ["git", "-C", str(tmp_path), "show", f"HEAD:{path}"]
                )
                assert archive.extractfile("source/" + path).read() == committed
            for path in mobile_private:
                assert "source/" + path not in archive.getnames()
            for path in (
                "apps/pipeline/.local",
                "apps/pipeline/node_modules",
                "apps/place-match/data",
            ):
                assert archive.getmember("source/" + path).isdir()
        else:
            assert metadata == {"release": release, "commit": commit}
            assert not any(
                "apps/pipeline" in name or "apps/place-match" in name for name in archive.getnames()
            )
        assert all(
            ("/local/" not in name and not name.endswith(".env")) for name in archive.getnames()
        )
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    assert output.with_suffix(".gz.sha256").read_text() == f"{digest}  release.tar.gz\n"


@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        (["infra/deploy.py"], (True, True, True)),
        ([".gitattributes"], (True, True, True)),
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


@pytest.mark.parametrize("service", ["pipeline", "placematch"])
def test_optional_units_keep_credentials_private_and_services_on_loopback(service):
    root = Path(__file__).parents[2]
    template = (root / "infra" / "units" / f"snapway-{service}.service").read_text()
    assert "User=snapway" in template
    assert "EnvironmentFile=/etc/indoor-nav/api.env" in template
    assert "UnsetEnvironment=DATABASE_MIGRATOR" in template
    assert "/srv/indoor-nav/releases/@RELEASE_ID@/source/apps/" in template
    assert "/srv/indoor-nav/current" not in template
    assert "ProtectSystem=strict" in template
    if service == "placematch":
        assert "--host 127.0.0.1 --port 8790" in template
        assert "Environment=MOBILE_STORE_FRAMES=0" in template
        assert "Environment=MOBILE_ENABLE_VERTEX=0" in template
        for variable in ["OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"]:
            assert f"Environment={variable}=2" in template
        assert "--workers" not in template  # CLI's existing one-worker default.
    else:
        assert "Environment=PORT=5175" in template
        assert "Environment=UV_THREADPOOL_SIZE=2" in template
        # The launcher is pinned to a release and its existing listener binds loopback.
        assert "server/start.js prod" in template
        source = (root / "apps/pipeline/server/index.js").read_text()
        assert 'app.listen(port, "127.0.0.1"' in source


def test_optional_package_refuses_incomplete_committed_service_sources(tmp_path):
    # The flag must fail clearly before writing an archive, rather than silently
    # shipping a partial service alongside a working API/browser package.
    subprocess.run(["git", "init", "--quiet", str(tmp_path)], check=True)
    (tmp_path / "README.md").write_text("minimal committed fixture")
    subprocess.run(["git", "-C", str(tmp_path), "add", "README.md"], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(tmp_path),
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ],
        check=True,
    )
    commit = subprocess.check_output(
        ["git", "-C", str(tmp_path), "rev-parse", "HEAD"], text=True
    ).strip()
    web = tmp_path / "browser"
    web.mkdir()
    (web / "index.html").write_text("frontend")
    output = tmp_path / "release.tar.gz"
    script = Path(__file__).parents[2] / "scripts/package_release.py"
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            commit + "-1-1",
            "--web",
            str(web),
            "--output",
            str(output),
            "--with-mobile-services",
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    assert "Mobile service source must be committed" in result.stderr
    assert not output.exists()
