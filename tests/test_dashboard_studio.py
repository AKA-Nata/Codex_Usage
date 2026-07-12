from __future__ import annotations

import http.client
import json
import shutil
import tempfile
import threading
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from codex_usage.behavior_studio import BehaviorStudioService
from dashboard_server import DashboardHandler, ThreadingHTTPServer


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OFFICIAL_CONFIG_PATH = PROJECT_ROOT / "web" / "config" / "sprite-behaviors.json"
OFFICIAL_SCHEMA_PATH = PROJECT_ROOT / "web" / "config" / "sprite-behaviors.schema.json"
OFFICIAL_DEFAULT_PATH = PROJECT_ROOT / "web" / "config" / "sprite-behaviors.default.json"
_MISSING = object()


class QuietDashboardHandler(DashboardHandler):
    def log_message(self, _format, *_args):
        pass


class DashboardStudioHttpTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.config_dir = self.root / "config"
        self.config_dir.mkdir()
        self.config_path = self.config_dir / "sprite-behaviors.json"
        self.schema_path = self.config_dir / "sprite-behaviors.schema.json"
        self.default_config_path = self.config_dir / "sprite-behaviors.default.json"
        self.runtime_dir = self.root / "runtime"
        self.usage_path = self.root / "codex-usage.json"
        self.health_path = self.root / "collector-health.json"

        shutil.copyfile(OFFICIAL_CONFIG_PATH, self.config_path)
        shutil.copyfile(OFFICIAL_SCHEMA_PATH, self.schema_path)
        shutil.copyfile(OFFICIAL_DEFAULT_PATH, self.default_config_path)
        self.usage_path.write_text(
            json.dumps(
                {
                    "collected_at": "2026-07-12T11:59:00+00:00",
                    "resets": {
                        "limite_5h": {
                            "remaining_percent": 37,
                            "reset_at": "2026-07-12T13:01:01+00:00",
                            "limit_reached": True,
                        },
                        "limite_semanal": {"remaining_percent": 82, "limit_reached": False},
                    },
                }
            ),
            encoding="utf-8",
        )
        self.health_path.write_text(json.dumps({"status": "ok"}), encoding="utf-8")

        self.service = BehaviorStudioService(
            config_path=self.config_path,
            schema_path=self.schema_path,
            default_config_path=self.default_config_path,
            runtime_dir=self.runtime_dir,
        )
        self.app_config = {
            "output_json": str(self.usage_path),
            "health_json": str(self.health_path),
            "timezone": "America/Sao_Paulo",
            "stale_after_minutes": 45,
            "dashboard": {
                "host": "127.0.0.1",
                "port": 0,
                "allow_remote": False,
                "auto_refresh_seconds": 60,
                "telemetry_refresh_seconds": 5,
            },
            "weather": {"enabled": False},
        }
        self.telemetry = {
            "generated_at": "2026-07-12T12:00:00+00:00",
            "clock": {
                "iso": "2026-07-12T09:00:00-03:00",
                "time": "09:00:00",
                "date": "12/07/2026",
            },
            "machine": {
                "status": "ok",
                "cpu_percent": 42.5,
                "memory_percent": None,
                "disk_percent": 25.0,
                "gpu_percent": None,
                "gpu_memory_percent": None,
            },
            "weather": {
                "status": "ok",
                "temperature_c": 24.0,
                "condition": "Ensolarado",
            },
        }
        self.telemetry_patcher = patch("dashboard_server.build_telemetry", return_value=self.telemetry)
        self.telemetry_patcher.start()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietDashboardHandler)
        self.server.daemon_threads = True
        self.server.app_config = self.app_config
        self.server.studio_service = self.service
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.port = self.server.server_address[1]
        self.authority = f"127.0.0.1:{self.port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=5)
        self.telemetry_patcher.stop()
        self.temporary_directory.cleanup()

    def read_disk_config(self):
        return json.loads(self.config_path.read_text(encoding="utf-8"))

    def request(
        self,
        method,
        path,
        *,
        json_body=_MISSING,
        raw_body=None,
        headers=None,
    ):
        request_headers = dict(headers or {})
        body = raw_body
        if json_body is not _MISSING:
            body = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            response_body = response.read()
            response_headers = {key.lower(): value for key, value in response.getheaders()}
            payload = None
            if response_body and "application/json" in response_headers.get("content-type", ""):
                payload = json.loads(response_body.decode("utf-8"))
            return response.status, response_headers, payload, response_body
        finally:
            connection.close()

    def test_get_config_schema_export_and_empty_history(self):
        status, config_headers, config_payload, _body = self.request("GET", "/api/studio/config")
        self.assertEqual(status, 200)
        self.assertEqual(config_headers["x-frame-options"], "DENY")
        self.assertIn("frame-ancestors 'none'", config_headers["content-security-policy"])
        self.assertTrue(config_payload["valid"], config_payload["errors"])
        self.assertEqual(config_payload["config"], self.read_disk_config())
        self.assertEqual(len(config_payload["revision"]), 64)

        status, _headers, schema_payload, _body = self.request("GET", "/api/studio/schema")
        self.assertEqual(status, 200)
        self.assertEqual(schema_payload["$schema"], "https://json-schema.org/draft/2020-12/schema")

        status, headers, export_payload, body = self.request("GET", "/api/studio/config/export")
        self.assertEqual(status, 200)
        self.assertEqual(export_payload, config_payload["config"])
        self.assertEqual(
            headers["content-disposition"],
            'attachment; filename="sprite-behaviors.json"',
        )
        self.assertTrue(body.endswith(b"\n"))

        status, _headers, history_payload, _body = self.request("GET", "/api/studio/history")
        self.assertEqual(status, 200)
        self.assertEqual(history_payload, {"entries": []})

    def test_get_macros_uses_safe_real_data_and_fallbacks(self):
        status, _headers, payload, _body = self.request("GET", "/api/studio/macros")

        self.assertEqual(status, 200)
        macros = {item["macro"]: item for item in payload["macros"]}
        self.assertEqual(macros["cpu"]["value"], 42.5)
        self.assertEqual(macros["cpu"]["displayValue"], "42.5")
        self.assertTrue(macros["cpu"]["available"])
        self.assertIsNone(macros["ram"]["value"])
        self.assertFalse(macros["ram"]["available"])
        self.assertEqual(macros["ram"]["displayValue"], self.read_disk_config()["macros"]["ram"]["fallback"])
        self.assertEqual(macros["codex_5h_percentual"]["value"], 37)
        self.assertEqual(macros["codex_5h_atingido"]["value"], True)
        self.assertEqual(macros["codex_semanal_atingido"]["value"], False)
        self.assertTrue(macros["codex_semanal_atingido"]["available"])
        self.assertEqual(macros["coleta_status"]["value"], "ok")
        allowed_fields = {
            "macro", "token", "description", "origin", "type", "unit",
            "fallback", "value", "displayValue", "available",
        }
        self.assertTrue(all(set(item) <= allowed_fields for item in payload["macros"]))
        self.assertTrue(all(item["token"] == f"{{{{{item['macro']}}}}}" for item in payload["macros"]))
        serialized = json.dumps(payload, ensure_ascii=False).lower()
        self.assertNotIn("cookie", serialized)
        self.assertNotIn("profile", serialized)
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("websocketdebuggerurl", serialized)

    def test_validate_reports_valid_and_invalid_without_persisting(self):
        original_bytes = self.config_path.read_bytes()
        config = self.read_disk_config()

        status, _headers, valid_payload, _body = self.request(
            "POST",
            "/api/studio/config/validate",
            json_body={"config": config},
        )
        self.assertEqual(status, 200)
        self.assertEqual(valid_payload, {"valid": True, "errors": []})

        invalid = deepcopy(config)
        invalid["metadata"]["version"] = "versao-invalida"
        status, _headers, invalid_payload, _body = self.request(
            "POST",
            "/api/studio/config/validate",
            json_body={"config": invalid},
        )
        self.assertEqual(status, 200)
        self.assertFalse(invalid_payload["valid"])
        self.assertTrue(invalid_payload["errors"])
        self.assertEqual(self.config_path.read_bytes(), original_bytes)

    def test_put_saves_valid_configuration_and_creates_backup(self):
        initial = self.service.read_config()
        modified = deepcopy(initial["config"])
        modified["metadata"]["description"] = "Configuracao salva pela API HTTP."

        status, _headers, payload, _body = self.request(
            "PUT",
            "/api/studio/config",
            json_body={"config": modified, "expectedRevision": initial["revision"]},
        )

        self.assertEqual(status, 200)
        self.assertTrue(payload["valid"])
        self.assertNotEqual(payload["revision"], initial["revision"])
        self.assertEqual(payload["config"], modified)
        self.assertEqual(self.read_disk_config(), modified)
        self.assertTrue((self.service.backup_dir / payload["backup"]).is_file())

    def test_invalid_put_returns_422_and_preserves_official_configuration(self):
        initial = self.service.read_config()
        original_bytes = self.config_path.read_bytes()
        invalid = deepcopy(initial["config"])
        invalid["metadata"]["version"] = "invalida"

        status, _headers, payload, _body = self.request(
            "PUT",
            "/api/studio/config",
            json_body={"config": invalid, "expectedRevision": initial["revision"]},
        )

        self.assertEqual(status, 422)
        self.assertTrue(payload["errors"])
        self.assertEqual(self.config_path.read_bytes(), original_bytes)
        self.assertFalse(self.service.backup_dir.exists())

        for mutate in ("empty_character_map", "missing_casual_ref", "wrong_types"):
            invalid_import = deepcopy(initial["config"])
            if mutate == "empty_character_map":
                invalid_import["triggers"][0]["characterPhrases"] = {}
            elif mutate == "missing_casual_ref":
                invalid_import["defaultBehavior"]["casualSpeech"]["phraseIds"] = ["missing_group"]
            else:
                invalid_import["triggers"][0]["phraseRefs"] = 7
            import_status, _headers, import_payload, _body = self.request(
                "POST",
                "/api/studio/config/import",
                json_body={"config": invalid_import, "expectedRevision": initial["revision"]},
            )
            self.assertEqual(import_status, 422, mutate)
            self.assertTrue(import_payload["errors"])
            self.assertEqual(self.config_path.read_bytes(), original_bytes)

    def test_revision_conflict_returns_409_and_preserves_official_configuration(self):
        original_bytes = self.config_path.read_bytes()
        modified = self.read_disk_config()
        modified["metadata"]["description"] = "Nao deve ser salva."

        status, _headers, payload, _body = self.request(
            "PUT",
            "/api/studio/config",
            json_body={"config": modified, "expectedRevision": "0" * 64},
        )

        self.assertEqual(status, 409)
        self.assertIn("mudou", payload["error"])
        self.assertEqual(self.config_path.read_bytes(), original_bytes)
        self.assertFalse(self.service.backup_dir.exists())

    def test_import_then_restore_default_round_trip(self):
        initial = self.service.read_config()
        imported = deepcopy(initial["config"])
        imported["metadata"]["description"] = "Configuracao importada pela API."

        status, _headers, import_payload, _body = self.request(
            "POST",
            "/api/studio/config/import",
            json_body={"config": imported, "expectedRevision": initial["revision"]},
        )
        self.assertEqual(status, 200)
        self.assertEqual(import_payload["config"], imported)
        self.assertEqual(self.read_disk_config(), imported)

        status, _headers, restore_payload, _body = self.request(
            "POST",
            "/api/studio/config/restore-default",
            json_body={"expectedRevision": import_payload["revision"]},
        )
        self.assertEqual(status, 200)
        self.assertEqual(restore_payload["config"], initial["config"])
        self.assertEqual(restore_payload["revision"], initial["revision"])
        self.assertEqual(self.read_disk_config(), initial["config"])

    def test_post_get_filter_and_delete_history(self):
        history_entry = {
            "triggerId": "cpu_alta",
            "triggerName": "CPU alta",
            "timestamp": "2026-07-12T12:00:00+00:00",
            "values": {"cpu": 92.5},
            "character": "mechanic",
            "card": "maquina",
            "phrase": "CPU em alerta",
            "durationSeconds": 4,
            "cooldownSeconds": 120,
            "result": "ok",
            "secret": "nao deve persistir",
        }

        status, _headers, post_payload, _body = self.request(
            "POST",
            "/api/studio/history",
            json_body=history_entry,
        )
        self.assertEqual(status, 201)
        self.assertEqual(post_payload["entry"]["triggerId"], "cpu_alta")
        self.assertNotIn("secret", post_payload["entry"])

        status, _headers, get_payload, _body = self.request(
            "GET",
            "/api/studio/history?q=CPU%20alta&limit=1",
        )
        self.assertEqual(status, 200)
        self.assertEqual(get_payload["entries"], [post_payload["entry"]])

        status, _headers, delete_payload, _body = self.request("DELETE", "/api/studio/history")
        self.assertEqual(status, 200)
        self.assertEqual(delete_payload, {"cleared": 1})
        self.assertFalse(self.service.history_path.exists())

        status, _headers, get_payload, _body = self.request("GET", "/api/studio/history")
        self.assertEqual(status, 200)
        self.assertEqual(get_payload, {"entries": []})

    def test_loopback_host_and_same_origin_are_enforced(self):
        status, _headers, payload, _body = self.request(
            "GET",
            "/api/studio/config",
            headers={"Host": "example.invalid"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"], "Origin nao autorizado")

        status, _headers, payload, _body = self.request(
            "GET",
            "/api/studio/config",
            headers={"Origin": "https://example.invalid"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"], "Origin nao autorizado")

        status, _headers, payload, _body = self.request(
            "GET",
            "/api/studio/config",
            headers={"Origin": f"http://{self.authority}"},
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["valid"])

    def test_mutations_require_application_json_content_type(self):
        initial = self.service.read_config()
        modified = deepcopy(initial["config"])
        modified["metadata"]["description"] = "Nao deve ser salva."
        original_bytes = self.config_path.read_bytes()

        status, _headers, payload, _body = self.request(
            "PUT",
            "/api/studio/config",
            json_body={"config": modified, "expectedRevision": initial["revision"]},
            headers={"Content-Type": "text/plain"},
        )

        self.assertEqual(status, 400)
        self.assertIn("Content-Type", payload["error"])
        self.assertEqual(self.config_path.read_bytes(), original_bytes)
        self.assertFalse(self.service.backup_dir.exists())


if __name__ == "__main__":
    unittest.main()
