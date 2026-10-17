"""Resolve S3-compatible (Cloudflare R2) Django STORAGES from env."""

from __future__ import annotations

from config.environment import env


def resolve_s3_options() -> dict | None:
    """Return S3Boto3Storage OPTIONS if a bucket is configured, else None.

    Canonical vars are S3_*. Optional R2_* aliases fill gaps when S3_* are empty.
    """
    bucket = env("S3_BUCKET_NAME", default="").strip()
    endpoint = env("S3_ENDPOINT_URL", default="").strip()
    access_key = env("S3_ACCESS_KEY_ID", default="").strip()
    secret_key = env("S3_SECRET_ACCESS_KEY", default="").strip()
    region = env("S3_REGION_NAME", default="auto").strip() or "auto"
    addressing = env("S3_ADDRESSING_STYLE", default="path").strip() or "path"

    r2_account = env("R2_ACCOUNT_ID", default="").strip()
    if not bucket:
        bucket = env("R2_BUCKET_NAME", default="").strip()
    if not access_key:
        access_key = env("R2_ACCESS_KEY_ID", default="").strip()
    if not secret_key:
        secret_key = env("R2_SECRET_ACCESS_KEY", default="").strip()
    if not endpoint and r2_account:
        endpoint = f"https://{r2_account}.r2.cloudflarestorage.com"

    if not (bucket and endpoint and access_key and secret_key):
        return None

    return {
        "access_key": access_key,
        "secret_key": secret_key,
        "bucket_name": bucket,
        "endpoint_url": endpoint,
        "region_name": region,
        "default_acl": None,
        "querystring_auth": True,
        "signature_version": "s3v4",
        "addressing_style": addressing,
        "file_overwrite": True,
    }


def apply_storages(settings_globals: dict) -> None:
    """Mutate settings module globals with STORAGES + signed URL TTL."""
    ttl = env.int("S3_SIGNED_URL_TTL_SECONDS", default=300)
    settings_globals["S3_SIGNED_URL_TTL_SECONDS"] = ttl
    options = resolve_s3_options()
    if options is None:
        settings_globals["STORAGES"] = {
            "default": {
                "BACKEND": "django.core.files.storage.FileSystemStorage",
            },
            "staticfiles": {
                "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
            },
        }
        settings_globals["MEDIA_STORAGE_BACKEND"] = "filesystem"
        return

    settings_globals["STORAGES"] = {
        "default": {
            "BACKEND": "storages.backends.s3boto3.S3Boto3Storage",
            "OPTIONS": {
                **options,
                "querystring_expire": ttl,
            },
        },
        "staticfiles": {
            "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
        },
    }
    settings_globals["MEDIA_STORAGE_BACKEND"] = "s3"
    # AWS_* aliases help libraries that read them; OPTIONS remain authoritative.
    settings_globals["AWS_S3_ENDPOINT_URL"] = options["endpoint_url"]
    settings_globals["AWS_S3_REGION_NAME"] = options["region_name"]
    settings_globals["AWS_STORAGE_BUCKET_NAME"] = options["bucket_name"]
    settings_globals["AWS_S3_ACCESS_KEY_ID"] = options["access_key"]
    settings_globals["AWS_S3_SECRET_ACCESS_KEY"] = options["secret_key"]
    settings_globals["AWS_S3_SIGNATURE_VERSION"] = "s3v4"
    settings_globals["AWS_S3_ADDRESSING_STYLE"] = options["addressing_style"]
    settings_globals["AWS_DEFAULT_ACL"] = None
    settings_globals["AWS_QUERYSTRING_AUTH"] = True
    settings_globals["AWS_QUERYSTRING_EXPIRE"] = ttl
