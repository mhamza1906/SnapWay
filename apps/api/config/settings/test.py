from config.environment import ROOT

from .base import *  # noqa: F403

SECRET_KEY = "snapway-test-only-secret-never-use-in-deployment"
ALLOWED_HOSTS = ["testserver", "localhost", "127.0.0.1"]
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
STATIC_ROOT = ROOT / "local" / "test-static"
MEDIA_ROOT = ROOT / "local" / "test-media"
CELERY_TASK_ALWAYS_EAGER = True
# Tests never hit live R2; keep filesystem default_storage.
S3_SIGNED_URL_TTL_SECONDS = 300
MEDIA_STORAGE_BACKEND = "filesystem"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}
