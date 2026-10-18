"""Static/offline operator boundaries; never installs systemd units in tests."""

import re
import subprocess
from pathlib import Path

from infra.tests.test_cloud_readiness import syntax_bash

ROOT = Path(__file__).parents[2]


def test_operator_installer_requires_root_and_preserves_existing_production_services():
    script = (ROOT / "infra/install-mobile-services.sh").read_text()
    subprocess.run([syntax_bash(), "-n"], input=script.encode(), check=True)
    assert "[[ $(id -u) == 0 ]]" in script
    assert "snapway-pipeline.service snapway-placematch.service" in script
    assert "systemd-analyze verify" in script
    assert "trap rollback ERR" in script
    assert 'systemctl stop "${units[@]}"' in script
    assert 'systemctl enable "${units[@]}"' in script
    assert ".was-active" in script and ".was-enabled" in script
    assert 'if ! cmp -s "$stage/$unit"' in script
    assert '"$backup/$unit.changed"' in script
    for forbidden in ["snapway-activate", "snapway-api-", "/etc/caddy", "/etc/sudoers", "migrate"]:
        assert forbidden not in script
    assert "stat -c '%u:%a' /etc/indoor-nav/api.env" in script
    assert "source /etc/indoor-nav/api.env" not in script
    assert 'values.get("PLACEMATCH_ENGINE_TOKEN"' in script
    assert 'values["PLACEMATCH_ENGINE_TOKEN"] =' not in script


def test_installer_stages_as_unprivileged_then_freezes_and_pins_prepared_runtime():
    script = (ROOT / "infra/install-mobile-services.sh").read_text()
    assert "runuser -u snapwaydeploy -- cp -R --no-dereference --no-preserve=ownership" in script
    assert "os.walk(root, followlinks=False)" in script
    assert "stat.S_ISDIR(mode) or stat.S_ISREG(mode)" in script
    assert 'runtime="$root/venvs/mobile-$commit"' in script
    assert '"$node" == "$runtime/node/bin/node"' in script
    assert '"$venv" == "$runtime/placematch"' in script
    assert "for code in node pipeline placematch;" in script
    assert 'chown -R root:root "$runtime/$code"' in script
    assert 'chown -R root:root "$runtime"' not in script  # Existing private catalog stays writable.
    assert 'runuser -u snapway -- "$node"' in script
    assert '"$source/$destination"' in script
    assert ".mobile-source-complete" in script


def test_service_exec_enforces_bounds_after_shared_environment_file():
    pipeline = (ROOT / "infra/units/snapway-pipeline.service").read_text()
    engine = (ROOT / "infra/units/snapway-placematch.service").read_text()
    for text in [pipeline, engine]:
        assert "EnvironmentFile=/etc/indoor-nav/api.env" in text
        assert "ExecStart=/usr/bin/env " in text
        assert "UnsetEnvironment=DATABASE_MIGRATOR" in text
    command = next(line for line in pipeline.splitlines() if line.startswith("ExecStart="))
    assert "APP_ENV=prod PORT=5175 UV_THREADPOOL_SIZE=2 OMP_NUM_THREADS=2 @NODE_BINARY@" in command
    command = next(line for line in engine.splitlines() if line.startswith("ExecStart="))
    for setting in [
        "OMP_NUM_THREADS=2",
        "MKL_NUM_THREADS=2",
        "OPENBLAS_NUM_THREADS=2",
        "NUMEXPR_NUM_THREADS=2",
        "MOBILE_STORE_FRAMES=0",
        "MOBILE_ENABLE_VERTEX=0",
        "CUDA_VISIBLE_DEVICES=",
    ]:
        assert setting in command
    assert "@PLACEMATCH_VENV@/bin/python" in command
    assert "--host 127.0.0.1 --port 8790" in command


def test_embedded_operator_helpers_compile_without_executing_privileged_actions():
    script = (ROOT / "infra/install-mobile-services.sh").read_text()
    helpers = list(re.finditer(r"<<'([A-Z]+)'\n(.*?)\n\1\n", script, re.DOTALL))
    assert len(helpers) == 4
    for helper in helpers:
        compile(helper.group(2), f"installer-{helper.group(1)}", "exec")
    assert 'install -d -m 755 "$source/$destination"' in script
