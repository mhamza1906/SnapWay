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
