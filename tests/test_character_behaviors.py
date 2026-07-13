from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from codex_usage.behavior_studio import BehaviorStudioService, Draft202012Validator
from codex_usage.character_behaviors import compose_effective_behavior_config
from codex_usage.character_packages import CharacterPackageService


ROOT = Path(__file__).resolve().parents[1]


class CharacterBehaviorCompositionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.studio = BehaviorStudioService(
            config_path=ROOT / "web" / "config" / "sprite-behaviors.json",
            schema_path=ROOT / "web" / "config" / "sprite-behaviors.schema.json",
            default_config_path=ROOT / "web" / "config" / "sprite-behaviors.default.json",
            runtime_dir=root / "studio",
        )
        self.packages = CharacterPackageService(registry_root=root / "characters")
        self.packages.install_package((ROOT / "examples" / "characters" / "sentinel.codex-character.zip").read_bytes())

    def tearDown(self):
        self.temporary.cleanup()

    def test_enabled_package_is_namespaced_and_bound_to_immutable_id(self):
        official = self.studio.read_config()["config"]
        result = compose_effective_behavior_config(official, self.packages, validate=self.studio.validate)
        self.assertEqual(result["diagnostics"], [])
        self.assertEqual(result["packages"], [{"id": "sentinel", "version": "1.0.0"}])
        trigger = next(item for item in result["config"]["triggers"] if item["id"] == "pkg_sentinel_alerta_critico")
        self.assertEqual(trigger["character"], {"kind": "id", "value": "sentinel"})
        self.assertEqual(trigger["phraseRefs"], ["pkg_sentinel_sentinel_critical"])
        self.assertTrue(self.studio.validate(result["config"])["valid"])
        self.assertEqual(official, self.studio.read_config()["config"])

    def test_disabled_package_does_not_change_effective_configuration(self):
        official = self.studio.read_config()["config"]
        self.packages.disable_package("sentinel")
        result = compose_effective_behavior_config(official, self.packages, validate=self.studio.validate)
        self.assertEqual(result["config"], official)
        self.assertEqual(result["packages"], [])

    def test_visual_identity_and_personality_remain_separate(self):
        manifest = self.packages.read_manifest("sentinel")
        self.assertEqual(manifest["visualIdentity"]["name"], "Sentinela")
        self.assertEqual(manifest["personality"]["id"], "critical")
        self.assertNotEqual(manifest["visualIdentity"], manifest["personality"])
        profiles = {
            path.stem: json.loads(path.read_text(encoding="utf-8"))
            for path in (ROOT / "web" / "config" / "personalities").glob("*.json")
        }
        self.assertEqual(set(profiles), {"technical", "humorous", "objective", "silent", "critical"})
        self.assertTrue(all(profile["version"] == "1.0.0" for profile in profiles.values()))
        schema = json.loads((ROOT / "web" / "config" / "personalities.schema.json").read_text(encoding="utf-8"))
        validator = Draft202012Validator(schema)
        self.assertTrue(all(not validator.validate(profile) for profile in profiles.values()))


if __name__ == "__main__":
    unittest.main()
