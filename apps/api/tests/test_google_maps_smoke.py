"""The Maps probe must never expose the rest of the shared private env file."""

import threading
from http.server import HTTPServer
from urllib.request import urlopen

from scripts import google_maps_smoke as probe


def test_probe_serves_only_allowlisted_browser_settings(tmp_path, monkeypatch):
    private = tmp_path / ".env"
    private.write_text(
        "PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY=synthetic-browser-key\n"
        "GOOGLE_MAPS_MAP_ID=DEMO_MAP_ID\n"
        "GOOGLE_OAUTH_CLIENT_SECRET=never-ship-oauth\n"
        "DATABASE_URL=never-ship-database\n"
    )
    monkeypatch.setattr(probe, "ENV_PATH", private)
    for key in ("PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY", "GOOGLE_MAPS_MAP_ID"):
        monkeypatch.delenv(key, raising=False)
    server = HTTPServer(("127.0.0.1", 0), probe.Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with urlopen(f"http://127.0.0.1:{server.server_port}/", timeout=5) as response:
            page = response.read().decode()
            assert response.headers["Cache-Control"] == "no-store"
        assert "synthetic-browser-key" in page
        assert "never-ship" not in page
        assert "GOOGLE_OAUTH_CLIENT_SECRET" not in page
        assert "__MAP_CONFIG__" not in page
    finally:
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()


def test_process_override_and_empty_map_id_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(probe, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.setenv("PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY", "synthetic-override")
    monkeypatch.setenv("GOOGLE_MAPS_MAP_ID", "")
    assert probe.read_config() == {"key": "synthetic-override", "mapId": "DEMO_MAP_ID"}
