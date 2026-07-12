import hashlib
import json
import struct
import unittest
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHARACTER_ROOT = ROOT / "web" / "assets" / "characters"
CHARACTERS = {"explorer", "wizard", "mechanic", "orb"}
REQUIRED_STATES = {
    "idle", "walk", "talk", "point", "inspect", "happy", "worried", "critical",
    "hot", "cold", "sleep", "wake", "confused", "celebrate",
}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def decode_rgba_png(path: Path):
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise AssertionError(f"Assinatura PNG inválida: {path}")
    cursor = len(PNG_SIGNATURE)
    idat = bytearray()
    width = height = None
    while cursor < len(data):
        length = struct.unpack(">I", data[cursor:cursor + 4])[0]
        chunk_type = data[cursor + 4:cursor + 8]
        payload = data[cursor + 8:cursor + 8 + length]
        expected_crc = struct.unpack(">I", data[cursor + 8 + length:cursor + 12 + length])[0]
        actual_crc = zlib.crc32(chunk_type + payload) & 0xFFFFFFFF
        if expected_crc != actual_crc:
            raise AssertionError(f"CRC PNG inválido em {path}: {chunk_type!r}")
        cursor += 12 + length
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            if (bit_depth, color_type, compression, filtering, interlace) != (8, 6, 0, 0, 0):
                raise AssertionError(f"Formato PNG inesperado em {path}")
        elif chunk_type == b"IDAT":
            idat.extend(payload)
        elif chunk_type == b"IEND":
            if cursor != len(data):
                raise AssertionError(f"Dados após IEND em {path}")
            break
    if width is None or height is None:
        raise AssertionError(f"IHDR ausente em {path}")
    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    rows = []
    offset = 0
    previous = bytearray(stride)
    for _ in range(height):
        filter_type = raw[offset]
        offset += 1
        scanline = bytearray(raw[offset:offset + stride])
        offset += stride
        reconstructed = bytearray(stride)
        for index, value in enumerate(scanline):
            left = reconstructed[index - 4] if index >= 4 else 0
            up = previous[index]
            upper_left = previous[index - 4] if index >= 4 else 0
            if filter_type == 0:
                predictor = 0
            elif filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = up
            elif filter_type == 3:
                predictor = (left + up) // 2
            elif filter_type == 4:
                estimate = left + up - upper_left
                distances = (abs(estimate - left), abs(estimate - up), abs(estimate - upper_left))
                predictor = (left, up, upper_left)[distances.index(min(distances))]
            else:
                raise AssertionError(f"Filtro PNG desconhecido em {path}: {filter_type}")
            reconstructed[index] = (value + predictor) & 0xFF
        rows.append(bytes(reconstructed))
        previous = reconstructed
    return width, height, rows


class NativeCharacterAssetTests(unittest.TestCase):
    def test_four_native_manifests_have_complete_animation_contract(self):
        self.assertEqual({path.name for path in CHARACTER_ROOT.iterdir() if path.is_dir()}, CHARACTERS)
        for character_id in sorted(CHARACTERS):
            manifest_path = CHARACTER_ROOT / character_id / "character.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["id"], character_id)
            self.assertEqual(manifest["version"], "4.3.0")
            self.assertEqual(manifest["frame"], {"width": 256, "height": 256, "layout": "horizontal"})
            self.assertGreaterEqual(manifest["fps"], 1)
            self.assertIsInstance(manifest["loop"], bool)
            self.assertGreaterEqual(manifest["baseline"], 0)
            self.assertLessEqual(manifest["baseline"], 1)
            self.assertEqual(set(manifest["anchor"]), {"x", "y"})
            self.assertIn(manifest["orientation"], {"left", "right"})
            self.assertIn(manifest["fallback"], manifest["states"])
            self.assertTrue(REQUIRED_STATES.issubset(manifest["states"]))
            self.assertIn("dragging", manifest["states"])

    def test_all_native_sheets_are_valid_rgba_and_have_distinct_frames(self):
        for character_id in sorted(CHARACTERS):
            manifest = json.loads((CHARACTER_ROOT / character_id / "character.json").read_text(encoding="utf-8"))
            for state, spec in manifest["states"].items():
                path = CHARACTER_ROOT / character_id / spec["asset"]
                width, height, rows = decode_rgba_png(path)
                self.assertEqual(width, manifest["frame"]["width"] * spec["frames"], path)
                self.assertEqual(height, manifest["frame"]["height"], path)
                self.assertGreaterEqual(spec.get("fps", manifest["fps"]), 1)
                self.assertLessEqual(spec.get("fps", manifest["fps"]), 60)
                self.assertIsInstance(spec.get("loop", manifest["loop"]), bool)
                frame_width = manifest["frame"]["width"]
                frame_hashes = []
                for frame in range(spec["frames"]):
                    frame_bytes = b"".join(row[frame * frame_width * 4:(frame + 1) * frame_width * 4] for row in rows)
                    frame_hashes.append(hashlib.sha256(frame_bytes).hexdigest())
                self.assertGreater(len(set(frame_hashes)), 1, f"Frames idênticos: {character_id}/{state}")
                self.assertEqual(rows[0][3], 0, f"Canto não transparente: {character_id}/{state}")


if __name__ == "__main__":
    unittest.main()
