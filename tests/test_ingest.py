from __future__ import annotations

import unittest

from codex_usage.ingest import normalize_browser_payload


class BrowserIngestTests(unittest.TestCase):
    def test_normalizes_only_the_display_schema(self):
        result = normalize_browser_payload(
            {
                "extraction_mode": "browser_network",
                "allowed": True,
                "email": "must-not-be-persisted@example.com",
                "resets": {
                    "limite_5h": {
                        "remaining_percent": 14,
                        "window_seconds": 18_000,
                        "reset_at": "2026-07-10T18:31:10-03:00",
                        "account_id": "must-not-be-persisted",
                    },
                    "limite_semanal": {"used_percent": 100, "window_seconds": 604_800},
                },
            },
            "America/Sao_Paulo",
        )
        self.assertEqual(result["resets"]["limite_5h"]["used_percent"], 86)
        self.assertEqual(result["resets"]["limite_semanal"]["remaining_percent"], 0)
        self.assertNotIn("email", result)
        self.assertNotIn("account_id", str(result))

    def test_rejects_empty_browser_payload(self):
        with self.assertRaises(ValueError):
            normalize_browser_payload({"resets": {}}, "America/Sao_Paulo")


if __name__ == "__main__":
    unittest.main()
