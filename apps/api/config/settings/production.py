from django.core.exceptions import ImproperlyConfigured

from config.environment import env

from .base import *  # noqa: F403

SECRET_KEY = env("DJANGO_SECRET_KEY")
if len(SECRET_KEY) < 50 or len(set(SECRET_KEY)) < 5 or SECRET_KEY.startswith("django-insecure-"):
    raise ImproperlyConfigured("DJANGO_SECRET_KEY must be a strong production secret")
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS")
if not ALLOWED_HOSTS or "*" in ALLOWED_HOSTS:
    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS must contain explicit production hosts")
DATABASES = {"default": env.db("DATABASE_URL")}
database = DATABASES["default"]
if database["ENGINE"] != "django.db.backends.postgresql":
    raise ImproperlyConfigured("DATABASE_URL must select PostgreSQL in production")
options = database.setdefault("OPTIONS", {})
if (
    env("PGSSLMODE", default="verify-full") != "verify-full"
    or options.get("sslmode", "verify-full") != "verify-full"
):
    raise ImproperlyConfigured("PGSSLMODE and DATABASE_URL must require verify-full")
root_certificate = env("PGSSLROOTCERT", default="system")
if options.get("sslrootcert", root_certificate) != root_certificate:
    raise ImproperlyConfigured("PGSSLROOTCERT conflicts with DATABASE_URL")
options.update(
    sslmode="verify-full",
    sslrootcert=root_certificate,
    connect_timeout=env.int("DATABASE_CONNECT_TIMEOUT", default=10),
)
database["CONN_MAX_AGE"] = 0
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 3600
SECURE_HSTS_INCLUDE_SUBDOMAINS = env.bool("DJANGO_HSTS_INCLUDE_SUBDOMAINS", default=False)
SECURE_HSTS_PRELOAD = env.bool("DJANGO_HSTS_PRELOAD", default=False)
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
# Enable only behind the controlled proxy that strips caller-supplied forwarding headers.
if env.bool("DJANGO_TRUST_PROXY", default=False):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
STATIC_ROOT = env("STATIC_ROOT")
STATIC_URL = env("STATIC_URL", default=STATIC_URL)  # noqa: F405
MEDIA_ROOT = env("MEDIA_ROOT")
