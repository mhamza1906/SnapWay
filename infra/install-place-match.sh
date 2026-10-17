#!/bin/bash
# Installs or updates the photo-localization engine (apps/place-match) on the VM.
# Run as snapwayadmin with sudo, from a directory that holds a reviewed copy of
# apps/place-match/ and infra/ (see docs/place-match-vultr.md). Separate from the
# automatic release controller: ordinary CI releases never touch this service.
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run with sudo bash infra/install-place-match.sh'; exit 1; }
test -x /usr/local/bin/uv || { echo 'Install uv 0.12.15 at /usr/local/bin/uv first'; exit 1; }
command -v git >/dev/null || { echo 'git is needed to fetch the pinned LightGlue dependency'; exit 1; }
test -f apps/place-match/pyproject.toml || { echo 'Run from a directory containing apps/place-match/'; exit 1; }

app_user=snapway-placematch
root=/srv/placematch
# The engine is killed at this limit instead of the API (OOM protection). MegaLoc on
# CPU uses about 2 GB; raise after the VM is resized (e.g. 3500M on 8 GB).
memory_max=${PLACEMATCH_MEMORY_MAX:-2600M}
[[ "$memory_max" =~ ^[0-9]+M$ ]] || { echo "PLACEMATCH_MEMORY_MAX must be like 2600M"; exit 1; }

if ! id "$app_user" >/dev/null 2>&1; then
    useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin "$app_user"
fi
install -d -m 755 -o root -g root "$root" "$root/releases" "$root/python"
# Weights, reference sets and calibration: persistent, outside releases.
install -d -m 750 -o "$app_user" -g "$app_user" "$root/data"
install -d -m 700 /etc/indoor-nav

release="$root/releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 755 "$release"
# Source only: never copy local data, environments or credentials.
tar -C apps/place-match --exclude=./data --exclude=./runs --exclude=./.venv \
    --exclude=./.env --exclude='*/__pycache__' --exclude=./.pytest_cache \
    --exclude=./.ruff_cache -cf - . | tar -C "$release" --no-same-owner -xf -
ln -s "$root/data" "$release/data"
# Exact locked dependencies; the venv stays root-owned and read-only to the service.
UV_PYTHON_INSTALL_DIR="$root/python" UV_PROJECT_ENVIRONMENT="$release/.venv" \
    /usr/local/bin/uv sync --frozen --no-dev --project "$release"
"$release/.venv/bin/placematch" --help >/dev/null

if [ ! -e /etc/indoor-nav/placematch.env ]; then
    install -m 600 -o root -g root infra/placematch.env.example /etc/indoor-nav/placematch.env
fi

cat > /etc/systemd/system/snapway-placematch.service <<EOF
[Unit]
Description=SnapWay photo localization engine (MegaLoc, loopback only)
After=network-online.target

[Service]
User=$app_user
Group=$app_user
EnvironmentFile=/etc/indoor-nav/placematch.env
Environment=HOME=/tmp XDG_CACHE_HOME=/tmp/cache
WorkingDirectory=$root/current
ExecStart=$root/current/.venv/bin/placematch serve-mobile --host 127.0.0.1 --port 8790
Restart=on-failure
RestartSec=10
# Keep the website and API responsive: lower CPU share, hard memory cap.
CPUWeight=50
Nice=5
MemoryHigh=$(( ${memory_max%M} * 9 / 10 ))M
MemoryMax=$memory_max
MemorySwapMax=0
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$root/data

[Install]
WantedBy=multi-user.target
EOF

ln -sfn "$release" "$root/current.new"
mv -T "$root/current.new" "$root/current"
systemctl daemon-reload
systemctl enable snapway-placematch.service >/dev/null

if ! grep -Eq '^MOBILE_API_TOKEN=.{24,}$' /etc/indoor-nav/placematch.env; then
    echo "Installed $release. Set MOBILE_API_TOKEN in /etc/indoor-nav/placematch.env, add the"
    echo 'weights and a reference set (docs/place-match-vultr.md), then:'
    echo '  sudo systemctl restart snapway-placematch'
    exit 0
fi
systemctl restart snapway-placematch.service
echo "Installed and restarted $release. Check: sudo journalctl -u snapway-placematch -n 50"
