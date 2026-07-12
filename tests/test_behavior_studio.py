from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from codex_usage.behavior_studio import (
    BehaviorStudioService,
    StudioError,
    StudioRevisionConflict,
    StudioValidationError,
    build_macro_catalog,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OFFICIAL_CONFIG_PATH = PROJECT_ROOT / "web" / "config" / "sprite-behaviors.json"
OFFICIAL_SCHEMA_PATH = PROJECT_ROOT / "web" / "config" / "sprite-behaviors.schema.json"
OFFICIAL_DEFAULT_PATH = PROJECT_ROOT / "web" / "config" / "sprite-behaviors.default.json"


class BehaviorStudioServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.config_dir = self.root / "config"
        self.config_dir.mkdir()
        self.config_path = self.config_dir / "sprite-behaviors.json"
        self.schema_path = self.config_dir / "sprite-behaviors.schema.json"
        self.default_config_path = self.config_dir / "sprite-behaviors.default.json"
        self.runtime_dir = self.root / "runtime"
        shutil.copyfile(OFFICIAL_CONFIG_PATH, self.config_path)
        shutil.copyfile(OFFICIAL_SCHEMA_PATH, self.schema_path)
        shutil.copyfile(OFFICIAL_DEFAULT_PATH, self.default_config_path)
        self.service = BehaviorStudioService(
            config_path=self.config_path,
            schema_path=self.schema_path,
            default_config_path=self.default_config_path,
            runtime_dir=self.runtime_dir,
        )

    def tearDown(self):
        self.temporary_directory.cleanup()

    def read_disk_config(self):
        return json.loads(self.config_path.read_text(encoding="utf-8"))

    def test_committed_configuration_is_valid_against_schema(self):
        result = self.service.read_config()

        self.assertTrue(result["valid"], result["errors"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["revision"]), 64)
        self.assertEqual(result["config"], self.read_disk_config())

        schema_copy = self.service.read_schema()
        self.assertEqual(schema_copy["$schema"], "https://json-schema.org/draft/2020-12/schema")
        schema_copy["title"] = "alterado apenas no teste"
        self.assertNotEqual(self.service.read_schema()["title"], schema_copy["title"])

    def test_schema_and_semantic_errors_are_reported_with_paths(self):
        invalid = self.read_disk_config()
        invalid["metadata"]["version"] = "versao-invalida"
        invalid["unexpected"] = True
        invalid["triggers"][0]["phrases"] = ["Valor {{macro_inexistente}}"]
        invalid["phrases"][0]["texts"] = ["CPU {{CPU}} e RAM {{ram"]

        report = self.service.validate(invalid)
        paths = {error["path"] for error in report["errors"]}
        keywords = {error["keyword"] for error in report["errors"]}

        self.assertFalse(report["valid"])
        self.assertIn("$.metadata.version", paths)
        self.assertIn("$.unexpected", paths)
        self.assertIn("unknownMacro", keywords)
        self.assertIn("malformedMacro", keywords)
        self.assertTrue(all(error.get("message") for error in report["errors"]))

        malformed_variants = []
        character_list = self.read_disk_config()
        character_list["triggers"][0]["characterPhrases"] = []
        malformed_variants.append(character_list)
        numeric_refs = self.read_disk_config()
        numeric_refs["triggers"][0]["phraseRefs"] = 7
        malformed_variants.append(numeric_refs)
        numeric_texts = self.read_disk_config()
        numeric_texts["phrases"][0]["texts"] = 7
        malformed_variants.append(numeric_texts)
        empty_character_map = self.read_disk_config()
        empty_character_map["triggers"][0]["characterPhrases"] = {}
        malformed_variants.append(empty_character_map)
        missing_casual_ref = self.read_disk_config()
        missing_casual_ref["defaultBehavior"]["casualSpeech"]["phraseIds"] = ["missing_group"]
        malformed_variants.append(missing_casual_ref)
        for malformed in malformed_variants:
            malformed_report = self.service.validate(malformed)
            self.assertFalse(malformed_report["valid"])
            self.assertTrue(malformed_report["errors"])

    def test_macro_catalog_resolves_current_values_and_fallbacks(self):
        config = self.read_disk_config()
        now = datetime(2026, 7, 12, 12, 0, tzinfo=timezone.utc)
        catalog = build_macro_catalog(
            config,
            usage={
                "collected_at": "2026-07-12T11:59:00+00:00",
                "resets": {
                    "limite_5h": {
                        "remaining_percent": 37,
                        "reset_at": "2026-07-12T13:01:01+00:00",
                        "limit_reached": True,
                    },
                    "limite_semanal": {"remaining_percent": 82, "limit_reached": False},
                },
            },
            health={"status": "ok"},
            telemetry={
                "clock": {"time": "09:00:00", "date": "12/07/2026"},
                "machine": {"cpu_percent": 42.5},
                "weather": {"condition": "Ensolarado"},
            },
            panel_idle_seconds=125,
            now=now,
        )
        macros = {item["macro"]: item for item in catalog}

        self.assertEqual(macros["cpu"]["value"], 42.5)
        self.assertEqual(macros["cpu"]["displayValue"], "42.5")
        self.assertTrue(macros["cpu"]["available"])
        self.assertIsNone(macros["ram"]["value"])
        self.assertFalse(macros["ram"]["available"])
        self.assertEqual(macros["ram"]["displayValue"], config["macros"]["ram"]["fallback"])
        self.assertEqual(macros["tempo_sem_interacao"]["displayValue"], "2min")
        self.assertEqual(macros["codex_5h_reset"]["displayValue"], "1h 1min")
        self.assertEqual(macros["codex_5h_atingido"]["displayValue"], "sim")
        self.assertTrue(macros["codex_5h_atingido"]["available"])
        self.assertEqual(macros["codex_semanal_atingido"]["displayValue"], "não")
        self.assertTrue(macros["codex_semanal_atingido"]["available"])
        self.assertEqual(macros["coleta_status"]["displayValue"], "ok")

        remapped = deepcopy(config)
        remapped["macros"]["cpu"]["sourcePath"] = "machine.diskPercent"
        remapped_catalog = build_macro_catalog(
            remapped,
            telemetry={"machine": {"cpu_percent": 42.5, "disk_percent": 67.5}},
            now=now,
        )
        remapped_macros = {item["macro"]: item for item in remapped_catalog}
        self.assertEqual(remapped_macros["cpu"]["value"], 67.5)

    def test_save_creates_default_backup_and_changes_revision(self):
        before = self.service.read_config()
        original = before["config"]
        modified = deepcopy(original)
        modified["metadata"]["description"] = "Configuracao salva pelo teste."

        saved = self.service.save_config(modified, expected_revision=before["revision"], reason="unit test")

        self.assertTrue(saved["valid"])
        self.assertNotEqual(saved["revision"], before["revision"])
        self.assertEqual(self.read_disk_config(), modified)
        self.assertEqual(json.loads(self.service.default_config_path.read_text(encoding="utf-8")), original)
        backup_path = self.service.backup_dir / saved["backup"]
        self.assertTrue(backup_path.is_file())
        self.assertEqual(json.loads(backup_path.read_text(encoding="utf-8")), original)

    def test_revision_conflict_preserves_configuration_without_backup(self):
        original_bytes = self.config_path.read_bytes()
        modified = self.read_disk_config()
        modified["metadata"]["description"] = "Nao deve ser persistida."

        with self.assertRaises(StudioRevisionConflict):
            self.service.save_config(modified, expected_revision="0" * 64)

        self.assertEqual(self.config_path.read_bytes(), original_bytes)
        self.assertFalse(self.service.backup_dir.exists())

    def test_import_and_export_round_trip_without_shared_mutation(self):
        initial = self.service.read_config()
        exported = self.service.export_config()
        exported["metadata"]["description"] = "Mutacao apenas da copia exportada."
        self.assertNotEqual(
            self.service.export_config()["metadata"]["description"],
            exported["metadata"]["description"],
        )

        imported = deepcopy(initial["config"])
        imported["metadata"]["description"] = "Configuracao importada."
        result = self.service.import_config(imported, expected_revision=initial["revision"])

        self.assertEqual(result["config"], imported)
        self.assertEqual(self.service.export_config(), imported)
        self.assertEqual(self.read_disk_config(), imported)

    def test_restore_default_recovers_first_snapshot_and_backs_up_current(self):
        initial = self.service.read_config()
        original = initial["config"]
        modified = deepcopy(original)
        modified["metadata"]["description"] = "Versao temporaria."
        saved = self.service.save_config(modified, expected_revision=initial["revision"])

        restored = self.service.restore_default(expected_revision=saved["revision"])

        self.assertEqual(restored["config"], original)
        self.assertEqual(restored["revision"], initial["revision"])
        self.assertEqual(self.read_disk_config(), original)
        restore_backup = self.service.backup_dir / restored["backup"]
        self.assertEqual(json.loads(restore_backup.read_text(encoding="utf-8")), modified)

    def test_invalid_save_and_import_preserve_official_file(self):
        original_bytes = self.config_path.read_bytes()
        invalid = self.read_disk_config()
        invalid["macros"]["cpu"]["token"] = "{{processador}}"

        with self.assertRaises(StudioValidationError) as save_error:
            self.service.save_config(invalid)
        self.assertTrue(save_error.exception.errors)
        self.assertEqual(self.config_path.read_bytes(), original_bytes)
        self.assertFalse(self.service.backup_dir.exists())

        with self.assertRaises(StudioValidationError):
            self.service.import_config(invalid)
        self.assertEqual(self.config_path.read_bytes(), original_bytes)

    def test_paths_outside_authorized_roots_are_rejected(self):
        outside_schema = self.root / "outside-schema.json"
        shutil.copyfile(OFFICIAL_SCHEMA_PATH, outside_schema)
        with self.assertRaises(StudioError):
            BehaviorStudioService(
                config_path=self.config_path,
                schema_path=outside_schema,
                default_config_path=self.default_config_path,
                runtime_dir=self.runtime_dir,
            )

        outside_history = self.root / "outside" / "history.jsonl"
        self.service.history_path = outside_history
        with self.assertRaises(StudioError):
            self.service.append_history({"triggerId": "fora"})
        self.assertFalse(outside_history.exists())

    def test_history_is_sanitized_filtered_ordered_and_cleared(self):
        first = self.service.append_history({
            "triggerId": "cpu_alta",
            "triggerName": "CPU alta",
            "timestamp": "2026-07-12T12:00:00+00:00",
            "values": {
                "cpu": 92.5,
                "cookie": "session-secret",
                "access_token": "bearer-secret",
                "authToken": "bearer-secret",
                "session_id": "session-secret",
                "edge_profile": "perfil-secreto",
                "cookie_value": "cookie-secreto",
            },
            "phrase": "CPU em alerta com access_token acidental",
            "result": "ok",
            "error": "Authorization: Bearer abc",
            "secret": "nao deve persistir",
        })
        second = self.service.append_history({
            "triggerId": "coleta_erro",
            "timestamp": "2026-07-12T12:01:00+00:00",
            "values": {"status": "error"},
            "error": "CDP indisponivel",
            "result": "error",
        })

        self.assertNotIn("secret", first)
        self.assertEqual(first["values"], {"cpu": 92.5})
        self.assertEqual(first["phrase"], "[conteudo sensivel removido]")
        self.assertEqual(first["error"], "[conteudo sensivel removido]")
        self.assertEqual(self.service.read_history(limit=1), [second])
        self.assertEqual(self.service.read_history(query="CPU alta"), [first])
        self.assertEqual(self.service.read_history(query="inexistente"), [])

        self.assertEqual(self.service.clear_history(), 2)
        self.assertEqual(self.service.read_history(), [])
        self.assertFalse(self.service.history_path.exists())


if __name__ == "__main__":
    unittest.main()
