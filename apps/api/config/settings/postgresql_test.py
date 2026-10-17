"""Opt-in isolated PostgreSQL integration tests; never infer a production URL."""

from config.environment import env

from .test import *  # noqa: F403

DATABASES = {"default": env.db("TEST_DATABASE_URL")}
if DATABASES["default"]["ENGINE"] != "django.db.backends.postgresql":
    raise ValueError("TEST_DATABASE_URL must use PostgreSQL")
DATABASES["default"].setdefault("OPTIONS", {}).setdefault("connect_timeout", 5)
