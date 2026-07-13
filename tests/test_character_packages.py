from __future__ import annotations

import hashlib
import io
import json
import binascii
import stat
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from codex_usage.character_packages import (
    CharacterPackageService,
    CharacterPackageValidator,
    CharacterPackageError,
    PackageConflictError,
    PackageInUseError,
    PackageRevisionError,
)
from scripts.build_character_package import build
from codex_usage.behavior_studio import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
SENTINEL = ROOT / "examples" / "characters" / "sentinel.codex-character.zip"
NATIVES = ROOT / "web" / "assets" / "character-packages"


def archive_files(raw: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(raw)) as source:
        return {name: source.read(name) for name in source.namelist() if not name.endswith("/")}


def make_archive(files: dict[str, bytes], *, symlink: str | None = None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for name, body in files.items():
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = ((stat.S_IFLNK | 0o777) if name == symlink else (stat.S_IFREG | 0o644)) << 16
            target.writestr(info, body)
    return output.getvalue()


def mutate_manifest(raw: bytes, callback) -> bytes:
    files = archive_files(raw)
    manifest = json.loads(files["manifest.json"])
    callback(manifest, files)
    files["manifest.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    return make_archive(files)


def mutate_json_file(raw: bytes, path: str, callback) -> bytes:
    files = archive_files(raw)
    manifest = json.loads(files["manifest.json"])
    value = json.loads(files[path])
    callback(value)
    files[path] = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
    manifest["checksums"]["files"][path] = hashlib.sha256(files[path]).hexdigest()
    files["manifest.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    return make_archive(files)


def insert_png_chunk(data: bytes, chunk_type: bytes, payload: bytes) -> bytes:
    ihdr_length = struct.unpack(">I", data[8:12])[0]
    offset = 8 + 12 + ihdr_length
    chunk = struct.pack(">I", len(payload)) + chunk_type + payload
    chunk += struct.pack(">I", binascii.crc32(chunk_type + payload) & 0xFFFFFFFF)
    return data[:offset] + chunk + data[offset:]


class CharacterPackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.valid_archive = SENTINEL.read_bytes()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.service = CharacterPackageService(registry_root=self.root / "registry", native_package_root=NATIVES)

    def tearDown(self):
        self.temporary.cleanup()

    def test_official_package_validates_and_build_is_deterministic(self):
        report = CharacterPackageValidator().inspect(self.valid_archive)
        self.assertTrue(report["valid"], report["errors"])
        schema = json.loads((ROOT / "web" / "config" / "character-package.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(Draft202012Validator(schema).validate(report["manifest"]), [])
        first = self.root / "first.codex-character.zip"
        second = self.root / "second.codex-character.zip"
        build(ROOT / "examples" / "characters" / "sentinel", first, sync_manifest=False)
        build(ROOT / "examples" / "characters" / "sentinel", second, sync_manifest=False)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(hashlib.sha256(first.read_bytes()).hexdigest(), hashlib.sha256(self.valid_archive).hexdigest())

    def test_install_enable_disable_export_and_revision(self):
        installed = self.service.install_package(self.valid_archive)
        self.assertEqual(installed["id"], "sentinel")
        self.assertEqual(self.service.export_package("sentinel"), self.valid_archive)
        disabled = self.service.disable_package("sentinel", expected_revision=installed["revision"])
        self.assertFalse(disabled["enabled"])
        with self.assertRaises(PackageRevisionError):
            self.service.enable_package("sentinel", expected_revision=installed["revision"])
        enabled = self.service.enable_package("sentinel", expected_revision=disabled["revision"])
        self.assertTrue(enabled["enabled"])

    def test_update_rollback_and_in_use_uninstall(self):
        self.service.install_package(self.valid_archive)
        updated_archive = mutate_manifest(self.valid_archive, lambda manifest, _files: manifest.update(version="1.1.0"))
        updated = self.service.update_package(updated_archive)
        self.assertEqual(updated["activeVersion"], "1.1.0")
        rolled_back = self.service.rollback_package("sentinel")
        self.assertEqual(rolled_back["activeVersion"], "1.0.0")
        with self.assertRaises(PackageInUseError):
            self.service.uninstall_package("sentinel", reference_checker=lambda *_: [{"type": "trigger", "id": "alerta"}])
        removed = self.service.uninstall_package("sentinel", version="1.1.0")
        self.assertEqual(removed["removedVersions"], ["1.1.0"])

    def test_restore_four_native_packages_and_repair_files(self):
        restored = self.service.restore_natives()
        self.assertEqual({item["id"] for item in restored["restored"]}, {"explorer", "wizard", "mechanic", "orb"})
        catalog = self.service.catalog()
        self.assertEqual(len(catalog["characters"]), 4)
        idle = self.root / "registry" / "installed" / "explorer" / "5.0.0" / "assets" / "idle.png"
        idle.write_bytes(b"corrompido")
        self.service.restore_natives()
        self.assertTrue(idle.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))

    def test_native_ids_are_reserved_and_non_destructive_startup_preserves_state(self):
        explorer = (NATIVES / "explorer.codex-character.zip").read_bytes()
        with self.assertRaises(PackageConflictError):
            self.service.install_package(explorer)

        restored = self.service.restore_natives()
        disabled = self.service.disable_package("explorer", expected_revision=restored["revision"])
        ensured = self.service.restore_natives(reset_state=False, expected_revision=disabled["revision"])
        explorer_record = next(item for item in self.service.catalog()["characters"] if item["id"] == "explorer")
        self.assertFalse(ensured["changed"])
        self.assertEqual(ensured["revision"], disabled["revision"])
        self.assertFalse(explorer_record["enabled"])

        reset = self.service.restore_natives(expected_revision=ensured["revision"])
        explorer_record = next(item for item in self.service.catalog()["characters"] if item["id"] == "explorer")
        self.assertTrue(reset["changed"])
        self.assertTrue(explorer_record["enabled"])

        forged_update = mutate_manifest(explorer, lambda manifest, _files: manifest.update(version="5.1.0"))
        with self.assertRaises(PackageConflictError):
            self.service.update_package(forged_update)

    def test_native_repair_rolls_back_files_when_registry_commit_fails(self):
        self.service.restore_natives()
        idle = self.root / "registry" / "installed" / "explorer" / "5.0.0" / "assets" / "idle.png"
        idle.write_bytes(b"corrompido")
        registry_before = (self.root / "registry" / "registry.json").read_bytes()
        with patch.object(self.service, "_commit", side_effect=OSError("falha simulada")):
            with self.assertRaises(OSError):
                self.service.restore_natives()
        self.assertEqual(idle.read_bytes(), b"corrompido")
        self.assertEqual((self.root / "registry" / "registry.json").read_bytes(), registry_before)

    def test_read_file_checks_integrity_and_restore_repairs_tampering(self):
        self.service.restore_natives()
        idle = self.root / "registry" / "installed" / "explorer" / "5.0.0" / "assets" / "idle.png"
        idle.write_bytes(b"corrompido")
        with self.assertRaises(CharacterPackageError):
            self.service.read_file("explorer", "assets/idle.png", version="5.0.0")
        self.service.restore_natives(reset_state=False)
        body, content_type = self.service.read_file("explorer", "assets/idle.png", version="5.0.0")
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(content_type, "image/png")

    def test_rejects_traversal_links_bombs_mime_checksum_and_png_signature(self):
        files = archive_files(self.valid_archive)
        traversal = dict(files)
        traversal["../escape.txt"] = b"escape"
        self.assertFalse(CharacterPackageValidator().inspect(make_archive(traversal))["valid"])

        linked = dict(files)
        linked["assets/idle.png"] = b"preview.png"
        self.assertFalse(CharacterPackageValidator().inspect(make_archive(linked, symlink="assets/idle.png"))["valid"])

        bomb = dict(files)
        bomb["LICENSE.txt"] = b"A" * (2 * 1024 * 1024)
        bomb_report = CharacterPackageValidator().inspect(make_archive(bomb))
        self.assertFalse(bomb_report["valid"])
        self.assertIn(bomb_report["errors"][0]["code"], {"zip_bomb", "file_size", "text_too_large"})

        bad_mime = mutate_manifest(self.valid_archive, lambda manifest, _files: manifest["assets"]["idle"].update(mediaType="text/javascript"))
        self.assertFalse(CharacterPackageValidator().inspect(bad_mime)["valid"])

        bad_checksum = mutate_manifest(self.valid_archive, lambda manifest, _files: manifest["checksums"]["files"].update({"behaviors.json": "0" * 64}))
        self.assertFalse(CharacterPackageValidator().inspect(bad_checksum)["valid"])

        def corrupt_png(manifest, changed_files):
            changed_files["assets/idle.png"] = b"not-a-png"
            manifest["checksums"]["files"]["assets/idle.png"] = hashlib.sha256(changed_files["assets/idle.png"]).hexdigest()

        bad_png = mutate_manifest(self.valid_archive, corrupt_png)
        report = CharacterPackageValidator().inspect(bad_png)
        self.assertFalse(report["valid"])
        self.assertEqual(report["errors"][0]["code"], "png_signature")

        def add_apng(manifest, changed_files):
            changed_files["assets/idle.png"] = insert_png_chunk(
                changed_files["assets/idle.png"], b"acTL", struct.pack(">II", 100_000, 0)
            )
            manifest["checksums"]["files"]["assets/idle.png"] = hashlib.sha256(changed_files["assets/idle.png"]).hexdigest()

        apng = mutate_manifest(self.valid_archive, add_apng)
        report = CharacterPackageValidator().inspect(apng)
        self.assertFalse(report["valid"])
        self.assertEqual(report["errors"][0]["code"], "apng_not_allowed")

    def test_rejects_behavior_fragments_that_cannot_be_composed(self):
        invalid_priority = mutate_json_file(
            self.valid_archive,
            "behaviors.json",
            lambda behaviors: behaviors["triggers"][0].update(priority="not-a-number"),
        )
        report = CharacterPackageValidator().inspect(invalid_priority)
        self.assertFalse(report["valid"])
        self.assertEqual(report["errors"][0]["code"], "behavior_contract")

        unknown_state = mutate_json_file(
            self.valid_archive,
            "behaviors.json",
            lambda behaviors: behaviors["triggers"][0].update(spriteState="missing"),
        )
        report = CharacterPackageValidator().inspect(unknown_state)
        self.assertFalse(report["valid"])
        self.assertEqual(report["errors"][0]["code"], "behavior_contract")

        unknown_event = mutate_json_file(
            self.valid_archive,
            "behaviors.json",
            lambda behaviors: behaviors["triggers"][0].update(when={"event": {"type": "bogus_event"}}),
        )
        report = CharacterPackageValidator().inspect(unknown_event)
        self.assertFalse(report["valid"])
        self.assertEqual(report["errors"][0]["code"], "behavior_condition")

    def test_rejects_incompatible_and_duplicate_version(self):
        incompatible = mutate_manifest(
            self.valid_archive,
            lambda manifest, _files: manifest["compatibility"].update(dashboard={"min": "9.0.0", "maxExclusive": "10.0.0"}),
        )
        report = CharacterPackageValidator().inspect(incompatible)
        self.assertFalse(report["valid"])
        self.assertEqual(report["errors"][0]["code"], "incompatible")
        self.service.install_package(self.valid_archive)
        with self.assertRaises(PackageConflictError):
            self.service.install_package(self.valid_archive)


if __name__ == "__main__":
    unittest.main()
