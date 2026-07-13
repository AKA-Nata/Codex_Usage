from __future__ import annotations

import http.client
import io
import json
import shutil
import tempfile
import threading
import unittest
import zipfile
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from codex_usage.behavior_studio import BehaviorStudioService
from codex_usage.character_packages import CharacterPackageService
from dashboard_server import character_references
from dashboard_server import DashboardHandler, ThreadingHTTPServer


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OFFICIAL_CONFIG_PATH = PROJECT_ROOT / "web" / "config" / "sprite-behaviors.json"
OFFICIAL_SCHEMA_PATH = PROJECT_ROOT / "web" / "config" / "sprite-behaviors.schema.json"
OFFICIAL_DEFAULT_PATH = PROJECT_ROOT / "web" / "config" / "sprite-behaviors.default.json"
_MISSING = object()


def package_with_version(raw, version):
    source = zipfile.ZipFile(io.BytesIO(raw))
    files = {name: source.read(name) for name in source.namelist() if not name.endswith("/")}
    source.close()
    manifest = json.loads(files["manifest.json"])
    manifest["version"] = version
    files["manifest.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            target.writestr(info, files[name])
    return output.getvalue()


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
        self.server.character_service = CharacterPackageService(
            registry_root=self.root / "character-registry",
            native_package_root=PROJECT_ROOT / "web" / "assets" / "character-packages",
        )
        self.server.character_service.reference_checker = lambda character_id, version=None: character_references(
            self.service,
            character_id,
            version,
            self.server.character_service,
        )
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

    def character_revision(self):
        status, headers, payload, _body = self.request("GET", "/api/studio/characters/v1")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("etag"), f'"{payload["revision"]}"')
        return payload["revision"]

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

    def test_character_package_endpoints_install_asset_effective_export_and_remove(self):
        archive = (PROJECT_ROOT / "examples" / "characters" / "sentinel.codex-character.zip").read_bytes()
        package_headers = {"Content-Type": "application/vnd.codex-character+zip"}
        status, _headers, payload, _body = self.request("POST", "/api/studio/characters/v1/validate", raw_body=archive, headers=package_headers)
        self.assertEqual(status, 200)
        self.assertTrue(payload["valid"])

        revision = self.character_revision()
        status, _headers, payload, _body = self.request(
            "POST",
            "/api/studio/characters/v1/install",
            raw_body=archive,
            headers={**package_headers, "If-Match": f'"{revision}"'},
        )
        self.assertEqual(status, 201)
        self.assertEqual(payload["id"], "sentinel")

        status, _headers, catalog, _body = self.request("GET", "/api/characters/v1/catalog")
        self.assertEqual(status, 200)
        self.assertEqual({item["id"] for item in catalog["characters"]}, {"explorer", "wizard", "mechanic", "orb", "sentinel"})

        status, headers, _payload, body = self.request("GET", "/api/characters/v1/assets/sentinel/1.0.0/assets/idle.png")
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "image/png")
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))

        status, _headers, effective, _body = self.request("GET", "/api/behaviors/v1/effective")
        self.assertEqual(status, 200)
        self.assertIn("pkg_sentinel_alerta_critico", {item["id"] for item in effective["triggers"]})

        status, _headers, diagnostics, _body = self.request("GET", "/api/behaviors/v1/effective/diagnostics")
        self.assertEqual(status, 200)
        self.assertEqual(diagnostics["diagnostics"], [])
        self.assertIn("sentinel", {item["id"] for item in diagnostics["packages"]})

        status, headers, _payload, exported = self.request("GET", "/api/studio/characters/v1/sentinel/export")
        self.assertEqual(status, 200)
        self.assertIn("application/vnd.codex-character+zip", headers["content-type"])
        self.assertEqual(exported, archive)

        status, _headers, payload, _body = self.request(
            "POST",
            "/api/studio/characters/v1/sentinel/disable",
            json_body={},
            headers={"If-Match": f'"{catalog["revision"]}"'},
        )
        self.assertEqual(status, 200)
        self.assertFalse(payload["enabled"])
        status, _headers, payload, _body = self.request(
            "DELETE",
            "/api/studio/characters/v1/sentinel",
            headers={"If-Match": f'"{payload["revision"]}"'},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["removedVersions"], ["1.0.0"])

    def test_character_package_endpoints_enforce_content_type_origin_and_restore_natives(self):
        archive = (PROJECT_ROOT / "examples" / "characters" / "sentinel.codex-character.zip").read_bytes()
        status, _headers, payload, _body = self.request(
            "POST", "/api/studio/characters/v1/validate", raw_body=archive, headers={"Content-Type": "application/json"}
        )
        self.assertEqual(status, 400)
        self.assertIn("Content-Type", payload["message"])
        status, _headers, payload, _body = self.request(
            "POST",
            "/api/studio/characters/v1/validate",
            raw_body=archive,
            headers={"Content-Type": "application/vnd.codex-character+zip", "Origin": "https://example.invalid"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"], "Origin nao autorizado")
        revision = self.character_revision()
        status, _headers, payload, _body = self.request(
            "POST",
            "/api/studio/characters/v1/restore-natives",
            json_body={},
            headers={"If-Match": f'"{revision}"'},
        )
        self.assertEqual(status, 200)
        self.assertEqual({item["id"] for item in payload["restored"]}, {"explorer", "wizard", "mechanic", "orb"})

    def test_character_mutations_require_current_if_match_and_install_never_updates(self):
        archive = (PROJECT_ROOT / "examples" / "characters" / "sentinel.codex-character.zip").read_bytes()
        package_headers = {"Content-Type": "application/vnd.codex-character+zip"}
        status, _headers, payload, _body = self.request(
            "POST", "/api/studio/characters/v1/install", raw_body=archive, headers=package_headers
        )
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"], "character_registry_revision_conflict")

        revision = self.character_revision()
        status, _headers, payload, _body = self.request(
            "POST",
            "/api/studio/characters/v1/install",
            raw_body=archive,
            headers={**package_headers, "If-Match": f'"{revision}"'},
        )
        self.assertEqual(status, 201)
        installed_revision = payload["revision"]

        status, _headers, payload, _body = self.request(
            "POST",
            "/api/studio/characters/v1/install",
            raw_body=archive,
            headers={**package_headers, "If-Match": f'"{installed_revision}"'},
        )
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"], "character_package_conflict")

        status, _headers, payload, _body = self.request(
            "POST",
            "/api/studio/characters/v1/sentinel/disable",
            json_body={},
            headers={"If-Match": f'"{revision}"'},
        )
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"], "character_registry_revision_conflict")

    def test_character_references_resolve_tags_personality_capability_and_nested_groups(self):
        archive = (PROJECT_ROOT / "examples" / "characters" / "sentinel.codex-character.zip").read_bytes()
        self.server.character_service.install_package(archive)

        class StaticStudio:
            @staticmethod
            def read_config():
                return {"config": {
                    "characterGroups": {
                        "diagnosticos": [{"kind": "capability", "value": "diagnostics"}],
                        "aninhado": [{"kind": "group", "value": "diagnosticos"}],
                    },
                    "triggers": [
                        {"id": "por_tag", "character": {"kind": "tag", "value": "alerta"}},
                        {"id": "por_personalidade", "character": {"kind": "personality", "value": "critical"}},
                        {"id": "por_grupo", "character": {"kind": "group", "value": "aninhado"}},
                    ],
                }}

        references = character_references(
            StaticStudio(),
            "sentinel",
            package_service=self.server.character_service,
        )
        trigger_ids = {item["id"] for item in references if item["type"] == "trigger"}
        group_ids = {item["id"] for item in references if item["type"] == "group"}
        self.assertEqual(trigger_ids, {"por_tag", "por_personalidade", "por_grupo"})
        self.assertEqual(group_ids, set())

    def test_character_http_update_enable_activate_and_rollback(self):
        archive = (PROJECT_ROOT / "examples" / "characters" / "sentinel.codex-character.zip").read_bytes()
        updated_archive = package_with_version(archive, "1.1.0")
        package_headers = {"Content-Type": "application/vnd.codex-character+zip"}
        revision = self.character_revision()
        status, _headers, installed, _body = self.request(
            "POST",
            "/api/studio/characters/v1/install",
            raw_body=archive,
            headers={**package_headers, "If-Match": f'"{revision}"'},
        )
        self.assertEqual(status, 201)

        status, _headers, disabled, _body = self.request(
            "POST",
            "/api/studio/characters/v1/sentinel/disable",
            json_body={},
            headers={"If-Match": f'"{installed["revision"]}"'},
        )
        self.assertEqual(status, 200)
        self.assertFalse(disabled["enabled"])

        status, _headers, enabled, _body = self.request(
            "POST",
            "/api/studio/characters/v1/sentinel/enable",
            json_body={},
            headers={"If-Match": f'"{disabled["revision"]}"'},
        )
        self.assertEqual(status, 200)
        self.assertTrue(enabled["enabled"])

        status, _headers, updated, _body = self.request(
            "POST",
            "/api/studio/characters/v1/sentinel/update",
            raw_body=updated_archive,
            headers={**package_headers, "If-Match": f'"{enabled["revision"]}"'},
        )
        self.assertEqual(status, 200)
        self.assertEqual(updated["activeVersion"], "1.1.0")

        status, _headers, rolled_back, _body = self.request(
            "POST",
            "/api/studio/characters/v1/sentinel/rollback",
            json_body={},
            headers={"If-Match": f'"{updated["revision"]}"'},
        )
        self.assertEqual(status, 200)
        self.assertEqual(rolled_back["activeVersion"], "1.0.0")

        status, _headers, activated, _body = self.request(
            "POST",
            "/api/studio/characters/v1/sentinel/activate",
            json_body={"version": "1.1.0"},
            headers={"If-Match": f'"{rolled_back["revision"]}"'},
        )
        self.assertEqual(status, 200)
        self.assertEqual(activated["activeVersion"], "1.1.0")


if __name__ == "__main__":
    unittest.main()
