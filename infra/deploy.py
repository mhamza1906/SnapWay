#!/usr/bin/python3
"""Root-owned native release controller. Install only after reviewing this file."""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path("/srv/indoor-nav")
CONFIG = Path("/etc/indoor-nav")
CADDY = Path("/etc/caddy/Caddyfile")
USER = "snapwaydeploy"
APP_USER = "snapway"
UV = "/usr/local/bin/uv"
RELEASE_PATTERN = re.compile(r"[0-9a-f]{40}-[0-9]+-[0-9]+")
MIGRATION_ENTRYPOINT = """
import os
import runpy

connection = os.environ.pop("DATABASE_MIGRATOR", "").strip()
if not connection:
    raise SystemExit("DATABASE_MIGRATOR must be configured in api.env for migrations")
os.environ["DATABASE_URL"] = connection
runpy.run_path("apps/api/manage.py", run_name="__main__")
"""


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def release_path(release_id):
    if not RELEASE_PATTERN.fullmatch(release_id):
        raise ValueError("Expected <40-character-commit>-<run-id>-<attempt>")
    path = ROOT / "releases" / release_id
    if path.resolve() != path or not path.is_dir():
        raise ValueError("Release must be a real directory directly under releases")
    return path


def receive_release(release_id):
    if not RELEASE_PATTERN.fullmatch(release_id):
        raise ValueError("Invalid release ID")
    destination = ROOT / "releases" / release_id
    if destination.exists():
        if not (CONFIG / "received" / release_id).is_file():
            raise ValueError("Incomplete release directory; use a new run attempt")
        return release_path(release_id)
    incoming = ROOT / "incoming" / release_id
    if incoming.resolve() != incoming or not incoming.is_dir():
        raise ValueError("Missing incoming release directory")
    destination.mkdir(mode=0o755)
    shutil.chown(destination, user=USER, group=USER)
    # Copy as the uploader, never as root: a malicious upload cannot read root files.
    run(
        "runuser",
        "-u",
        USER,
        "--",
        "cp",
        "-R",
        "--no-dereference",
        "--no-preserve=ownership",
        str(incoming) + "/.",
        str(destination),
    )
    # Lock parents before examining their children; root-owned releases are immutable
    # to both the upload identity and the unprivileged application identity.
    for directory, folders, files in os.walk(destination, followlinks=False):
        parent = Path(directory)
        if parent.is_symlink():
            raise ValueError("Release directories must not be symbolic links")
        os.chown(parent, 0, 0, follow_symlinks=False)
        parent.chmod(0o755)
        for name in folders + files:
            file = parent / name
            mode = file.lstat().st_mode
            if not stat.S_ISDIR(mode) and not stat.S_ISREG(mode):
                raise ValueError("Only regular files and directories are permitted")
            os.chown(file, 0, 0, follow_symlinks=False)
            file.chmod(0o755 if stat.S_ISDIR(mode) or mode & 0o111 else 0o644)
    (CONFIG / "received").mkdir(mode=0o700, exist_ok=True)
    (CONFIG / "received" / release_id).write_text("received\n")
    return destination


def tree_digest(path):
    digest = hashlib.sha256()
    for file in sorted(path.rglob("*")):
        if file.is_symlink():
            raise ValueError("Release components must not contain symbolic links")
        if (
            file.is_file()
            and "__pycache__" not in file.parts
            and file.suffix.lower() not in {".pyc", ".md", ".rst"}
        ):
            digest.update(file.relative_to(path).as_posix().encode() + b"\0")
            digest.update(hashlib.sha256(file.read_bytes()).digest())
    return digest.hexdigest()


def dependency_key(source):
    digest = hashlib.sha256()
    digest.update(platform.machine().encode())
    digest.update(Path("/etc/os-release").read_bytes())
    digest.update(subprocess.check_output([UV, "--version"]))
    digest.update(b"--no-dev --extra ai --extra geometry --extra mcp")
    for name in ("uv.lock", "pyproject.toml", ".python-version"):
        digest.update((source / name).read_bytes())
    return digest.hexdigest()


def service_env(state):
    return {
        "DJANGO_SETTINGS_MODULE": "config.settings.production",
        "APP_RELEASE": state["backend_release"].split("-")[0],
        "STATIC_ROOT": str(ROOT / "shared/static" / state["backend_release"]),
        "STATIC_URL": f"/django-static/{state['backend_release']}/",
        "PYTHONPATH": ":".join(
            str(ROOT / "releases" / state["backend_release"] / "source" / name)
            for name in ("apps/api", "packages", ".")
        ),
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def django(state, command, *, migration=False):
    # systemd reads the root-only secret file, then executes application code as USER.
    source = ROOT / "releases" / state["backend_release"] / "source"
    args = [
        "systemd-run",
        "--quiet",
        "--wait",
        "--pipe",
        "--collect",
        f"--uid={APP_USER}",
        f"--gid={APP_USER}",
        f"--working-directory={source}",
        "--property=NoNewPrivileges=yes",
        f"--property=EnvironmentFile={CONFIG / 'api.env'}",
    ]
    if not migration:
        args.append("--property=UnsetEnvironment=DATABASE_MIGRATOR")
    args.extend(f"--setenv={key}={value}" for key, value in service_env(state).items())
    entrypoint = ["-c", MIGRATION_ENTRYPOINT] if migration else ["apps/api/manage.py"]
    run(*args, str(ROOT / "venvs" / state["venv"] / "bin/python"), *entrypoint, *command)


def api_unit(state):
    source = ROOT / "releases" / state["backend_release"] / "source"
    environment = "\n".join(f"Environment={k}={v}" for k, v in service_env(state).items())
    command = (
        f"{ROOT}/venvs/{state['venv']}/bin/gunicorn --chdir {source}/apps/api"
        f" config.wsgi:application --bind 127.0.0.1:{state['port']}"
        " --workers 2 --threads 2 --timeout 60 --graceful-timeout 30"
        " --access-logfile - --error-logfile -"
    )
    return f"""[Unit]
Description=SnapWay API {state["slot"]}
After=network-online.target
Wants=network-online.target

[Service]
User={APP_USER}
Group={APP_USER}
WorkingDirectory={source}
EnvironmentFile={CONFIG}/api.env
UnsetEnvironment=DATABASE_MIGRATOR
{environment}
ExecStart={command}
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=75
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths={ROOT}/shared/media {ROOT}/shared/indexes
UMask=0027

[Install]
WantedBy=multi-user.target
"""


def caddy_config(state, domain):
    return f"""{domain}, www.{domain} {{
    encode zstd gzip
    @django path /api /api/* /accounts /accounts/* /admin /admin/*
    handle @django {{
        reverse_proxy 127.0.0.1:{state["port"]} {{
            header_up X-Forwarded-Proto {{scheme}}
        }}
    }}
    handle_path /django-static/* {{
        root * {ROOT}/shared/static
        file_server
    }}
    @private path /media /media/* /mcp /mcp/*
    handle @private {{
        respond 404
    }}
    handle {{
        header Cache-Control "no-cache"
        route {{
            root * {ROOT}/releases/{state["web_release"]}/web
            file_server {{
                pass_thru
            }}
            root * {ROOT}/shared/web-assets
            file_server {{
                pass_thru
            }}
            root * {ROOT}/releases/{state["web_release"]}/web
            try_files {{path}} /index.html
            file_server
        }}
    }}
}}
"""


def probe(state, domain, *, public=False):
    base = f"https://{domain}" if public else f"http://127.0.0.1:{state['port']}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(30):
        try:
            for endpoint in ("live", "ready"):
                request = urllib.request.Request(
                    f"{base}/api/health/{endpoint}/",
                    headers={"Host": domain, "X-Forwarded-Proto": "https"},
                )
                with opener.open(request, timeout=3) as response:
                    body = json.load(response)
                if (
                    endpoint == "live"
                    and body.get("release") != state["backend_release"].split("-")[0]
                ):
                    raise ValueError("Health response belongs to a different backend commit")
                if endpoint == "ready" and body.get("status") != "ready":
                    raise ValueError("Database readiness failed")
            if public:
                with opener.open(f"{base}/", timeout=5) as response:
                    if (
                        response.read()
                        != (
                            ROOT / "releases" / state["web_release"] / "web/index.html"
                        ).read_bytes()
                    ):
                        raise ValueError("Public frontend does not match the candidate release")
            return
        except (OSError, ValueError, urllib.error.URLError):
            if attempt == 29:
                raise RuntimeError("Release health verification failed") from None
            time.sleep(2)


def start_api(state):
    name = f"snapway-api-{state['slot']}.service"
    Path(f"/etc/systemd/system/{name}").write_text(api_unit(state))
    run("systemctl", "daemon-reload")
    run("systemctl", "restart", name)


def select_current(release):
    current = ROOT / "current.next"
    current.unlink(missing_ok=True)
    if release is None:
        (ROOT / "current").unlink(missing_ok=True)
        return
    current.symlink_to(release)
    current.replace(ROOT / "current")


def require_secret_file(file):
    if not file.is_file():
        raise ValueError(f"Missing protected environment file: {file}")
    metadata = file.stat()
    if metadata.st_uid != 0 or metadata.st_mode & 0o077:
        raise ValueError(f"{file} must be owned by root, mode 0600")


def activate(release_id, *, rollback=False):
    release = receive_release(release_id)
    manifest = json.loads((release / "release.json").read_text())
    if manifest != {"release": release_id, "commit": release_id.split("-")[0]}:
        raise ValueError("Unexpected release manifest")
    domain = (CONFIG / "domain").read_text().strip()
    if not re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)+", domain):
        raise ValueError("Invalid deployment domain")
    require_secret_file(CONFIG / "api.env")
    source = release / "source"
    backend_hash = tree_digest(source)
    web_hash = tree_digest(release / "web")
    if not (release / "web/index.html").is_file():
        raise ValueError("Frontend index.html is missing")
    active_file = CONFIG / "active.json"
    old = json.loads(active_file.read_text()) if active_file.exists() else None
    backend_changed = not old or old["backend_hash"] != backend_hash
    web_changed = not old or old["web_hash"] != web_hash
    if old and not backend_changed and not web_changed:
        print("Identical deployed components; no switch or process restart required.")
        return
    state = dict(old or {})
    state.update(release=release_id, backend_hash=backend_hash, web_hash=web_hash)
    if web_changed:
        state["web_release"] = release_id
    if backend_changed:
        slot = "green" if old and old["slot"] == "blue" else "blue"
        key = dependency_key(source)
        state.update(
            backend_release=release_id, venv=key, slot=slot, port=8101 if slot == "blue" else 8102
        )
        venv = ROOT / "venvs" / key
        if not (venv / ".complete").exists():
            run(
                "runuser",
                "-u",
                USER,
                "--",
                "env",
                f"UV_PROJECT_ENVIRONMENT={venv}",
                f"UV_PYTHON_INSTALL_DIR={ROOT}/python",
                UV,
                "sync",
                "--locked",
                "--no-dev",
                "--extra",
                "ai",
                "--extra",
                "geometry",
                "--extra",
                "mcp",
                "--python",
                (source / ".python-version").read_text().strip(),
                cwd=source,
            )
            run("runuser", "-u", USER, "--", "touch", str(venv / ".complete"))
        static = ROOT / "shared/static" / release_id
        static.mkdir(mode=0o755, exist_ok=True)
        shutil.chown(static, user=APP_USER, group=APP_USER)
        django(state, ["check", "--deploy", "--fail-level", "ERROR"])
        if not rollback:
            django(state, ["migrate", "--noinput"], migration=True)
        django(state, ["collectstatic", "--noinput"])
        start_api(state)
    previous_caddy = CADDY.read_bytes()
    switched = False
    try:
        probe(state, domain)
        # Retain previous browser chunks; never expose private media or source files.
        assets = ROOT / "shared/web-assets"
        for file in (release / "web").rglob("*"):
            if file.is_file() and file.suffix.lower() != ".html":
                target = assets / file.relative_to(release / "web")
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, target)
                target.chmod(0o644)
        candidate = CONFIG / "candidate.Caddyfile"
        candidate.write_text(caddy_config(state, domain))
        run("caddy", "validate", "--config", str(candidate), "--adapter", "caddyfile")
        try:
            # Write in the same directory so replacing the Caddyfile is atomic.
            temporary = CADDY.with_suffix(".next")
            temporary.write_bytes(candidate.read_bytes())
            temporary.chmod(0o644)
            temporary.replace(CADDY)
            switched = True
            run("systemctl", "reload", "caddy")
            probe(state, domain, public=True)
        except BaseException:
            CADDY.write_bytes(previous_caddy)
            run("systemctl", "reload", "caddy")
            raise
        run("systemctl", "enable", f"snapway-api-{state['slot']}.service")
        if old:
            (CONFIG / "previous.json").write_text(json.dumps(old, indent=2) + "\n")
        select_current(release)
        pending = CONFIG / "active.next"
        pending.write_text(json.dumps(state, indent=2) + "\n")
        pending.replace(active_file)
    except BaseException:
        if switched:
            CADDY.write_bytes(previous_caddy)
            run("systemctl", "reload", "caddy")
            select_current(ROOT / "releases" / old["release"] if old else None)
        if backend_changed:
            run("systemctl", "disable", "--now", f"snapway-api-{state['slot']}.service")
        raise
    if old and backend_changed:
        # Gunicorn TERM drains requests; the old slot remains available for rollback.
        try:
            run("systemctl", "disable", "--now", f"snapway-api-{old['slot']}.service")
        except subprocess.CalledProcessError:
            print("Release is healthy, but the previous slot needs manual drain/disable.")
    print(f"Activated {release_id}; backend_changed={backend_changed}, web_changed={web_changed}")


def main():
    import fcntl  # Linux-only; kept here so rendering/validation tests work on Windows.

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release")
    parser.add_argument(
        "--rollback",
        action="store_true",
        help="Skip migrations; operator must first verify schema compatibility",
    )
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Use the installed root-owned controller through sudo")
    with Path("/run/lock/snapway-deploy.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        activate(args.release, rollback=args.rollback)


if __name__ == "__main__":
    main()
