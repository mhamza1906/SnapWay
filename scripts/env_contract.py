"""Manage the single private env file; diagnostics never include private values."""

import argparse
import os
import re
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / "local" / ".env"
TEMPLATE = ROOT / ".env.example"
LEGACY = (
    ROOT / "local/env/api.env",
    ROOT / "local/env/web.env",
    ROOT / "local/env/google-auth.env",
    ROOT / "apps/pipeline/.env.prod",
    ROOT / "apps/pipeline/.env.dev",
    ROOT / "apps/pipeline/.env",
    ROOT / "apps/place-match/.env",
    ROOT / ".env",
)
MANAGED = {"APP_RELEASE", "STATIC_ROOT", "STATIC_URL", "PYTHONPATH"}
# Retired scaffolding never controlled the live Django OAuth implementation.
# Accept only known scaffold defaults; custom values require explicit review.
RETIRED_DEFAULTS = {
    "GOOGLE_CLOUD_PROJECT_ID": {""},
    "GOOGLE_OAUTH_SCOPES": {"", "openid,email,profile"},
    "GOOGLE_OAUTH_CALLBACK_URL": {""},
    "PUBLIC_APP_ORIGIN": {"", "http://localhost:4200", "http://127.0.0.1:4200"},
}
KEY = re.compile(r"[A-Z][A-Z0-9_]*")


class ContractError(ValueError):
    """A diagnostic constructed exclusively from public key names and fixed text."""


def read_values(path):
    values = {}
    for number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not KEY.fullmatch(key) or key in values:
            raise ContractError(f"Invalid or duplicate key at line {number}")
        if any(char.isspace() or char in "\"'#$`\\" for char in value):
            raise ContractError(f"Unsupported literal syntax for {key} at line {number}")
        values[key] = value
    return values


def contract(path):
    values = read_values(path)
    tags = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# @"):
            tag, *keys = line[3:].split()
            tags.setdefault(tag, set()).update(keys)
    if set().union(*tags.values()) - values.keys():
        raise ContractError("Template metadata names undefined keys")
    if not values.get("ENV_SCHEMA_VERSION"):
        raise ContractError("Template requires ENV_SCHEMA_VERSION")
    return values, tags


def problems(values, defaults, tags, profile):
    errors = []
    variable = tags.get("secret", set()) | tags.get("override", set())
    checks = (
        ("Missing keys", defaults.keys() - values.keys()),
        ("Unknown keys", values.keys() - defaults.keys()),
        (
            "Required values empty",
            {k for k in tags.get(f"required-{profile}", ()) if not values.get(k)},
        ),
        (
            "Shared settings differ from template",
            {
                k
                for k in defaults.keys() & values.keys()
                if k not in variable and values[k] != defaults[k]
            },
        ),
    )
    for label, keys in checks:
        if keys:
            errors.append(f"{label}: {', '.join(sorted(keys))}")
    if values.get("VECTORIZER_LIVE_ENABLED") != "false" or any(
        values.get(k) for k in ("VECTORIZER_API_ID", "VECTORIZER_API_SECRET")
    ):
        errors.append("Demo requires disabled Vectorizer with empty credentials")
    if profile == "production":
        if values.get("DJANGO_SETTINGS_MODULE") != "config.settings.production":
            errors.append("Production requires the production Django settings profile")
        if values.get("DJANGO_DEBUG") != "false":
            errors.append("Production requires DJANGO_DEBUG=false")
        if values.get("DJANGO_TRUST_PROXY") != "true":
            errors.append("Production requires the controlled Caddy proxy profile")
        origins = values.get("CSRF_TRUSTED_ORIGINS", "").split(",")
        if any(not origin.startswith("https://") for origin in origins):
            errors.append("Production requires explicit HTTPS CSRF trusted origins")
        hosts = values.get("DJANGO_ALLOWED_HOSTS", "").split(",")
        if any(h in {"", "*", "localhost", "127.0.0.1"} for h in hosts):
            errors.append("Production requires explicit non-local Django hosts")
        if not values.get("DATABASE_URL", "").startswith(("postgres://", "postgresql://")):
            errors.append("Production requires PostgreSQL DATABASE_URL")
        if not values.get("MEDIA_ROOT", "").startswith("/"):
            errors.append("Production requires absolute MEDIA_ROOT")
        if values.get("APP_ENV") != "prod" or values.get("AI_PROVIDER") != "vertex":
            errors.append("Production pipeline policy requires prod/vertex")
        mode, ca = values.get("PGSSLMODE"), values.get("PGSSLROOTCERT")
        if mode not in {"require", "verify-full"} or (mode == "require" and ca):
            errors.append("Invalid production TLS profile or nonempty demo PGSSLROOTCERT")
        if mode == "verify-full" and not ca:
            errors.append("Verified TLS requires PGSSLROOTCERT")
    return errors


def write_private(path, template, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    content = template.read_text(encoding="utf-8")
    content = re.sub(
        r"^([A-Z][A-Z0-9_]*)=.*$",
        lambda m: m[1] + "=" + values[m[1]],
        content,
        flags=re.MULTILINE,
    )
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("x", encoding="utf-8", newline="\n") as stream:
        if os.name != "nt":
            os.chmod(temporary, 0o600)
        stream.write(content)
    temporary.replace(path)


def initialize(template=TEMPLATE, destination=PRIVATE):
    defaults, _ = contract(template)
    if destination.exists():
        return
    defaults["DJANGO_SECRET_KEY"] = secrets.token_urlsafe(64)
    write_private(destination, template, defaults)


def migrate():
    defaults, _ = contract(TEMPLATE)
    sources = [p for p in (PRIVATE, *LEGACY) if p.exists()]
    merged = {}
    for source in sources:
        for key, value in read_values(source).items():
            if key == "MOBILE_API_TOKEN":
                key = "PLACEMATCH_ENGINE_TOKEN"
            if key == "PUBLIC_GOOGLE_OAUTH_CLIENT_ID":
                key = "GOOGLE_OAUTH_CLIENT_ID"
            if key in RETIRED_DEFAULTS:
                if value in RETIRED_DEFAULTS[key]:
                    continue
                raise ContractError(f"Retired key needs private review: {key}")
            if key in MANAGED:
                continue
            if key not in defaults:
                raise ContractError(f"Legacy key needs a template decision: {key}")
            if key in merged and merged[key] and value and merged[key] != value:
                raise ContractError(f"Conflicting legacy values; resolve privately: {key}")
            if value or key not in merged:
                merged[key] = value
    defaults.update(merged)
    defaults["ENV_SCHEMA_VERSION"] = contract(TEMPLATE)[0]["ENV_SCHEMA_VERSION"]
    defaults["DJANGO_SECRET_KEY"] = defaults["DJANGO_SECRET_KEY"] or secrets.token_urlsafe(64)
    errors = problems(defaults, *contract(TEMPLATE), "local")
    if errors:
        raise ContractError("; ".join(errors))
    write_private(PRIVATE, TEMPLATE, defaults)
    if read_values(PRIVATE) != defaults:
        raise ContractError("Migration verification failed; legacy sources retained")
    for source in LEGACY:
        if source.exists():
            source.unlink()
    print("Consolidated local/.env; verified values before removing legacy env files.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "init", "migrate", "template"])
    parser.add_argument("--file", type=Path, default=PRIVATE)
    parser.add_argument("--template", type=Path, default=TEMPLATE)
    parser.add_argument("--profile", choices=["local", "production"], default="local")
    parser.add_argument("--reference", type=Path)
    args = parser.parse_args()
    try:
        defaults, tags = contract(args.template)
        if args.action == "template":
            if any(defaults[k] for k in tags.get("secret", ())):
                raise ContractError("Template secret placeholders must be empty")
            print(f"Valid public environment contract: {len(defaults)} keys")
            return 0
        if args.action == "migrate":
            migrate()
            return 0
        if args.action == "init":
            initialize(args.template, args.file)
        values = read_values(args.file)
        errors = problems(values, defaults, tags, args.profile)
        if args.reference:
            reference = read_values(args.reference)
            # The reference may be a production copy; compare schema/shared values,
            # without imposing this host's runtime profile on that other host.
            errors += problems(reference, defaults, tags, "local")
            mismatch = {
                k
                for k in defaults
                if k not in tags.get("override", ()) and values.get(k) != reference.get(k)
            }
            if mismatch:
                errors.append("Reference differs: " + ", ".join(sorted(mismatch)))
        if errors:
            raise ContractError("; ".join(errors))
        print(f"Environment contract valid ({args.profile}); no secret values displayed.")
        return 0
    except ContractError as error:
        print(str(error))
        return 1
    except (OSError, UnicodeError):
        print("Cannot read/write environment file; inspect its path, encoding and permissions.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
