from __future__ import annotations

import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from codex_usage.behavior_studio import BehaviorStudioService, migrate_behavior_config


ROOT = Path(__file__).resolve().parents[1]


class BehaviorMigrationTests(unittest.TestCase):
    def test_migrates_42_and_43_selectors_without_mutating_input(self):
        current = json.loads((ROOT / "web" / "config" / "sprite-behaviors.default.json").read_text(encoding="utf-8"))
        legacy = deepcopy(current)
        legacy["metadata"]["version"] = "2.0.0"
        legacy["metadata"]["schemaVersion"] = "2.0.0"
        legacy["triggers"][0]["character"] = "wizard"
        migrated, changes = migrate_behavior_config(legacy)
        self.assertEqual(legacy["triggers"][0]["character"], "wizard")
        self.assertEqual(migrated["triggers"][0]["character"], {"kind": "id", "value": "wizard"})
        self.assertEqual(migrated["metadata"]["schemaVersion"], "3.0.0")
        self.assertGreaterEqual(len(changes), 3)

    def test_import_persists_migrated_configuration_with_backup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = json.loads((ROOT / "web" / "config" / "sprite-behaviors.json").read_text(encoding="utf-8"))
            default = deepcopy(config)
            config_path = root / "sprite-behaviors.json"
            default_path = root / "sprite-behaviors.default.json"
            schema_path = root / "sprite-behaviors.schema.json"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            default_path.write_text(json.dumps(default), encoding="utf-8")
            schema_path.write_bytes((ROOT / "web" / "config" / "sprite-behaviors.schema.json").read_bytes())
            service = BehaviorStudioService(config_path=config_path, default_config_path=default_path, schema_path=schema_path, runtime_dir=root / "runtime")
            revision = service.read_config()["revision"]
            legacy = deepcopy(config)
            legacy["metadata"]["version"] = "2.0.0"
            legacy["metadata"]["schemaVersion"] = "2.0.0"
            legacy["triggers"][0]["character"] = "explorer"
            saved = service.import_config(legacy, expected_revision=revision)
            self.assertEqual(saved["config"]["triggers"][0]["character"], {"kind": "id", "value": "explorer"})
            self.assertTrue(saved["backup"])
            self.assertTrue(saved["migrations"])


if __name__ == "__main__":
    unittest.main()
