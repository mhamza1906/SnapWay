import os
import socket
from urllib.parse import urlsplit

from config.environment import ROOT, env

# Sole private env source for development; process environment takes precedence.
env.read_env(ROOT / "local" / ".env", overwrite=False)
# Until scripts/env_contract.py migrate consolidates it, the older
# local/env/api.env still fills in values local/.env does not set. Template
# placeholders ("your_…") are skipped, so an unfilled bucket stays unset.
_legacy = ROOT / "local" / "env" / "api.env"
if _legacy.exists():
    for _line in _legacy.read_text(encoding="utf-8").splitlines():
        _key, _sep, _value = _line.strip().partition("=")
        if _sep and not _key.startswith("#") and _value and not _value.startswith("your_"):
            os.environ.setdefault(_key, _value)

from .base import *  # noqa: E402, F403

SECRET_KEY = env("DJANGO_SECRET_KEY")
DEBUG = env.bool("DJANGO_DEBUG", default=True)
# Prefer DATABASE_URL (Tiger Data / Postgres). SQLite remains the offline fallback.
_database_url = env("DATABASE_URL", default="").strip()
if _database_url:
    DATABASES = {"default": env.db_url_config(_database_url)}
else:
    DATABASES = {"default": env.db_url_config(f"sqlite:///{ROOT / 'local' / 'dev.sqlite3'}")}
STATIC_ROOT = ROOT / "local" / "static"
MEDIA_ROOT = ROOT / "local" / "media"
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"


def _primary_lan_ipv4():
    """Best-effort primary LAN address; a UDP connect sends no packets."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))
            address = probe.getsockname()[0]
    except OSError:
        return []
    return [] if address.startswith(("127.", "0.")) else [address]


# Phone testing through the HTTPS dev server (`npm run start:phone`, port 4443),
# which proxies to this plain-HTTP runserver. Django sees http, so the phone's
# https Origin must be trusted explicitly. Development settings only; set
# DEV_EXTRA_ORIGINS (comma-separated origins, e.g. a tunnel URL) to replace
# the default list (localhost and the primary LAN IPv4 on DEV_PHONE_PORT).
DEV_PHONE_PORT = env.int("DEV_PHONE_PORT", default=4443)
DEV_EXTRA_ORIGINS = env.list(
    "DEV_EXTRA_ORIGINS",
    default=[
        f"https://{host}:{DEV_PHONE_PORT}"
        for host in ["localhost", "127.0.0.1", *_primary_lan_ipv4()]
    ],
)
CSRF_TRUSTED_ORIGINS = [*CSRF_TRUSTED_ORIGINS, *DEV_EXTRA_ORIGINS]  # noqa: F405
_phone_hosts = [urlsplit(origin).hostname for origin in DEV_EXTRA_ORIGINS]
ALLOWED_HOSTS = list(dict.fromkeys([*ALLOWED_HOSTS, *filter(None, _phone_hosts)]))  # noqa: F405

# Opt in only when the loopback server is behind the chosen HTTPS preview
# proxy. Preserve its Host so OAuth callbacks use the public phone URL.
if env.bool("DJANGO_TRUST_PROXY", default=False):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# Cloudflare R2 / S3-compatible media when S3_* (or R2_* aliases) are set in local/.env.
from config.storage_backends import apply_storages  # noqa: E402

apply_storages(globals())
