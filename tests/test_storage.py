from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from codex_usage.storage import atomic_write_json, read_json


class StorageTests(unittest.TestCase):
    def test_atomic_write_and_read(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "value.json"
            atomic_write_json(path, {"ok": True, "value": 14})
            self.assertEqual(read_json(path), {"ok": True, "value": 14})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["value"], 14)


if __name__ == "__main__":
    unittest.main()
