#!/bin/bash
# Read-only audit via the existing GitHub Actions SSH identity. No deployment.
set -euo pipefail
# Never trace credential handling, including inherited shell tracing.
set +x
: "${VULTR_HOST:?Missing configured host}"
: "${VULTR_USER:?Missing configured user}"
: "${VULTR_SSH_PORT:?Missing configured port}"
: "${VULTR_SSH_KEY:?Missing configured SSH identity}"
: "${VULTR_KNOWN_HOSTS:?Missing pinned SSH host keys}"
[[ "$VULTR_SSH_PORT" =~ ^[0-9]+$ ]]
((10#$VULTR_SSH_PORT > 0 && 10#$VULTR_SSH_PORT < 65536))
[[ "$VULTR_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]
[[ "$VULTR_USER" = snapwaydeploy ]]
umask 077
sshdir=$(mktemp -d)
trap 'rm -rf -- "$sshdir"' EXIT
printf '%s\n' "$VULTR_SSH_KEY" | tr -d '\r' > "$sshdir/key"
printf '%s\n' "$VULTR_KNOWN_HOSTS" | tr -d '\r' > "$sshdir/known_hosts"
options=(-i "$sshdir/key" -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$sshdir/known_hosts"
    -o ConnectTimeout=15 -o ConnectionAttempts=1 -o ServerAliveInterval=15
    -o ServerAliveCountMax=2)
printf '%s\n' '## Read-only cloud readiness' ''
# Keep raw SSH diagnostics private: they can include configured connection details.
# Only the fixed script below reaches the host; no env files or response bodies.
if ssh "${options[@]}" -p "$VULTR_SSH_PORT" "$VULTR_USER@$VULTR_HOST" \
    'bash -s' 2> "$sshdir/ssh-error" <<'REMOTE'
set -uo pipefail
printf '%s\n' 'SSH authentication: passed' '' '```text' 'Operating system / CPU:'
uname -smr
if command -v nproc >/dev/null 2>&1; then printf 'Available CPU threads: '; nproc; fi
printf '\nMemory (MiB):\n'
if command -v free >/dev/null 2>&1; then free -m; else printf '%s\n' 'unavailable'; fi
printf '\nDisk capacity:\n'
df -h / /srv/indoor-nav 2>/dev/null || printf '%s\n' 'capacity query unavailable'
printf '\nSnapWay services (unit / active / substate):\n'
if command -v systemctl >/dev/null 2>&1; then
    systemctl list-units --type=service --all --plain --no-pager --no-legend 'snapway-*' \
        2>/dev/null | awk '{print $1, $3, $4}' || printf '%s\n' 'unit query unavailable'
    printf '\nOptional service state and exit codes only:\n'
    for unit in snapway-pipeline.service snapway-placematch.service; do
        printf '%s\n' "$unit"
        systemctl show "$unit" --no-pager \
            --property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus \
            2>/dev/null || printf '%s\n' 'status unavailable'
    done
else
    printf '%s\n' 'systemd unavailable'
fi
printf '\nExisting executables:\n'
for executable in node python3 uv caddy; do
    if command -v "$executable" >/dev/null 2>&1; then
        printf '%s: present\n' "$executable"
    else
        printf '%s: absent from service identity PATH\n' "$executable"
    fi
done
printf '\nPrivate HTTP status (no authorization, no body):\n'
if command -v curl >/dev/null 2>&1; then
    for endpoint in http://127.0.0.1:5175/api/health http://127.0.0.1:8790/v1/health; do
        status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
            --proto '=http' --connect-timeout 3 --max-time 10 "$endpoint" 2>/dev/null) || status=unreachable
        printf '%s %s\n' "$endpoint" "$status"
    done
    printf '\nPublic HTTPS status (no authorization, no body):\n'
    for path in /api/health/live/ /api/health/ready/ /api/maps/public/mobile-map/; do
        status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
            --proto '=https' --connect-timeout 3 --max-time 10 "https://snapway.work$path" 2>/dev/null) || status=unreachable
        printf '%s %s\n' "$path" "$status"
    done
else
    printf '%s\n' 'curl unavailable; HTTP probes skipped'
fi
printf '\nRead-only Sam Ibrahim compute probes (no provider/model calls):\n'
python3 - <<'PROBE'
import json
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError, URLError
file = Path("/srv/indoor-nav/current/source/apps/api/maps/data/sam-ibrahim.json")
print("API bundled project:", "present" if file.is_file() else "missing")
if file.is_file():
    project = json.loads(file.read_text())
    opener = build_opener(ProxyHandler({}))
    for operation, floor in (("summary", None), ("render", "LB"), ("render", "L1")):
        body = {"building": project}
        if floor:
            body["floorId"] = floor
        req = Request("http://127.0.0.1:5175/api/authoring/" + operation,
            data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        try:
            with opener.open(req, timeout=20) as response:
                data = json.load(response)
                print(operation, floor or "all floors", response.status,
                    "floors=" + str(len(data.get("floors", []))) if not floor else
                    "svg=" + str("<svg" in data.get("svg", "")))
        except HTTPError as error:
            text = error.read(8192).decode(errors="replace")
            kind = "missing-source" if "ENOENT" in text else "schema" if "Zod" in text else "compute-error"
            print(operation, floor or "all floors", error.code, kind)
        except (URLError, TimeoutError, ValueError):
            print(operation, floor or "all floors", "unavailable")
PROBE
printf '%s\n' '```' '' 'Audit complete. This does not activate services, validate model accuracy, or confirm mobile map rendering.'
REMOTE
then
    printf '%s\n' '' 'No remote configuration or application data was changed.'
else
    printf '%s\n' '' 'SSH audit could not complete with the configured CI identity and pinned host keys.'
    exit 1
fi
