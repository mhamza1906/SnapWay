from config.environment import ROOT, env

env.read_env(ROOT / "local" / "env" / "api.env", overwrite=False)

from .base import *  # noqa: E402, F403

SECRET_KEY = env("DJANGO_SECRET_KEY")
DEBUG = env.bool("DJANGO_DEBUG", default=True)
# SQLite is only for onboarding/framework checks. Product acceptance uses PostgreSQL.
# Blank/missing DATABASE_URL uses local/dev.sqlite3 (auth spikes stay off shared Postgres).
_database_url = env("DATABASE_URL", default="").strip()
if _database_url:
    DATABASES = {"default": env.db_url_config(_database_url)}
else:
    DATABASES = {
        "default": env.db_url_config(f"sqlite:///{ROOT / 'local' / 'dev.sqlite3'}")
    }
STATIC_ROOT = ROOT / "local" / "static"
MEDIA_ROOT = ROOT / "local" / "media"
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
