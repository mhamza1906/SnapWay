"""Serve an isolated Google Maps browser probe without exposing server secrets."""

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / "local" / ".env"
HTML_PATH = Path(__file__).with_suffix(".html")


def read_config():
    values = {}
    if ENV_PATH.exists():
        for raw in ENV_PATH.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            name, separator, value = line.partition("=")
            if separator:
                values[name.strip()] = value.strip()
    # Explicit process overrides follow the application environment convention.
    for name in ("PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY", "GOOGLE_MAPS_MAP_ID"):
        if name in os.environ:
            values[name] = os.environ[name]
    return {
        "key": values.get("PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY", ""),
        "mapId": values.get("GOOGLE_MAPS_MAP_ID", "DEMO_MAP_ID") or "DEMO_MAP_ID",
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/":
            self.send_error(404)
            return
        # Only these two browser settings may leave the shared private file.
        config = json.dumps(read_config(), ensure_ascii=True).replace("<", "\\u003c")
        page = HTML_PATH.read_text(encoding="utf-8").replace("__MAP_CONFIG__", config)
        body = page.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Do not echo request paths, config values or browser credentials.
        return


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4201)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    configured = bool(read_config()["key"])
    print(f"Maps browser key: {'configured' if configured else 'missing'}")
    if args.check:
        return 0 if configured else 2
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Open http://127.0.0.1:{args.port}/ (Ctrl+C to stop)")
    print("Google requests start only after clicking Load Google Map.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
