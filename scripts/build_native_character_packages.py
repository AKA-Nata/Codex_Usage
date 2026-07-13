from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path

from build_character_package import build


ROOT = Path(__file__).resolve().parents[1]
CHARACTERS_ROOT = ROOT / "web" / "assets" / "characters"
OUTPUT_ROOT = ROOT / "web" / "assets" / "character-packages"
NATIVE_IDS = ("explorer", "wizard", "mechanic", "orb")


def package_manifest(character: dict) -> dict:
    assets = {}
    states = {}
    for state, spec in character["states"].items():
        asset_key = state
        assets[asset_key] = {"file": f"assets/{state}.png", "mediaType": "image/png"}
        states[state] = {
            "asset": asset_key,
            "frame": {
                "width": character["frame"]["width"],
                "height": character["frame"]["height"],
                "count": spec["frames"],
                "columns": spec["frames"],
            },
            "fps": spec.get("fps", character["fps"]),
            "loop": spec.get("loop", character["loop"]),
            "fallback": character.get("fallback", "idle"),
        }
    return {
        "schemaVersion": "1.0.0",
        "id": character["id"],
        "name": character["name"],
        "author": {"name": "Codex Usage Monitor"},
        "version": "5.0.0",
        "compatibility": {
            "dashboard": {"min": "5.0.0", "maxExclusive": "6.0.0"},
            "behaviorSchema": {"min": "2.0.0", "maxExclusive": "4.0.0"},
        },
        "visualIdentity": {
            **character.get("visualIdentity", {}),
            "baseline": character.get("baseline", 0.9),
            "anchor": character.get("anchor", {"x": 0.5, "y": 0.88}),
            "orientation": character.get("orientation", "right"),
        },
        "personality": character.get("personality", {"id": "objective"}),
        "tags": character.get("tags", ["native"]),
        "capabilities": character.get("capabilities", ["speech", "movement"]),
        "assets": assets,
        "states": states,
        "fallback": {"state": character.get("fallback", "idle")},
        "license": {"spdx": "MIT", "file": "LICENSE.txt"},
        "checksums": {"algorithm": "sha256", "files": {}},
    }


def build_native(character_id: str, output_root: Path = OUTPUT_ROOT) -> tuple[Path, str]:
    source = CHARACTERS_ROOT / character_id
    character = json.loads((source / "character.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix=f"codex-native-{character_id}-") as temporary:
        staging = Path(temporary)
        (staging / "assets").mkdir(parents=True)
        for state, spec in character["states"].items():
            shutil.copyfile(source / spec["asset"], staging / "assets" / f"{state}.png")
        shutil.copyfile(source / character["states"]["idle"]["asset"], staging / "preview.png")
        (staging / "manifest.json").write_text(json.dumps(package_manifest(character), ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        (staging / "behaviors.json").write_text('{"schemaVersion":"1.0.0","triggers":[]}\n', encoding="utf-8", newline="\n")
        (staging / "phrases.json").write_text('{"schemaVersion":"1.0.0","groups":[]}\n', encoding="utf-8", newline="\n")
        (staging / "LICENSE.txt").write_text("MIT License\n\nCopyright (c) Codex Usage Monitor\n", encoding="utf-8", newline="\n")
        output = output_root / f"{character_id}.codex-character.zip"
        digest = build(staging, output)
    return output, digest


def main() -> int:
    parser = argparse.ArgumentParser(description="Gera os quatro pacotes nativos reproduzíveis.")
    parser.add_argument("--output", type=Path, default=OUTPUT_ROOT)
    args = parser.parse_args()
    for character_id in NATIVE_IDS:
        output, digest = build_native(character_id, args.output)
        print(f"{output.name} sha256={digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
