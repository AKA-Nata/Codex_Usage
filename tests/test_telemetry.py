from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from codex_usage.telemetry import (
    build_telemetry,
    describe_weather,
    get_gpu_metrics,
    get_machine_metrics,
    get_weather,
)


GIB = 1024 ** 3


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

    @patch("codex_usage.telemetry.shutil.which", return_value=r"C:\\Windows\\nvidia-smi.exe")
    @patch("codex_usage.telemetry.subprocess.run")
    def test_get_gpu_metrics_parses_multiple_nvidia_devices(self, mock_run, _mock_which):
        mock_run.return_value = SimpleNamespace(
            returncode=0,
            stdout=(
                "NVIDIA RTX A, 34, 2048, 8192\n"
                "NVIDIA RTX B, 72, 4096, 8192\n"
            ),
            stderr="",
        )

        payload = get_gpu_metrics()

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["gpu_percent"], 72.0)
        self.assertEqual(payload["gpu_memory_percent"], 37.5)
        self.assertEqual(len(payload["devices"]), 2)

    @patch("codex_usage.telemetry.get_gpu_metrics")
    @patch("codex_usage.telemetry.get_windows_idle_seconds", return_value=12.0)
    @patch("codex_usage.telemetry.psutil")
    def test_machine_metrics_rejects_impossible_disk_capacity(
        self,
        mock_psutil,
        _mock_idle,
        mock_gpu,
    ):
        mock_psutil.cpu_percent.return_value = 28.0
        mock_psutil.cpu_count.return_value = 8
        mock_psutil.virtual_memory.return_value = SimpleNamespace(used=8 * GIB, total=16 * GIB)
        mock_psutil.disk_usage.return_value = SimpleNamespace(
            used=100 * GIB,
            total=8_589_934_592 * GIB,
        )
        mock_psutil.sensors_battery.return_value = None
        mock_gpu.return_value = {
            "status": "unavailable",
            "name": None,
            "gpu_percent": None,
            "gpu_memory_percent": None,
        }

        payload = get_machine_metrics()

        self.assertEqual(payload["status"], "partial")
        self.assertEqual(payload["memory_percent"], 50.0)
        self.assertIsNone(payload["disk_percent"])
        self.assertIsNone(payload["disk_total_gb"])
        self.assertIn("Disco retornou capacidade inválida", payload["message"])

    @patch("codex_usage.telemetry.get_gpu_metrics")
    @patch("codex_usage.telemetry.get_windows_idle_seconds", return_value=0.0)
    @patch("codex_usage.telemetry.psutil")
    def test_machine_metrics_exposes_optional_gpu_fields(
        self,
        mock_psutil,
        _mock_idle,
        mock_gpu,
    ):
        mock_psutil.cpu_percent.return_value = 12.0
        mock_psutil.cpu_count.return_value = 16
        mock_psutil.virtual_memory.return_value = SimpleNamespace(used=4 * GIB, total=16 * GIB)
        mock_psutil.disk_usage.return_value = SimpleNamespace(used=250 * GIB, total=1000 * GIB)
        mock_psutil.sensors_battery.return_value = None
        mock_gpu.return_value = {
            "status": "ok",
            "name": "NVIDIA RTX",
            "gpu_percent": 44.0,
            "gpu_memory_percent": 31.5,
        }

        payload = get_machine_metrics()

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["gpu_status"], "ok")
        self.assertEqual(payload["gpu_percent"], 44.0)
        self.assertEqual(payload["gpu_memory_percent"], 31.5)
        self.assertEqual(payload["disk_percent"], 25.0)


if __name__ == "__main__":
    unittest.main()
