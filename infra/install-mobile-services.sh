#!/bin/bash
# Reviewed operator entry point, run as root. Never grant an uploader sudo to it.
# Installs only private optional services; does not activate an API/web release.
set -Eeuo pipefail
set +x
usage() {
    printf '%s\n' 'Usage: bash infra/install-mobile-services.sh [--stage] RELEASE_ID ABS_NODE_BINARY ABS_PLACEMATCH_VENV'
}
if [[ ${1:-} == --help ]]; then usage; exit 0; fi
[[ $(id -u) == 0 ]] || { printf '%s\n' 'An authorized root operator is required.' >&2; exit 1; }
stage_source=false
if [[ ${1:-} == --stage ]]; then stage_source=true; shift; fi
[[ $# == 3 ]] || { usage >&2; exit 1; }
umask 077
release=$1
node=$2
venv=$3
[[ "$release" =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]]
# Values become systemd command paths; refuse whitespace, expansions and specifiers.
for runtime_path in "$node" "$venv"; do
    [[ "$runtime_path" =~ ^/(srv/indoor-nav|usr/local|opt)/[a-zA-Z0-9_./-]+$ ]]
    [[ "$runtime_path" != *'/../'* && "$runtime_path" != */.. ]]
done
root=/srv/indoor-nav
source="$root/releases/$release/source"
# Serialize optional service changes; never acquire or invoke API activation.
exec 9>/run/lock/snapway-mobile-services.lock
flock -x 9
id snapway >/dev/null
id snapwaydeploy >/dev/null
if [[ "$stage_source" == true && ! -e "$root/releases/$release" ]]; then
    incoming="$root/incoming/$release/source"
    [[ -d "$incoming" && $(readlink -f "$incoming") == "$incoming" ]]
    install -d -m 755 "$root/releases/$release"
    install -d -m 755 -o snapwaydeploy -g snapwaydeploy "$source"
    # An uploader cannot cause root to read private files through a source link.
    runuser -u snapwaydeploy -- cp -R --no-dereference --no-preserve=ownership "$incoming/." "$source/"
    /usr/bin/python3 - "$source" <<'PYFREEZE'
import os
import pathlib
import stat
import sys
root = pathlib.Path(sys.argv[1])
for directory, folders, files in os.walk(root, followlinks=False):
    parent = pathlib.Path(directory)
    if parent.is_symlink():
        raise SystemExit("Source directories must not be symbolic links")
    os.chown(parent, 0, 0, follow_symlinks=False)
    parent.chmod(0o755)
    for name in folders + files:
        path = parent / name
        mode = path.lstat().st_mode
        if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            raise SystemExit("Source must contain only regular files and directories")
        os.chown(path, 0, 0, follow_symlinks=False)
        path.chmod(0o755 if stat.S_ISDIR(mode) or mode & 0o111 else 0o644)
PYFREEZE
    touch "$root/releases/$release/.mobile-source-complete"
elif [[ "$stage_source" == true ]]; then
    [[ -f "$root/releases/$release/.mobile-source-complete" ]]
fi
[[ -f "$root/releases/$release/.mobile-source-complete" ]]
[[ -d "$source" && ! -L "$root/releases/$release" ]]
[[ $(readlink -f "$source") == "$source" ]]
command -v systemctl >/dev/null
command -v systemd-analyze >/dev/null
[[ -x "$node" && -x "$venv/bin/python" ]]
[[ -f "$source/apps/pipeline/server/start.js" ]]
[[ -f "$source/apps/place-match/placematch/cli.py" ]]
commit=${release%%-*}
runtime="$root/venvs/mobile-$commit"
[[ $(readlink -f "$runtime") == "$runtime" ]]
[[ "$node" == "$runtime/node/bin/node" && "$venv" == "$runtime/placematch" ]]
[[ -d "$runtime/pipeline/node_modules" && ! -L "$runtime/pipeline/node_modules" ]]
[[ -d "$runtime/placematch-data/models/megaloc" ]]
[[ -d "$runtime/placematch-runs" ]]
/usr/bin/python3 - "$runtime/prepared.json" "$source" "$commit" <<'PYPREPARED'
import hashlib
import json
import pathlib
import sys
report = json.loads(pathlib.Path(sys.argv[1]).read_text())
source = pathlib.Path(sys.argv[2])
if report.get("prepared") is not True or report.get("commit") != sys.argv[3]:
    raise SystemExit("Prepared runtime identity does not match the selected release")
for key, path in {
    "pipeline_lock_sha256": "apps/pipeline/package-lock.json",
    "placematch_lock_sha256": "apps/place-match/uv.lock",
}.items():
    if report.get(key) != hashlib.sha256((source / path).read_bytes()).hexdigest():
        raise SystemExit("Prepared runtime lock does not match the selected source")
PYPREPARED
[[ -f /etc/indoor-nav/api.env ]]
# Validate protected-file metadata; the parser below never prints credential values.
[[ $(stat -c '%u:%a' /etc/indoor-nav/api.env) == 0:600 ]]
[[ $(stat -c '%u' "$root/releases/$release") == 0 ]]
release_mode=$(stat -c '%a' "$root/releases/$release")
(( (8#$release_mode & 8#022) == 0 ))
/usr/bin/python3 - /etc/indoor-nav/api.env <<'PYENV'
import pathlib
import sys
# Parse as data, never source a root credential file as executable shell code.
values = {}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    key, separator, value = line.strip().partition("=")
    if separator and not key.startswith("#"):
        values[key.strip()] = value.strip().strip("\"'")
if len(values.get("PLACEMATCH_ENGINE_TOKEN", "")) < 24:
    raise SystemExit("Existing PLACEMATCH_ENGINE_TOKEN must be configured by the credential owner")
provider = values.get("AI_PROVIDER")
if provider not in {"anthropic", "vertex"}:
    raise SystemExit("Existing AI_PROVIDER must satisfy the production provider policy")
required = ["ANTHROPIC_API_KEY"] if provider == "anthropic" else ["VERTEX_API_KEY", "VERTEX_PROJECT"]
for key in required:
    if not values.get(key):
        raise SystemExit("Existing provider credentials must be configured by the credential owner")
PYENV
# The prepared runtime has no editable install into incoming mutable source.
# Freeze code/dependencies while retaining private engine data/catalog paths.
chown root:root "$runtime"
chmod go-w "$runtime"
for code in node pipeline placematch; do
    [[ -d "$runtime/$code" && ! -L "$runtime/$code" ]]
    chown -R root:root "$runtime/$code"
    chmod -R go-w "$runtime/$code"
done
for directory in placematch-data placematch-runs; do
    chown snapway:snapway "$runtime/$directory"
    chmod 700 "$runtime/$directory"
done
# Validate executables without running an uploaded runtime as root.
node_version=$(runuser -u snapway -- "$node" -p 'process.versions.node')
[[ "$node_version" =~ ^24\.([0-9]+)\.([0-9]+)$ ]]
((10#${BASH_REMATCH[1]} >= 15))
runuser -u snapway -- "$venv/bin/python" --version

for directory in pipeline-local pipeline-output; do
    path="$root/shared/$directory"
    if [[ ! -e "$path" ]]; then
        install -d -m 700 -o snapway -g snapway "$path"
    else
        [[ -d "$path" && ! -L "$path" ]]
        [[ $(stat -c '%U:%G:%a' "$path") == snapway:snapway:700 ]]
    fi
done
for destination in apps/pipeline/.local apps/pipeline/output apps/pipeline/node_modules apps/place-match/data apps/place-match/runs; do
    [[ ! -L "$source/$destination" ]]
    install -d -m 755 "$source/$destination"
done

backup="$root/shared/mobile-service-backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 700 "$backup"
stage="$backup/rendered"
install -d -m 700 "$stage"
units=(snapway-pipeline.service snapway-placematch.service)
for unit in "${units[@]}"; do
    template="$source/infra/units/$unit"
    [[ -f "$template" && ! -L "$template" ]]
    [[ $(stat -c '%u' "$template") == 0 ]]
    template_mode=$(stat -c '%a' "$template")
    (( (8#$template_mode & 8#022) == 0 ))
    [[ ! -L "/etc/systemd/system/$unit" ]]
    if [[ -f "/etc/systemd/system/$unit" ]]; then
        cp -p -- "/etc/systemd/system/$unit" "$backup/$unit"
    fi
    if systemctl is-active --quiet "$unit"; then touch "$backup/$unit.was-active"; fi
    if systemctl is-enabled --quiet "$unit"; then touch "$backup/$unit.was-enabled"; fi
    /usr/bin/python3 - "$template" "$stage/$unit" "$release" "$node" "$venv" <<'PY'
import pathlib
import sys
original, destination, release, node, venv = sys.argv[1:]
text = pathlib.Path(original).read_text()
for name, value in {
    "@RELEASE_ID@": release, "@NODE_BINARY@": node, "@PLACEMATCH_VENV@": venv,
    "@PIPELINE_NODE_MODULES@": str(pathlib.Path(venv).parent / "pipeline/node_modules"),
    "@PLACEMATCH_DATA@": str(pathlib.Path(venv).parent / "placematch-data"),
    "@PLACEMATCH_RUNS@": str(pathlib.Path(venv).parent / "placematch-runs"),
}.items():
    text = text.replace(name, value)
if any(name in text for name in (
    "@RELEASE_ID@", "@NODE_BINARY@", "@PLACEMATCH_VENV@", "@PIPELINE_NODE_MODULES@",
    "@PLACEMATCH_DATA@", "@PLACEMATCH_RUNS@",
)):
    raise SystemExit("Unresolved service template placeholder")
pathlib.Path(destination).write_text(text)
PY
done
# Parse both before touching installed units. Source/venv/modules remain separate
# from the running API and Caddy. Verification does not start either service.
systemd-analyze verify "$stage/snapway-pipeline.service" "$stage/snapway-placematch.service"

rollback() {
    status=$?
    trap - ERR
    set +e
    printf '%s\n' 'Optional service startup failed; restoring previous unit states.' >&2
    systemctl stop "${units[@]}"
    for unit in "${units[@]}"; do
        if [[ -f "$backup/$unit" ]]; then
            install -m 644 "$backup/$unit" "/etc/systemd/system/$unit"
        else
            systemctl disable "$unit" >/dev/null 2>&1
            rm -f -- "/etc/systemd/system/$unit"
        fi
    done
    systemctl daemon-reload
    for unit in "${units[@]}"; do
        if [[ -f "$backup/$unit" ]]; then
            if [[ -f "$backup/$unit.was-enabled" ]]; then systemctl enable "$unit"; else systemctl disable "$unit"; fi
            if [[ -f "$backup/$unit.was-active" ]]; then systemctl start "$unit"; fi
        fi
    done
    printf 'Unit backup retained at %s\n' "$backup" >&2
    exit "$status"
}
trap rollback ERR
for unit in "${units[@]}"; do
    if ! cmp -s "$stage/$unit" "/etc/systemd/system/$unit"; then
        touch "$backup/$unit.changed"
        install -m 644 "$stage/$unit" "/etc/systemd/system/$unit"
    fi
done
systemctl daemon-reload
for unit in "${units[@]}"; do
    if [[ -f "$backup/$unit.changed" && -f "$backup/$unit.was-active" ]]; then
        systemctl restart "$unit"
    else
        systemctl start "$unit"
    fi
done
ready=false
for ((attempt=0; attempt<45; attempt++)); do
    pipeline=$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 2 http://127.0.0.1:5175/api/health 2>/dev/null) || pipeline=unreachable
    engine=$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 2 http://127.0.0.1:8790/v1/health 2>/dev/null) || engine=unreachable
    if [[ "$pipeline" == 200 && ( "$engine" == 401 || "$engine" == 403 ) ]]; then
        ready=true
        break
    fi
    sleep 1
done
[[ "$ready" == true ]]
systemctl is-active --quiet snapway-pipeline.service
systemctl is-active --quiet snapway-placematch.service
systemctl enable "${units[@]}"
trap - ERR
printf '%s\n' 'Private optional services started; unauthenticated engine access is blocked.'
printf '%s\n' 'Authorized model/index readiness and phone matching still require their separate API probes.'
printf 'Prior units and states retained at %s\n' "$backup"
