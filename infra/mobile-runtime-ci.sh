#!/bin/bash
# Explicit optional-runtime operation. The existing API/web deployment is separate.
set -euo pipefail
set +x
: "${VULTR_HOST:?Missing configured host}"
: "${VULTR_USER:?Missing configured user}"
: "${VULTR_SSH_PORT:?Missing configured port}"
: "${VULTR_SSH_KEY:?Missing configured SSH identity}"
: "${VULTR_KNOWN_HOSTS:?Missing pinned host keys}"
[[ "$VULTR_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]
[[ "$VULTR_USER" = snapwaydeploy ]]
[[ "$VULTR_SSH_PORT" =~ ^[0-9]+$ ]]
((10#$VULTR_SSH_PORT > 0 && 10#$VULTR_SSH_PORT < 65536))
[[ "${MOBILE_RUNTIME_ACTION:-}" = probe || "${MOBILE_RUNTIME_ACTION:-}" = prepare ]] || { echo 'Choose probe or prepare'; exit 2; }
umask 077
runtime_sshdir=$(mktemp -d)
trap 'rm -rf -- "$runtime_sshdir"' EXIT
printf '%s\n' "$VULTR_SSH_KEY" | tr -d '\r' > "$runtime_sshdir/key"
printf '%s\n' "$VULTR_KNOWN_HOSTS" | tr -d '\r' > "$runtime_sshdir/known_hosts"
options=(-i "$runtime_sshdir/key" -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$runtime_sshdir/known_hosts"
    -o ConnectTimeout=15 -o ConnectionAttempts=1 -o ServerAliveInterval=15
    -o ServerAliveCountMax=2)
if [[ "$MOBILE_RUNTIME_ACTION" = prepare ]]; then
    runtime_commit=$(git rev-parse HEAD)
    [[ "$runtime_commit" =~ ^[0-9a-f]{40}$ ]]
    [[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
    runtime_release="$runtime_commit-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
    # Only committed, filtered source travels to the server; no env/model/local data.
    python3 - "$runtime_sshdir/source.tar.gz" <<'PACKAGE'
import io
import subprocess
import sys
import tarfile
sys.path.insert(0, ".")
from scripts.package_release import mobile_runtime_artifact
paths = ["apps/pipeline", "apps/place-match", "experiments/sam-ibrahim-hardcoded",
         ".node-version", ".python-version", ".env.example", "scripts/env_contract.py",
         "infra/units", "infra/prepare-mobile-runtime.sh", "infra/install-mobile-services.sh"]
source = subprocess.check_output(["git", "-c", "core.autocrlf=false", "archive",
                                  "--format=tar", "--prefix=source/", "HEAD", *paths])
with tarfile.open(fileobj=io.BytesIO(source)) as src, tarfile.open(sys.argv[1], "w:gz") as out:
    for item in src:
        if mobile_runtime_artifact(item.name):
            continue
        if not item.isfile() and not item.isdir():
            raise ValueError("Runtime source must contain only regular files/directories")
        out.addfile(item, src.extractfile(item) if item.isfile() else None)
print("Committed runtime source packaged; credentials, models and local state excluded.")
PACKAGE
    if ! ssh "${options[@]}" -p "$VULTR_SSH_PORT" "$VULTR_USER@$VULTR_HOST" \
        "umask 022; test ! -e /srv/indoor-nav/incoming/$runtime_release && mkdir /srv/indoor-nav/incoming/$runtime_release && tar --extract --gzip --no-same-owner --file=- --directory=/srv/indoor-nav/incoming/$runtime_release" \
        < "$runtime_sshdir/source.tar.gz" 2> "$runtime_sshdir/ssh-error"; then
        echo 'Runtime source transfer failed; remote diagnostics suppressed.'; exit 1
    fi
    if ! ssh "${options[@]}" -p "$VULTR_SSH_PORT" "$VULTR_USER@$VULTR_HOST" \
        "bash /srv/indoor-nav/incoming/$runtime_release/source/infra/prepare-mobile-runtime.sh $runtime_release" \
        2> "$runtime_sshdir/ssh-error"; then
        echo "Runtime preparation failed for $runtime_release; no system services were activated."; exit 1
    fi
    printf 'Prepared release: %s\n' "$runtime_release"
    printf '%s\n' 'Administrator activation remains separate; API/web and protected settings were not changed.'
    exit 0
fi
if ! ssh "${options[@]}" -p "$VULTR_SSH_PORT" "$VULTR_USER@$VULTR_HOST" 'bash -s' \
    2> "$runtime_sshdir/ssh-error" <<'REMOTE'
set -euo pipefail
printf '%s\n' 'Runtime installation capability probe (no server changes)'
printf 'Identity: '; id -un
if sudo -n true >/dev/null 2>&1; then
    printf '%s\n' 'Administrator setup permission: available'
else
    printf '%s\n' 'Administrator setup permission: unavailable'
fi
for path in /srv/indoor-nav/incoming /srv/indoor-nav/venvs /srv/indoor-nav/python /srv/indoor-nav/releases /srv/indoor-nav/shared /etc/systemd/system /etc/indoor-nav/api.env; do
    if test -w "$path"; then printf 'Writable %s: yes\n' "$path"; else printf 'Writable %s: no\n' "$path"; fi
done
for command in uv tar curl xz systemd-analyze git; do
    if command -v "$command" >/dev/null; then printf 'Executable %s: yes\n' "$command"; else printf 'Executable %s: no\n' "$command"; fi
done
printf 'Available MiB: '; awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo
printf 'Free disk MiB: '; df -Pm /srv/indoor-nav | awk 'NR==2{print $4}'
if ldconfig -p 2>/dev/null | grep -q 'libGL.so.1'; then printf '%s\n' 'OpenCV libGL: available'; else printf '%s\n' 'OpenCV libGL: unavailable'; fi
printf '%s\n' 'No environment values, service settings or data were read or changed.'
REMOTE
then
    printf '%s\n' 'Runtime capability probe failed; remote diagnostics suppressed.'
    exit 1
fi
