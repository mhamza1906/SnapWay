#!/bin/bash
# Run as snapwayadmin with sudo, from a reviewed checkout on the server.
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run with sudo bash infra/install-server.sh'; exit 1; }
id snapwaydeploy >/dev/null
if ! id snapway >/dev/null 2>&1; then
    useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin snapway
fi
command -v caddy >/dev/null
test -x /usr/local/bin/uv || { echo 'Install uv 0.12.15 at /usr/local/bin/uv first'; exit 1; }

install -d -m 755 /srv/indoor-nav
install -d -m 755 -o root -g root /srv/indoor-nav/releases
install -d -m 755 -o snapwaydeploy -g snapwaydeploy \
    /srv/indoor-nav/incoming /srv/indoor-nav/venvs /srv/indoor-nav/python
install -d -m 755 /srv/indoor-nav/shared \
    /srv/indoor-nav/shared/static /srv/indoor-nav/shared/web-assets
install -d -m 700 -o snapway -g snapway \
    /srv/indoor-nav/shared/media /srv/indoor-nav/shared/indexes
install -d -m 700 /etc/indoor-nav

install -m 755 -o root -g root infra/deploy.py /usr/local/sbin/snapway-activate
if [ ! -e /etc/indoor-nav/domain ]; then
    printf '%s\n' snapway.work > /etc/indoor-nav/domain
fi
# Never overwrite existing credentials or the working Caddy configuration.
if [ ! -e /etc/indoor-nav/api.env ]; then
    install -m 600 -o root -g root infra/api.env.example /etc/indoor-nav/api.env
fi
printf '%s\n' 'snapwaydeploy ALL=(root) NOPASSWD: /usr/local/sbin/snapway-activate' \
    > /etc/sudoers.d/snapway-deploy
chmod 440 /etc/sudoers.d/snapway-deploy
visudo -cf /etc/sudoers.d/snapway-deploy
echo 'Controller installed. Configure DATABASE_URL and DATABASE_MIGRATOR in api.env before deployment.'
