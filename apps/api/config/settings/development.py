import socket
from urllib.parse import urlsplit

from config.environment import ROOT, env

env.read_env(ROOT / "local" / "env" / "api.env", overwrite=False)

from .base import *  # noqa: E402, F403

SECRET_KEY = env("DJANGO_SECRET_KEY")
DEBUG = env.bool("DJANGO_DEBUG", default=True)
# SQLite is only for onboarding/framework checks. Product acceptance uses PostgreSQL.
DATABASES = {
    "default": env.db("DATABASE_URL", default=f"sqlite:///{ROOT / 'local' / 'dev.sqlite3'}")
}
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
