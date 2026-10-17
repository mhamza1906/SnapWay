"""Exercise promotion failures without connecting to a server or database."""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

SPEC = importlib.util.spec_from_file_location(
    "snapway_deploy", Path(__file__).parents[1] / "deploy.py"
)
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)
DJANGO_LAUNCHER = deploy.django

OLD = "a" * 40 + "-1-1"
NEW = "b" * 40 + "-2-1"


@pytest.fixture
def host(tmp_path, monkeypatch):
    root = tmp_path / "srv"
    config = tmp_path / "config"
    config.mkdir()
    (config / "domain").write_text("snapway.work")
    (config / "api.env").write_text("private")
    caddy = tmp_path / "Caddyfile"
    caddy.write_text("previous configuration")
    monkeypatch.setattr(deploy, "ROOT", root)
    monkeypatch.setattr(deploy, "CONFIG", config)
    monkeypatch.setattr(deploy, "CADDY", caddy)
    release = root / "releases" / NEW
    (release / "source").mkdir(parents=True)
    (release / "source/app.py").write_text("new backend")
    (release / "web").mkdir()
    (release / "web/index.html").write_text("new frontend")
    (release / "web/main-HASH1234.js").write_text("new chunk")
    (release / "release.json").write_text(json.dumps({"release": NEW, "commit": "b" * 40}))
    key = "c" * 64
    (root / "venvs" / key).mkdir(parents=True)
    (root / "venvs" / key / ".complete").touch()
    (root / "shared/static").mkdir(parents=True)
    (root / "shared/web-assets").mkdir()
    old = {
        "release": OLD,
        "backend_release": OLD,
        "web_release": OLD,
        "backend_hash": "old backend",
        "web_hash": "old frontend",
        "slot": "blue",
        "port": 8101,
        "venv": key,
    }
    (config / "active.json").write_text(json.dumps(old))
    monkeypatch.setattr(deploy, "receive_release", lambda _: release)
    monkeypatch.setattr(deploy, "dependency_key", lambda _: key)
    monkeypatch.setattr(deploy.shutil, "chown", lambda *a, **kw: None)
    # Filesystem ownership is checked separately; these tests run on Windows too.
    for name in ("run", "django", "start_api", "probe", "select_current", "require_secret_file"):
        monkeypatch.setattr(deploy, name, Mock())
    return root, config, caddy, old, release


def assert_previous_survives(host):
    _, config, caddy, old, _ = host
    assert caddy.read_text() == "previous configuration"
    assert json.loads((config / "active.json").read_text()) == old
    assert not any("snapway-api-blue.service" in call.args for call in deploy.run.call_args_list)


def test_failed_migration_does_not_start_candidate_or_switch(host):
    def command(state, args, **kwargs):
        if args[0] == "migrate":
            raise RuntimeError("Migration failed")

    deploy.django.side_effect = command
    with pytest.raises(RuntimeError, match="Migration failed"):
        deploy.activate(NEW)
    deploy.start_api.assert_not_called()
    assert_previous_survives(host)


def test_failed_private_health_preserves_live_release(host):
    deploy.probe.side_effect = RuntimeError("Candidate unhealthy")
    with pytest.raises(RuntimeError, match="Candidate unhealthy"):
        deploy.activate(NEW)
    assert_previous_survives(host)
    deploy.run.assert_any_call("systemctl", "disable", "--now", "snapway-api-green.service")


def test_failed_public_health_restores_caddy_and_preserves_state(host):
    deploy.probe.side_effect = [None, RuntimeError("Public verification failed")]
    with pytest.raises(RuntimeError, match="Public verification failed"):
        deploy.activate(NEW)
    assert_previous_survives(host)
    deploy.run.assert_any_call("systemctl", "reload", "caddy")


def test_success_selects_candidate_then_drains_previous_slot(host):
    root, config, caddy, old, release = host
    deploy.activate(NEW)
    state = json.loads((config / "active.json").read_text())
    assert state["backend_release"] == NEW
    assert state["slot"] == "green" and state["port"] == 8102
    assert json.loads((config / "previous.json").read_text()) == old
    assert "127.0.0.1:8102" in caddy.read_text()
    assert (root / "shared/web-assets/main-HASH1234.js").is_file()
    deploy.select_current.assert_called_once_with(release)
    deploy.run.assert_any_call("systemctl", "disable", "--now", "snapway-api-blue.service")


def test_web_only_release_reuses_api_and_skips_dependencies_and_migrations(host):
    _, config, _, old, release = host
    old["backend_hash"] = deploy.tree_digest(release / "source")
    (config / "active.json").write_text(json.dumps(old))
    deploy.activate(NEW)
    state = json.loads((config / "active.json").read_text())
    assert state["backend_release"] == OLD and state["web_release"] == NEW
    deploy.django.assert_not_called()
    deploy.start_api.assert_not_called()
    assert not any("disable" in call.args for call in deploy.run.call_args_list)


def test_rollback_never_runs_migrations(host):
    deploy.activate(NEW, rollback=True)
    assert all(call.args[1][0] != "migrate" for call in deploy.django.call_args_list)


@pytest.mark.parametrize("value", ["../etc", "a" * 40, NEW + ";id", "-" + NEW])
def test_invalid_release_ids_are_rejected(value):
    with pytest.raises(ValueError):
        deploy.release_path(value)


def test_documentation_and_bytecode_do_not_restart_backend(tmp_path):
    (tmp_path / "app.py").write_text("application")
    before = deploy.tree_digest(tmp_path)
    (tmp_path / "README.md").write_text("changed documentation")
    (tmp_path / "app.pyc").write_bytes(b"bytecode")
    assert deploy.tree_digest(tmp_path) == before


@pytest.mark.parametrize(("owner", "mode"), [(1000, 0o100600), (0, 0o100640), (0, 0o100604)])
def test_environment_files_reject_nonroot_ownership_or_shared_access(owner, mode):
    file = Mock()
    file.is_file.return_value = True
    file.stat.return_value = Mock(st_uid=owner, st_mode=mode)
    with pytest.raises(ValueError, match="owned by root"):
        deploy.require_secret_file(file)


@pytest.mark.parametrize("connection", ["postgresql://migrator@host/database", ""])
def test_migration_entrypoint_selects_migrator_or_fails_before_django(tmp_path, connection):
    api = tmp_path / "apps/api"
    api.mkdir(parents=True)
    (api / "manage.py").write_text(
        "import json, os, sys\n"
        "print(json.dumps({'connection': os.environ['DATABASE_URL'], "
        "'migration_visible': 'DATABASE_MIGRATOR' in os.environ, 'args': sys.argv[1:]}))\n"
    )
    environment = dict(
        os.environ, DATABASE_URL="postgresql://runtime@host/database", DATABASE_MIGRATOR=connection
    )
    result = subprocess.run(
        [sys.executable, "-c", deploy.MIGRATION_ENTRYPOINT, "migrate", "--noinput"],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if connection:
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == {
            "connection": connection,
            "migration_visible": False,
            "args": ["migrate", "--noinput"],
        }
    else:
        assert result.returncode != 0
        assert "DATABASE_MIGRATOR must be configured" in result.stderr
        assert not result.stdout


def test_api_and_management_commands_use_one_file_and_hide_migrator(host):
    _, config, _, state, _ = host
    # Exercise the real launcher rather than the promotion fixture's command stub.
    runner = deploy.run
    DJANGO_LAUNCHER(state, ["check"])
    assert f"--property=EnvironmentFile={config / 'api.env'}" in runner.call_args.args
    assert "--property=UnsetEnvironment=DATABASE_MIGRATOR" in runner.call_args.args
    DJANGO_LAUNCHER(state, ["migrate", "--noinput"], migration=True)
    assert f"--property=EnvironmentFile={config / 'api.env'}" in runner.call_args.args
    assert deploy.MIGRATION_ENTRYPOINT in runner.call_args.args
    assert "--property=UnsetEnvironment=DATABASE_MIGRATOR" not in runner.call_args.args
    assert "UnsetEnvironment=DATABASE_MIGRATOR" in deploy.api_unit(state)
