from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

from dashboard_server import DashboardHandler
from codex_usage.storage import read_json


class DashboardIngestTests(unittest.TestCase):
    def test_local_bridge_requires_token_and_writes_sanitized_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token_path = root / "browser-bridge-token.txt"
            token_path.write_text("local-test-token\n", encoding="utf-8")
            config = {
                "timezone": "America/Sao_Paulo",
                "output_json": str(root / "usage.json"),
                "health_json": str(root / "health.json"),
                "browser_bridge_token_file": str(token_path),
                "dashboard": {},
            }
            server = ThreadingHTTPServer(("127.0.0.1", 0), DashboardHandler)
            server.app_config = config
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                payload = {
                    "extraction_mode": "browser_network",
                    "email": "not-persisted@example.com",
                    "resets": {
                        "limite_5h": {"remaining_percent": 12, "window_seconds": 18000},
                        "limite_semanal": {"remaining_percent": 80, "window_seconds": 604800},
                    },
                }
                request = Request(
                    f"http://127.0.0.1:{server.server_port}/api/ingest",
                    data=json.dumps(payload).encode("utf-8"),
                    method="POST",
                    headers={
                        "Content-Type": "application/json",
                        "X-Codex-Usage-Token": "local-test-token",
                    },
                )
                with urlopen(request, timeout=3) as response:
                    self.assertEqual(response.status, 200)
                usage = read_json(root / "usage.json", {})
                self.assertEqual(usage["resets"]["limite_5h"]["remaining_percent"], 12)
                self.assertNotIn("email", usage)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
