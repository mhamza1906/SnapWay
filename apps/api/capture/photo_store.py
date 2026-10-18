"""Where capture photos live: Cloudflare R2, never the server's disk.

Photos go to a private R2 bucket under
``<R2_PREFIX>/capture/<target>/<session>/<photo>/<variant>.<ext>`` through R2's
S3-compatible API (AWS Signature Version 4, signed here with httpx, so no SDK
is needed). Django keeps only the object key (``Asset.storage_key = "r2:<key>"``)
and serves images itself after the usual membership check; bucket URLs and
credentials never reach the browser.

Configuration (server env only): ``R2_ACCOUNT_ID``, ``R2_ACCESS_KEY_ID``,
``R2_SECRET_ACCESS_KEY``, ``R2_BUCKET_NAME``, optional ``R2_PREFIX`` (default
``snapway``). Without them, uploads fail with ``PhotoStoreUnavailable``
(HTTP 503); there is no local fallback. Tests use ``MemoryPhotoStore``
(``CAPTURE_PHOTO_STORE = "memory"``).
"""

import datetime
import hashlib
import hmac
from urllib.parse import quote

import httpx
from django.conf import settings

PREFIX = "r2:"
REGION = "auto"
TIMEOUT = httpx.Timeout(60.0, connect=10.0)
EXTENSIONS = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


class PhotoStoreUnavailable(RuntimeError):
    pass


class PhotoMissing(LookupError):
    pass


def _config():
    values = {
        name: (getattr(settings, name, "") or "").strip()
        for name in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME")
    }
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise PhotoStoreUnavailable(
            f"Photo storage is not configured: set {', '.join(missing)} in the API's server env."
        )
    return values


def signing_key(secret, date, region=REGION, service="s3"):
    """The SigV4 signing key for one day (``date`` is YYYYMMDD)."""
    key = hmac.new(f"AWS4{secret}".encode(), date.encode(), hashlib.sha256).digest()
    for part in (region, service, "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    return key


def _request(method, object_key, body=b"", content_type=None):
    c = _config()
    host = f"{c['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    path = "/" + quote(f"{c['R2_BUCKET_NAME']}/{object_key}", safe="/-_.~")
    now = datetime.datetime.now(datetime.UTC)
    stamp, date = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    payload = hashlib.sha256(body).hexdigest()
    headers = {"host": host, "x-amz-content-sha256": payload, "x-amz-date": stamp}
    if content_type:
        headers["content-type"] = content_type
    names = sorted(headers)
    canonical = "\n".join(
        [method, path, "", *(f"{n}:{headers[n]}" for n in names), "", ";".join(names), payload]
    )
    scope = f"{date}/{REGION}/s3/aws4_request"
    to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()]
    )
    signature = hmac.new(
        signing_key(c["R2_SECRET_ACCESS_KEY"], date), to_sign.encode(), hashlib.sha256
    ).hexdigest()
    headers["authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={c['R2_ACCESS_KEY_ID']}/{scope}, "
        f"SignedHeaders={';'.join(names)}, Signature={signature}"
    )
    try:
        return httpx.request(
            method, f"https://{host}{path}", content=body, headers=headers, timeout=TIMEOUT
        )
    except httpx.HTTPError:
        raise PhotoStoreUnavailable("Could not reach Cloudflare R2.") from None


def _object_key(name, content_type):
    prefix = (getattr(settings, "R2_PREFIX", "snapway") or "").strip("/")
    key = f"{name}.{EXTENSIONS.get(content_type, 'bin')}"
    return f"{prefix}/{key}" if prefix else key


class R2PhotoStore:
    def save(self, name, data, content_type):
        """Upload one file; ``name`` has no extension. Returns the storage key."""
        key = _object_key(name, content_type)
        response = _request("PUT", key, data, content_type)
        if response.status_code != 200:
            # Never echo the upstream body.
            code = response.status_code
            raise PhotoStoreUnavailable(f"Cloudflare R2 rejected the upload (HTTP {code}).")
        return f"{PREFIX}{key}"

    def open(self, storage_key):
        if not storage_key.startswith(PREFIX):
            raise PhotoMissing(storage_key)
        response = _request("GET", storage_key[len(PREFIX) :])
        if response.status_code == 404:
            raise PhotoMissing(storage_key)
        if response.status_code != 200:
            code = response.status_code
            raise PhotoStoreUnavailable(f"Cloudflare R2 could not return the image (HTTP {code}).")
        return response.content

    def delete(self, storage_key):
        if storage_key.startswith(PREFIX):
            _request("DELETE", storage_key[len(PREFIX) :])


class MemoryPhotoStore:
    """In-process store for tests; nothing touches disk or the network."""

    files = {}

    def save(self, name, data, content_type):
        storage_key = f"{PREFIX}test/{_object_key(name, content_type)}"
        if storage_key in self.files:
            raise PhotoStoreUnavailable("Already stored.")
        self.files[storage_key] = data
        return storage_key

    def open(self, storage_key):
        try:
            return self.files[storage_key]
        except KeyError:
            raise PhotoMissing(storage_key) from None

    def delete(self, storage_key):
        self.files.pop(storage_key, None)


def photo_store():
    kind = getattr(settings, "CAPTURE_PHOTO_STORE", "r2")
    return MemoryPhotoStore() if kind == "memory" else R2PhotoStore()
