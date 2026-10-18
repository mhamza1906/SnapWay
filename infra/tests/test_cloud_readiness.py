"""Offline boundaries for the opt-in GitHub Actions cloud audit."""

import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[2]


def workflow():
    # BaseLoader preserves GitHub's literal `on` key and boolean input text.
    return yaml.load((ROOT / ".github/workflows/ci.yml").read_text(), Loader=yaml.BaseLoader)


def test_cloud_audit_is_explicit_independent_and_read_only():
    data = workflow()
    inputs = data["on"]["workflow_dispatch"]["inputs"]
    assert inputs["cloud_audit"]["type"] == "boolean"
    assert inputs["cloud_audit"]["default"] == "false"
    assert inputs["deploy"]["default"] == "false"
    job = data["jobs"]["cloud-readiness"]
    assert job["if"] == "github.event_name == 'workflow_dispatch' && inputs.cloud_audit == true"
    assert "needs" not in job
    assert job["timeout-minutes"] == "5"
    step = job["steps"][1]
    assert set(step["env"]) == {
        "VULTR_HOST",
        "VULTR_USER",
        "VULTR_SSH_PORT",
        "VULTR_SSH_KEY",
        "VULTR_KNOWN_HOSTS",
    }
    assert 'bash infra/cloud-readiness.sh | tee -a "$GITHUB_STEP_SUMMARY"' in step["run"]


def test_audit_keeps_existing_main_only_production_gates():
    data = workflow()
    assert data["on"]["push"]["branches"] == ["main"]
    package = " ".join(data["jobs"]["package"]["if"].split())
    assert package == (
        "always() && needs.required.result == 'success' && "
        "github.ref == 'refs/heads/main' && github.event_name != 'pull_request' && "
        "(github.event_name == 'push' || inputs.deploy) && "
        "(needs.changes.outputs.backend == 'true' || needs.changes.outputs.web == 'true')"
    )
    deploy = " ".join(data["jobs"]["deploy"]["if"].split())
    assert deploy == (
        "always() && needs.package.result == 'success' && "
        "github.ref == 'refs/heads/main' && github.event_name != 'pull_request' && "
        "vars.PRODUCTION_DEPLOY_ENABLED == 'true'"
    )


def test_cloud_audit_pins_host_keys_and_never_reads_remote_credentials_or_mutates():
    script = (ROOT / "infra/cloud-readiness.sh").read_text()
    # Feed LF bytes through stdin: no Windows drive path or text-mode CRLF
    # conversion reaches Bash, regardless of which Windows Bash is selected.
    subprocess.run(["bash", "-n"], input=script.encode("utf-8"), check=True)
    assert "umask 077" in script
    assert "StrictHostKeyChecking=yes" in script
    assert "UserKnownHostsFile=$sshdir/known_hosts" in script
    assert "set +x" in script
    assert "trap 'rm -rf" in script
    remote = script.split("<<'REMOTE'\n", 1)[1].split("\nREMOTE", 1)[0]
    assert "uname -smr" in remote
    assert "free -m" in remote
    assert "df -h / /srv/indoor-nav" in remote
    assert "systemctl list-units" in remote
    assert "--output /dev/null" in remote
    assert "--proto '=https'" in remote
    assert "/api/health/live/ /api/health/ready/ /api/maps/public/mobile-map/" in remote
    for forbidden in [
        "sudo",
        "api.env",
        "printenv",
        "environ",
        "systemctl start",
        "systemctl restart",
        "systemctl enable",
        "pip install",
        "npm install",
        "migrate",
        "Authorization:",
        "--insecure",
        "StrictHostKeyChecking=no",
        "scp ",
        "tee ",
        "mkdir ",
    ]:
        assert forbidden not in remote
