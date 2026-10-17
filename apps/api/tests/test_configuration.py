import os
import subprocess
import sys

import pytest
from config.environment import ROOT


def check_production(**overrides):
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
    environment.update(overrides)
    return subprocess.run(
        [sys.executable, "apps/api/manage.py", "check", "--deploy", "--fail-level", "ERROR"],
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
    ("overrides", "error"),
    [
        ({"DJANGO_SECRET_KEY": ""}, "DJANGO_SECRET_KEY"),
        ({"DATABASE_URL": "sqlite:///:memory:"}, "PostgreSQL"),
        (
            {"DATABASE_URL": "postgresql://test:test@localhost/snapway?sslmode=require"},
            "verify-full",
        ),
        ({"PGSSLMODE": "disable"}, "verify-full"),
    ],
)
def test_production_rejects_invalid_configuration(overrides, error):
    result = check_production(**overrides)
    assert result.returncode != 0
    assert error in result.stderr
