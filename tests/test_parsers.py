from __future__ import annotations

import json
import unittest
from pathlib import Path

from codex_usage.parsers import (
    classify_windows,
    parse_dom_text,
    parse_network_payload,
    parse_ptbr_reset,
)

ROOT = Path(__file__).resolve().parent.parent


class NetworkParserTests(unittest.TestCase):
    def setUp(self):
        self.payload = json.loads(
            (ROOT / "tests" / "fixtures" / "usage_payload.json").read_text(encoding="utf-8")
        )

    def test_parses_observed_usage_contract(self):
        result = parse_network_payload(self.payload, "America/Sao_Paulo", "network_observed")
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["limit_reached"])
        self.assertFalse(result["allowed"])
        self.assertEqual(result["resets"]["limite_5h"]["remaining_percent"], 14)
        self.assertEqual(result["resets"]["limite_semanal"]["remaining_percent"], 0)
        self.assertEqual(result["resets"]["limite_5h"]["window_seconds"], 18000)
        self.assertEqual(result["resets"]["limite_semanal"]["window_seconds"], 604800)
        self.assertEqual(result["resets"]["limite_5h"]["reset_at"], "2026-07-09T18:31:10-03:00")
        self.assertEqual(result["resets"]["limite_semanal"]["reset_at"], "2026-07-13T15:11:31-03:00")

    def test_classifies_windows_by_duration_when_names_change(self):
        payload = {
            "unknown": {
                "b": self.payload["rate_limit"]["secondary_window"],
                "a": self.payload["rate_limit"]["primary_window"],
            }
        }
        primary, secondary = classify_windows(payload)
        self.assertEqual(primary["limit_window_seconds"], 18000)
        self.assertEqual(secondary["limit_window_seconds"], 604800)


class DomParserTests(unittest.TestCase):
    def test_parses_cards_from_body_text(self):
        body = """
        Analítica do Codex
        Limite de uso atingido
        Limite de uso de 5 horas
        14% restantes
        Redefinição 18:31
        Limite de uso semanal
        0% restantes
        Redefinição 13 de jul. de 2026 15:11
        Créditos restantes
        0
        """
        result = parse_dom_text(body, "America/Sao_Paulo")
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["limit_reached"])
        self.assertEqual(result["resets"]["limite_5h"]["remaining_percent"], 14)
        self.assertEqual(result["resets"]["limite_semanal"]["remaining_percent"], 0)
        self.assertEqual(
            result["resets"]["limite_semanal"]["reset_at"],
            "2026-07-13T15:11:00-03:00",
        )

    def test_parses_long_ptbr_date(self):
        self.assertEqual(
            parse_ptbr_reset("13 de jul. de 2026 15:11", "America/Sao_Paulo"),
            "2026-07-13T15:11:00-03:00",
        )


if __name__ == "__main__":
    unittest.main()
