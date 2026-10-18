"""Runtime preparation rejects unsafe identifiers before any host mutation."""

import subprocess
from pathlib import Path

import pytest

from infra.tests.test_cloud_readiness import syntax_bash

SCRIPT = Path(__file__).resolve().parents[1] / "prepare-mobile-runtime.sh"


@pytest.mark.parametrize(
    "arguments",
    [
        [],
        ["../etc/passwd"],
        ["A" * 40 + "-1-1"],
        ["a" * 40 + "-1-1/../../other"],
        ["a" * 40 + "-1-1;touch /tmp/unsafe"],
        ["a" * 40 + "-1-1", "--start"],
        ["a" * 40 + "-1-1", "--check-only", "extra"],
    ],
)
def test_rejects_unsafe_runtime_arguments(arguments):
    result = subprocess.run(
        [syntax_bash(), "-s", "--", *arguments],
        input=SCRIPT.read_text(encoding="utf-8").encode("utf-8"),
        capture_output=True,
    )
    assert result.returncode == 2
    assert "Usage:" in result.stderr.decode("utf-8")
    assert not result.stdout


def test_script_has_valid_bash_syntax():
    result = subprocess.run(
        [syntax_bash(), "-n"],
        input=SCRIPT.read_text(encoding="utf-8").encode("utf-8"),
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8")
