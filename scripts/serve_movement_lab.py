#!/usr/bin/env python3
"""Serve only this experiment's built web assets; no backend proxy or data writes."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class LabHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/movement-lab")
            self.end_headers()
            return
        if path == "/movement-lab":
            self.path = "/index.html"
        if path.startswith(("/api", "/pipeline", "/accounts")):
            self.send_error(404)
            return
        super().do_GET()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4300)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parents[1] / "apps/web/dist/snapway-visitor/browser")
    args = parser.parse_args()
    if not (args.directory / "index.html").is_file():
        parser.error("Build apps/web first with npm run build:visitor.")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(LabHandler, directory=str(args.directory)))
    print(f"Motion lab: http://localhost:{args.port}/movement-lab (static assets only)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
