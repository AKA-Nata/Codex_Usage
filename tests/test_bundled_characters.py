from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from codex_usage.character_packages import CharacterPackageService, CharacterPackageValidator, NATIVE_CHARACTER_IDS
from scripts.generate_bundled_characters import DEFINITIONS, build_all


ROOT = Path(__file__).resolve().parents[1]
BUNDLED = ROOT / "web" / "assets" / "bundled-character-packages"


class BundledCharacterTests(unittest.TestCase):
    def test_all_declared_bundled_packages_validate_and_are_distinct(self):
        paths = sorted(BUNDLED.glob("*.codex-character.zip"))
        self.assertEqual(len(paths), 26)
        self.assertEqual(len(DEFINITIONS), 26)
        validator = CharacterPackageValidator()
        manifests = [validator.validate(path.read_bytes()).manifest for path in paths]
        ids = [item["id"] for item in manifests]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(set(ids).isdisjoint(NATIVE_CHARACTER_IDS))
        for manifest in manifests:
            self.assertIn("bundled", manifest["tags"])
            self.assertIn("fan-art", manifest["tags"])
            self.assertEqual(len(manifest["states"]), 15)
            self.assertEqual({spec["frame"]["width"] for spec in manifest["states"].values()}, {256})
            self.assertEqual({spec["frame"]["count"] for spec in manifest["states"].values()}, {4})

    def test_generator_is_byte_deterministic_and_packages_install(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); first, second = root / "first", root / "second"
            build_all(first); build_all(second)
            for source in sorted(first.glob("*.zip")):
                other = second / source.name
                self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), hashlib.sha256(other.read_bytes()).digest())
            service = CharacterPackageService(registry_root=root / "registry", bundled_package_root=first)
            result = service.install_bundled("pikachu")
            self.assertEqual(result["id"], "pikachu")
            self.assertEqual(service.export_package("pikachu"), (first / "pikachu.codex-character.zip").read_bytes())
