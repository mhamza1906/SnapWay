import json
import os
import subprocess
import sys

import pytest
from config.environment import ROOT


def check_production(*, command=None, **overrides):
    environment = os.environ.copy()
    environment.update(
        DJANGO_SETTINGS_MODULE="config.settings.production",
        DJANGO_SECRET_KEY="production-test-only-" + "abcdefghijklmnopqrstuvwxyz0123456789" * 2,
        DJANGO_ALLOWED_HOSTS="nav.example.com",
        DATABASE_URL="postgresql://test:test@localhost/snapway",
        STATIC_ROOT=str(ROOT / "local" / "test-static"),
        MEDIA_ROOT=str(ROOT / "local" / "test-media"),
        PGSSLMODE="verify-full",
        PGSSLROOTCERT="system",
    )
    for key, value in overrides.items():
        if value is None:
            environment.pop(key, None)
        else:
            environment[key] = value
    return subprocess.run(
        [
            sys.executable,
            "apps/api/manage.py",
            *(command or ["check", "--deploy", "--fail-level", "ERROR"]),
        ],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_production_configuration_loads_without_database_call():
    result = check_production()
    assert result.returncode == 0, result.stderr
    assert "drf_spectacular" not in result.stderr


@pytest.mark.parametrize(
    ("overrides", "expected_mode", "expected_root"),
    [
        ({"PGSSLMODE": None, "PGSSLROOTCERT": None}, "verify-full", "system"),
        (
            {"PGSSLROOTCERT": "/etc/ssl/certs/tiger-ca.pem"},
            "verify-full",
            "/etc/ssl/certs/tiger-ca.pem",
        ),
        ({"PGSSLMODE": "require", "PGSSLROOTCERT": None}, "require", None),
        (
            {
                "PGSSLMODE": "require",
                "PGSSLROOTCERT": None,
                "DATABASE_URL": "postgresql://test:test@localhost/snapway?sslmode=require",
            },
            "require",
            None,
        ),
    ],
)
def test_database_tls_options(overrides, expected_mode, expected_root):
    result = check_production(
        command=[
            "shell",
            "--no-imports",
            "-c",
            "import json; from django.conf import settings; "
            "print(json.dumps(settings.DATABASES['default']['OPTIONS']))",
        ],
        **overrides,
    )
    assert result.returncode == 0, result.stderr
    options = json.loads(result.stdout)
    assert options["sslmode"] == expected_mode
    if expected_root is None:
        assert "sslrootcert" not in options
    else:
        assert options["sslrootcert"] == expected_root


def test_demo_production_checks_pass_without_database_call():
    result = check_production(PGSSLMODE="require", PGSSLROOTCERT=None)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        ({"DJANGO_SECRET_KEY": ""}, "DJANGO_SECRET_KEY"),
        ({"DATABASE_URL": "sqlite:///:memory:"}, "PostgreSQL"),
        (
            {"DATABASE_URL": "postgresql://test:test@localhost/snapway?sslmode=require"},
            "conflicts",
        ),
        ({"PGSSLMODE": "disable"}, "verify-full"),
        ({"PGSSLMODE": "prefer"}, "verify-full"),
        ({"PGSSLMODE": "verify-ca"}, "verify-full"),
        ({"PGSSLROOTCERT": ""}, "PGSSLROOTCERT"),
        ({"PGSSLMODE": "require"}, "Remove PGSSLROOTCERT"),
        (
            {
                "PGSSLMODE": "require",
                "PGSSLROOTCERT": None,
                "DATABASE_URL": "postgresql://test:test@localhost/snapway?sslmode=verify-full",
            },
            "conflicts",
        ),
        (
            {
                "PGSSLMODE": "require",
                "PGSSLROOTCERT": None,
                "DATABASE_URL": "postgresql://test:test@localhost/snapway?sslrootcert=system",
            },
            "Remove PGSSLROOTCERT",
        ),
        (
            {
                "PGSSLMODE": "require",
                "PGSSLROOTCERT": "/etc/ssl/certs/tiger-ca.pem",
            },
            "Remove PGSSLROOTCERT",
        ),
        (
            {"DATABASE_URL": "postgresql://test:test@localhost/snapway?sslrootcert=other.pem"},
            "PGSSLROOTCERT conflicts",
        ),
    ],
)
def test_production_rejects_invalid_configuration(overrides, error):
    result = check_production(**overrides)
    assert result.returncode != 0
    assert error in result.stderr
