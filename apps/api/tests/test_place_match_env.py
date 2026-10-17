"""Protect the merged engine's single-env boundary without loading model weights."""

import importlib
from argparse import Namespace

from config.environment import ROOT

from scripts.env_contract import TEMPLATE, contract, read_values, write_private


def engine_modules(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "apps/place-match"))
    return importlib.import_module("placematch.env"), importlib.import_module("placematch.cli")


def test_engine_resolves_shared_file_and_preserves_process_overrides(tmp_path, monkeypatch):
    environment, _ = engine_modules(monkeypatch)
    assert environment.PRIVATE_ENV == ROOT / "local/.env"
    private = tmp_path / ".env"
    private.write_text(
        "PLACEMATCH_ENGINE_TOKEN=fixture-file-token\nMOBILE_REFERENCE_SET=fixture\n"
        "DJANGO_SECRET_KEY=must-not-load\n"
    )
    monkeypatch.setattr(environment, "PRIVATE_ENV", private)
    monkeypatch.setenv("PLACEMATCH_ENGINE_TOKEN", "fixture-process-token")
    monkeypatch.delenv("MOBILE_REFERENCE_SET", raising=False)
    monkeypatch.delenv("DJANGO_SECRET_KEY", raising=False)
    environment.load_env()
    import os

    assert os.environ["PLACEMATCH_ENGINE_TOKEN"] == "fixture-process-token"
    assert os.environ["MOBILE_REFERENCE_SET"] == "fixture"
    assert "DJANGO_SECRET_KEY" not in os.environ


def test_token_rotation_preserves_contract_and_never_prints_value(tmp_path, monkeypatch, capsys):
    environment, cli = engine_modules(monkeypatch)
    private = tmp_path / ".env"
    defaults, _ = contract(TEMPLATE)
    original = defaults | {"DJANGO_SECRET_KEY": "fixture-key", "OPENAI_API_KEY": "keep-fixture-key"}
    write_private(private, TEMPLATE, original)
    monkeypatch.setattr(environment, "PRIVATE_ENV", private)
    monkeypatch.delenv("MOBILE_API_TOKEN", raising=False)
    monkeypatch.delenv("PLACEMATCH_ENGINE_TOKEN", raising=False)
    cli.cmd_mobile_token(Namespace(create=True))
    current = read_values(private)
    assert len(current["PLACEMATCH_ENGINE_TOKEN"]) >= 24
    assert current["PLACEMATCH_ENGINE_TOKEN"] not in capsys.readouterr().out
    assert current.keys() == original.keys()
    assert all(current[k] == original[k] for k in original if k != "PLACEMATCH_ENGINE_TOKEN")


def test_engine_telemetry_has_real_peak_memory_and_unavailable_fallback(monkeypatch):
    engine_modules(monkeypatch)
    telemetry = importlib.import_module("placematch.ops.telemetry")
    assert telemetry.peak_rss_mb() > 0
    monkeypatch.setattr(telemetry, "resource", None)
    monkeypatch.setattr(telemetry, "_windows_memory_mb", lambda: None)
    assert telemetry.peak_rss_mb() is None
    assert telemetry.hardware()["os"]


def test_bad_photo_is_reported_before_model_dependencies_are_loaded(tmp_path, monkeypatch):
    engine_modules(monkeypatch)
    verification = importlib.import_module("placematch.verify")
    corrupt = tmp_path / "invalid.jpg"
    corrupt.write_bytes(b"not-an-image")

    def unexpected_models(*args, **kwargs):
        raise AssertionError("Corrupt input must not load model weights")

    monkeypatch.setattr(verification, "load_models", unexpected_models)
    result = verification.verify_pair(corrupt, corrupt)
    assert result.status == "error"
    assert str(corrupt) in result.message
