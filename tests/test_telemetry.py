from __future__ import annotations

import unittest
from unittest.mock import patch

from codex_usage.telemetry import build_telemetry, describe_weather, get_weather


class TelemetryTests(unittest.TestCase):
    def test_describe_known_weather_code(self):
        description = describe_weather(0)
        self.assertEqual(description.label, "Céu limpo")
        self.assertEqual(description.icon, "☀")

    def test_describe_unknown_weather_code(self):
        description = describe_weather(12345)
        self.assertEqual(description.label, "Condição não identificada")

    def test_weather_can_be_disabled_without_network(self):
        payload = get_weather({"enabled": False, "location_label": "Teste"})
        self.assertEqual(payload["status"], "disabled")
        self.assertEqual(payload["location"], "Teste")

    @patch("codex_usage.telemetry.get_machine_metrics")
    @patch("codex_usage.telemetry.get_weather")
    def test_build_telemetry_contract(self, mock_weather, mock_machine):
        mock_machine.return_value = {"status": "ok", "cpu_percent": 20.0}
        mock_weather.return_value = {"status": "ok", "temperature_c": 24.0}
        payload = build_telemetry({"timezone": "America/Sao_Paulo", "weather": {"enabled": True}})
        self.assertIn("generated_at", payload)
        self.assertIn("clock", payload)
        self.assertEqual(payload["machine"]["cpu_percent"], 20.0)
        self.assertEqual(payload["weather"]["temperature_c"], 24.0)


if __name__ == "__main__":
    unittest.main()
