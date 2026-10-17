#!/bin/bash
# GitHub runner only. Never disable SSH host-key verification.
set -euo pipefail
release=$1
[[ "$release" =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]]
[[ "$VULTR_SSH_PORT" =~ ^[0-9]+$ ]]
[[ "$VULTR_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]
[[ "$VULTR_USER" = snapwaydeploy ]]
umask 077
sshdir=$(mktemp -d)
trap 'rm -rf -- "$sshdir"' EXIT
printf '%s\n' "$VULTR_SSH_KEY" | tr -d '\r' > "$sshdir/key"
printf '%s\n' "$VULTR_KNOWN_HOSTS" | tr -d '\r' > "$sshdir/known_hosts"
options=(-i "$sshdir/key" -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$sshdir/known_hosts"
    -o ConnectTimeout=15)
target="$VULTR_USER@$VULTR_HOST"
remote="/srv/indoor-nav/incoming/$release"
# A unique run/attempt ID prevents overwriting an active release.
ssh "${options[@]}" -p "$VULTR_SSH_PORT" "$target" "mkdir -m 755 '$remote'"
scp "${options[@]}" -P "$VULTR_SSH_PORT" local/release.tar.gz \
    local/release.tar.gz.sha256 "$target:$remote/"
ssh "${options[@]}" -p "$VULTR_SSH_PORT" "$target" \
    "cd '$remote' && sha256sum -c release.tar.gz.sha256 && umask 022 && tar --no-same-owner -xzf release.tar.gz && sudo -n /usr/local/sbin/snapway-activate '$release'"
