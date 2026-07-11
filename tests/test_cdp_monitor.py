from __future__ import annotations

import logging
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex_usage.cdp_monitor import _interesting_response, main
from codex_usage.storage import atomic_write_json, read_json


class CdpMonitorTests(unittest.TestCase):
    def test_filters_usage_responses_without_matching_static_assets(self):
        self.assertTrue(_interesting_response("https://chatgpt.com/backend-api/wham/usage"))
        self.assertTrue(_interesting_response("https://chatgpt.com/backend-api/codex/analytics"))
        self.assertFalse(_interesting_response("https://chatgpt.com/cdn/assets/codex-analytics-tabs.css"))
        self.assertFalse(_interesting_response("https://chatgpt.com/backend-api/conversations"))

    def test_main_records_safe_health_error_without_overwriting_last_usage(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            usage_path = root / "codex-usage.json"
            health_path = root / "collector-health.json"
            last_valid_usage = {
                "status": "ok",
                "collected_at": "2026-07-11T12:00:00-03:00",
                "resets": {"limite_5h": {"remaining_percent": 42}},
            }
            atomic_write_json(usage_path, last_valid_usage)
            config = {
                "codex_usage_url": "https://chatgpt.com/codex/cloud/settings/analytics",
                "timezone": "America/Sao_Paulo",
                "output_json": str(usage_path),
                "health_json": str(health_path),
                "cdp_monitor": {"refresh_minutes": 5},
            }

            with (
                patch("codex_usage.cdp_monitor.load_config", return_value=config),
                patch("codex_usage.cdp_monitor.configure_logging", return_value=logging.getLogger("test")),
                patch(
                    "codex_usage.cdp_monitor.collect_from_open_tab",
                    side_effect=RuntimeError("token-super-secreto"),
                ),
                patch.object(sys, "argv", ["cdp_monitor"]),
            ):
                self.assertEqual(main(), 1)

            self.assertEqual(read_json(usage_path), last_valid_usage)
            health = read_json(health_path)
            self.assertEqual(health["status"], "error")
            self.assertTrue(health["checked_at"])
            self.assertEqual(health["consecutive_failures"], 1)
            self.assertNotIn("token-super-secreto", health["message"])


if __name__ == "__main__":
    unittest.main()
