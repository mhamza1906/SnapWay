"""Run the unmodified imagegen CLI through a single-request metering relay.

No SDK generation runner or skill modification. Only the relay holds the real
credential; its loopback client uses an ephemeral token. No headers are logged.
"""

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "local/test-results/gpt-fullchain-2026-10-17"
CLI = (
    Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    / "skills/.system/imagegen/scripts/image_gen.py"
)


def main():
    live = "--live" in sys.argv
    if not live:
        raise SystemExit("Explicit --live required")
    if (OUT / "optimized-floor.png").exists():
        raise SystemExit("Image output exists; refusing paid rerun")
    config = dotenv_values(ROOT / "local/.env")
    key = os.environ.get("OPENAI_API_KEY", config.get("OPENAI_API_KEY"))
    if not key:
        raise SystemExit("Fill OPENAI_API_KEY in ignored local/.env")
    token = "local-meter-" + uuid.uuid4().hex
    record = {
        "stage": "image-edit",
        "requestedModel": "gpt-image-2.5-sunburst",
        "quality": "high",
        "size": "1536x1024",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "started",
        "maximumUpstreamRequests": 1,
        "usage": None,
    }
    attempted = False

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            nonlocal attempted
            if (
                self.path != "/v1/images/edits"
                or self.headers.get("Authorization") != "Bearer " + token
                or attempted
            ):
                self.send_error(400, "Only one authorized image-edit request is allowed")
                return
            attempted = True
            data = self.rfile.read(int(self.headers["Content-Length"]))
            req = urllib.request.Request(
                "https://api.openai.com/v1/images/edits",
                data=data,
                headers={
                    "Authorization": "Bearer " + key,
                    "Content-Type": self.headers["Content-Type"],
                },
                method="POST",
            )
            started = time.perf_counter()
            try:
                with urllib.request.urlopen(req, timeout=650) as r:
                    code = r.status
                    body = r.read()
            except urllib.error.HTTPError as e:
                code = e.code
                body = e.read()
            except Exception as e:
                code = 502
                body = json.dumps(
                    {
                        "error": {
                            "message": "Upstream request failed; no automatic paid retry",
                            "type": type(e).__name__,
                        }
                    }
                ).encode()
            record["httpStatus"] = code
            record["latencyMs"] = round((time.perf_counter() - started) * 1000)
            try:
                raw = json.loads(body)
                record["usage"] = raw.get("usage")
                record["returnedModel"] = raw.get("model")
                record["returnedSize"] = raw.get("size")
                record["returnedQuality"] = raw.get("quality")
                # Metadata only; avoid duplicating base64 image blobs or secret headers.
                metadata = {k: v for k, v in raw.items() if k != "data"}
                metadata["imageCount"] = len(raw.get("data", []))
                (OUT / "image-response-metadata.json").write_text(
                    json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
                )
                u = record["usage"]
                if u:
                    details = u.get("input_tokens_details", {})
                    text = details.get("text_tokens")
                    image = details.get("image_tokens")
                    output = u.get("output_tokens")
                    record["estimatedUndiscountedUsd"] = (
                        (text * 5 + image * 8 + output * 30) / 1e6
                        if None not in [text, image, output]
                        else None
                    )
                record["status"] = "completed" if code == 200 else "failed"
            except Exception:
                record["status"] = "metadata-unavailable"
            (OUT / "image-ledger.json").write_text(
                json.dumps(record, indent=2) + "\n", encoding="utf-8"
            )
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = os.environ.copy()
    env["OPENAI_API_KEY"] = token
    env["OPENAI_BASE_URL"] = f"http://127.0.0.1:{server.server_port}/v1"
    env.pop("OPENAI_LOG", None)
    command = [
        sys.executable,
        str(CLI),
        "edit",
        "--model",
        "gpt-image-2.5-sunburst",
        "--image",
        str(OUT / "original-floor.png"),
        "--prompt-file",
        str(OUT / "raster-prompt.txt"),
        "--quality",
        "high",
        "--size",
        "1536x1024",
        "--background",
        "opaque",
        "--output-format",
        "png",
        "--out",
        str(OUT / "optimized-floor.png"),
    ]
    try:
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=700)
        record["cliExitCode"] = result.returncode
        record["outputExists"] = (OUT / "optimized-floor.png").exists()
        # The client sees only a temporary relay token, still redact it in logs.
        log = (
            (result.stdout + "\n" + result.stderr)
            .replace(token, "[REDACTED]")
            .replace(key, "[REDACTED]")
        )
        (OUT / "image-cli.log").write_text(log, encoding="utf-8")
    finally:
        record["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        (OUT / "image-ledger.json").write_text(
            json.dumps(record, indent=2) + "\n", encoding="utf-8"
        )
        server.shutdown()
    print(json.dumps(record))
    if not record.get("outputExists"):
        raise SystemExit("Image CLI did not produce output; inspect private metadata/log")


if __name__ == "__main__":
    main()
