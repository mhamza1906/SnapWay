"""Exercise env drift and lossless migration with synthetic private values only."""

import subprocess
import sys

import pytest

from scripts import env_contract as contract


def test_public_template_has_no_private_values():
    defaults, tags = contract.contract(contract.TEMPLATE)
    assert all(defaults[key] == "" for key in tags["secret"])
    assert not contract.problems(
        defaults | {"DJANGO_SECRET_KEY": "isolated-test-value"}, defaults, tags, "local"
    )


def test_schema_and_common_setting_drift_are_rejected():
    defaults, tags = contract.contract(contract.TEMPLATE)
    values = defaults | {
        "DJANGO_SECRET_KEY": "isolated-test-value",
        "ENV_SCHEMA_VERSION": "old",
        "VERTEX_MODEL": "different",
        "UNEXPECTED_KEY": "must-not-be-logged",
    }
    values.pop("OPENAI_API_KEY")
    errors = "; ".join(contract.problems(values, defaults, tags, "local"))
    for key in ("ENV_SCHEMA_VERSION", "VERTEX_MODEL", "OPENAI_API_KEY", "UNEXPECTED_KEY"):
        assert key in errors
    assert "must-not-be-logged" not in errors


def test_local_template_is_rejected_for_production():
    defaults, tags = contract.contract(contract.TEMPLATE)
    errors = contract.problems(defaults, defaults, tags, "production")
    assert errors
    values = defaults | {
        "DJANGO_SETTINGS_MODULE": "config.settings.production",
        "DJANGO_SECRET_KEY": "synthetic-production-secret-" * 3,
        "DJANGO_DEBUG": "false",
        "DJANGO_TRUST_PROXY": "true",
        "CSRF_TRUSTED_ORIGINS": "https://snapway.work,https://www.snapway.work",
        "DJANGO_ALLOWED_HOSTS": "snapway.work,www.snapway.work",
        "DATABASE_URL": "postgresql://runtime:fixture@localhost/demo",
        "DATABASE_MIGRATOR": "postgresql://migrator:fixture@localhost/demo",
        "MEDIA_ROOT": "/srv/indoor-nav/shared/media",
        "PGSSLMODE": "require",
        "PGSSLROOTCERT": "",
    }
    assert not contract.problems(values, defaults, tags, "production")


@pytest.mark.parametrize("line", ["KEY=a\nKEY=b", "KEY='secret'", "KEY=${SECRET}", "not-env"])
def test_invalid_input_never_prints_values(tmp_path, line):
    private = tmp_path / "private.env"
    private.write_text(line)
    result = subprocess.run(
        [
            sys.executable,
            str(contract.ROOT / "scripts/env_contract.py"),
            "check",
            "--file",
            str(private),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "secret" not in result.stdout
    assert "${SECRET}" not in result.stdout
    assert not result.stderr


def test_initialize_preserves_existing_file(tmp_path):
    private = tmp_path / "private.env"
    contract.initialize(destination=private)
    before = private.read_bytes()
    contract.initialize(destination=private)
    assert private.read_bytes() == before
    assert len(contract.read_values(private)["DJANGO_SECRET_KEY"]) >= 50


def test_migration_verifies_then_removes_legacy_files(tmp_path, monkeypatch):
    old_api, old_node, private = (tmp_path / name for name in ("api.env", "node.env", ".env"))
    old_api.write_text("DJANGO_SECRET_KEY=keep-django\nOPENAI_API_KEY=keep-openai\n")
    old_node.write_text("VERTEX_API_KEY=keep-vertex\nVERTEX_PROJECT=keep-project\n")
    monkeypatch.setattr(contract, "PRIVATE", private)
    monkeypatch.setattr(contract, "LEGACY", (old_api, old_node))
    contract.migrate()
    values = contract.read_values(private)
    assert values["DJANGO_SECRET_KEY"] == "keep-django"
    assert values["OPENAI_API_KEY"] == "keep-openai"
    assert values["VERTEX_API_KEY"] == "keep-vertex"
    assert values["VERTEX_PROJECT"] == "keep-project"
    assert not old_api.exists() and not old_node.exists()


def test_migration_conflict_leaves_every_source_unchanged(tmp_path, monkeypatch):
    first, second, private = (tmp_path / name for name in ("a.env", "b.env", ".env"))
    first.write_text("OPENAI_API_KEY=first-private-value\n")
    second.write_text("OPENAI_API_KEY=second-private-value\n")
    monkeypatch.setattr(contract, "PRIVATE", private)
    monkeypatch.setattr(contract, "LEGACY", (first, second))
    with pytest.raises(contract.ContractError) as error:
        contract.migrate()
    assert "OPENAI_API_KEY" in str(error.value)
    assert "private-value" not in str(error.value)
    assert first.exists() and second.exists() and not private.exists()


def test_reference_comparison_detects_secret_rotation_without_disclosure(tmp_path):
    first, second = tmp_path / "first.env", tmp_path / "second.env"
    defaults, _ = contract.contract(contract.TEMPLATE)
    values = defaults | {"DJANGO_SECRET_KEY": "fixture", "OPENAI_API_KEY": "before-private"}
    contract.write_private(first, contract.TEMPLATE, values)
    contract.write_private(second, contract.TEMPLATE, values | {"OPENAI_API_KEY": "after-private"})
    result = subprocess.run(
        [
            sys.executable,
            str(contract.ROOT / "scripts/env_contract.py"),
            "check",
            "--file",
            str(first),
            "--reference",
            str(second),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "Reference differs: OPENAI_API_KEY" in result.stdout
    assert "before-private" not in result.stdout and "after-private" not in result.stdout


def test_legacy_engine_token_migrates_to_canonical_shared_key(tmp_path, monkeypatch):
    legacy, private = tmp_path / "engine.env", tmp_path / ".env"
    legacy.write_text("MOBILE_API_TOKEN=synthetic-legacy-token\n")
    monkeypatch.setattr(contract, "PRIVATE", private)
    monkeypatch.setattr(contract, "LEGACY", (legacy,))
    contract.migrate()
    values = contract.read_values(private)
    assert values["PLACEMATCH_ENGINE_TOKEN"] == "synthetic-legacy-token"
    assert "MOBILE_API_TOKEN" not in values
    assert not legacy.exists()


def test_google_scaffold_migration_preserves_credentials(tmp_path, monkeypatch):
    legacy, private = tmp_path / "web.env", tmp_path / ".env"
    legacy.write_text(
        "PUBLIC_GOOGLE_OAUTH_CLIENT_ID=synthetic-client\n"
        "PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY=synthetic-browser-key\n"
        "GOOGLE_MAPS_MAP_ID=DEMO_MAP_ID\n"
        "GOOGLE_OAUTH_SCOPES=openid,email,profile\n"
        "GOOGLE_OAUTH_CALLBACK_URL=\n"
        "GOOGLE_CLOUD_PROJECT_ID=\n"
        "PUBLIC_APP_ORIGIN=http://localhost:4200\n"
    )
    monkeypatch.setattr(contract, "PRIVATE", private)
    monkeypatch.setattr(contract, "LEGACY", (legacy,))
    contract.migrate()
    values = contract.read_values(private)
    assert values["GOOGLE_OAUTH_CLIENT_ID"] == "synthetic-client"
    assert values["PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY"] == "synthetic-browser-key"
    assert not legacy.exists()


def test_custom_retired_oauth_settings_need_review(tmp_path, monkeypatch):
    legacy, private = tmp_path / "google.env", tmp_path / ".env"
    legacy.write_text("GOOGLE_OAUTH_CALLBACK_URL=https://custom.invalid/callback\n")
    monkeypatch.setattr(contract, "PRIVATE", private)
    monkeypatch.setattr(contract, "LEGACY", (legacy,))
    with pytest.raises(contract.ContractError, match="GOOGLE_OAUTH_CALLBACK_URL"):
        contract.migrate()
    assert legacy.exists() and not private.exists()
