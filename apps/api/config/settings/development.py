from config.environment import ROOT, env

# Sole private env source for development; process environment takes precedence.
env.read_env(ROOT / "local" / ".env", overwrite=False)

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

# Cloudflare R2 / S3-compatible media when S3_* (or R2_* aliases) are set in local/.env.
from config.storage_backends import apply_storages  # noqa: E402

apply_storages(globals())
