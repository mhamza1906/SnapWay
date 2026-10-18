#!/usr/bin/env python3
"""Isolated static motion lab with optional local CPU matching and read-only video replay."""

import argparse
import json
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class LabHandler(SimpleHTTPRequestHandler):
    matcher = None
    source_video = None

    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def reply(self, code, body):
        encoded = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def same_origin(self):
        origin = self.headers.get("Origin")
        return not origin or urlsplit(origin).netloc == self.headers.get("Host")

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/experiment-api/session":
            if not self.same_origin():
                self.reply(403, {"error": "Use this experiment page origin."})
            elif self.matcher is None:
                self.reply(503, {"error": "Local CPU matching was not enabled for this server."})
            else:
                try:
                    self.reply(200, {"sessionId": self.matcher.session()})
                except RuntimeError as error:
                    self.reply(429, {"error": str(error)})
            return
        if path == "/experiments/source-video.mov":
            self.video()
            return
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/movement-lab")
            self.end_headers()
            return
        if path == "/movement-lab":
            self.path = "/index.html"
        if path.startswith(("/api", "/pipeline", "/accounts", "/experiment-api")):
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != "/experiment-api/match":
            self.reply(404, {"error": "No application write APIs are exposed."})
            return
        if not self.same_origin():
            self.reply(403, {"error": "Use this experiment page origin."})
            return
        if self.matcher is None:
            self.reply(503, {"error": "Local CPU matching is unavailable."})
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "image/jpeg":
            self.reply(415, {"error": "Send image/jpeg."})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if size < 1 or size > 3_000_000:
            self.reply(413, {"error": "Send a JPEG under 3 MB."})
            return
        try:
            data = self.rfile.read(size)
            if len(data) != size:
                raise ValueError("Incomplete JPEG.")
            self.reply(200, self.matcher.match(self.headers.get("X-Lab-Session", ""), data))
        except PermissionError as error:
            self.reply(401, {"error": str(error)})
        except BlockingIOError as error:
            self.reply(429, {"error": str(error)})
        except (ValueError, OSError) as error:
            self.reply(422, {"error": str(error)[:180]})
        except Exception:
            self.reply(503, {"error": "The local matcher could not process this frame."})

    def video(self):
        path = self.source_video
        if not path or not path.is_file():
            self.send_error(404)
            return
        size = path.stat().st_size
        start, end = 0, size - 1
        header = self.headers.get("Range")
        if header:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", header)
            if not match:
                self.send_error(416)
                return
            start = int(match[1])
            end = min(int(match[2]) if match[2] else size - 1, size - 1, start + 8_388_607)
            if start >= size or end < start:
                self.send_error(416)
                return
        self.send_response(206 if header else 200)
        self.send_header(
            "Content-Type", "video/mp4" if path.suffix == ".mp4" else "video/quicktime"
        )
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with path.open("rb") as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    block = stream.read(min(131072, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)
        except (BrokenPipeError, ConnectionResetError):
            pass

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
    parser.add_argument(
        "--directory",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "apps/web/dist/snapway-visitor/browser",
    )
    parser.add_argument("--video", type=Path)
    parser.add_argument(
        "--run",
        type=Path,
        help="Existing MegaLoc-Video-Test cached embedding directory; opt-in CPU matching.",
    )
    parser.add_argument("--model-cache", type=Path)
    args = parser.parse_args()
    if not (args.directory / "index.html").is_file():
        parser.error("Build apps/web with npm run build:visitor.")
    LabHandler.source_video = args.video
    if args.run:
        if not args.model_cache:
            parser.error("--run needs --model-cache; no downloads are performed.")
        from movement_lab_matcher import LabMatcher

        LabHandler.matcher = LabMatcher(args.run.resolve(), args.model_cache.resolve())
    server = ThreadingHTTPServer(
        ("127.0.0.1", args.port), partial(LabHandler, directory=str(args.directory))
    )
    print(
        f"Motion lab: http://localhost:{args.port}/movement-lab; "
        f"CPU matching={LabHandler.matcher is not None}",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
