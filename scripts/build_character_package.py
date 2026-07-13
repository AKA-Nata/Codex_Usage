from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import zipfile
from pathlib import Path


FIXED_TIMESTAMP = (2020, 1, 1, 0, 0, 0)
ALLOWED_ROOT_FILES = {"manifest.json", "behaviors.json", "phrases.json", "preview.png", "LICENSE.txt", "NOTICE.txt"}


def strict_json(path: Path):
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Chave JSON duplicada em {path}: {key}")
            result[key] = value
        return result

    return json.loads(
        path.read_text(encoding="utf-8"),
        object_pairs_hook=object_pairs,
        parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Constante JSON inválida: {value}")),
    )


def package_files(source: Path) -> list[Path]:
    files = sorted((path for path in source.rglob("*") if path.is_file()), key=lambda path: path.relative_to(source).as_posix())
    for path in files:
        relative = path.relative_to(source).as_posix()
        if relative.startswith("assets/"):
            if path.suffix.lower() != ".png":
                raise ValueError(f"Asset não PNG: {relative}")
        elif relative not in ALLOWED_ROOT_FILES:
            raise ValueError(f"Arquivo não permitido no pacote: {relative}")
    return files


def file_checksums(source: Path, files: list[Path]) -> dict[str, str]:
    return {
        path.relative_to(source).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in files
        if path.name != "manifest.json"
    }


def canonical_manifest(manifest: dict, checksums: dict[str, str]) -> bytes:
    normalized = json.loads(json.dumps(manifest, ensure_ascii=False))
    normalized["checksums"] = {"algorithm": "sha256", "files": dict(sorted(checksums.items()))}
    return (json.dumps(normalized, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def build(source: Path, output: Path, *, sync_manifest: bool = True) -> str:
    source = source.resolve()
    output = output.resolve()
    manifest_path = source / "manifest.json"
    manifest = strict_json(manifest_path)
    files = package_files(source)
    manifest_bytes = canonical_manifest(manifest, file_checksums(source, files))
    if sync_manifest:
        atomic_write(manifest_path, manifest_bytes)
        files = package_files(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
    os.close(handle)
    try:
        # PNG is already compressed. Storing entries avoids zlib-version drift,
        # so the same source produces identical bytes across supported Pythons.
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED, strict_timestamps=True) as archive:
            for path in files:
                relative = path.relative_to(source).as_posix()
                data = manifest_bytes if relative == "manifest.json" else path.read_bytes()
                info = zipfile.ZipInfo(relative, FIXED_TIMESTAMP)
                info.compress_type = zipfile.ZIP_STORED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data, compress_type=zipfile.ZIP_STORED)
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return hashlib.sha256(output.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description="Gera pacote determinístico .codex-character.zip")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--no-sync-manifest", action="store_true")
    args = parser.parse_args()
    digest = build(args.source, args.output, sync_manifest=not args.no_sync_manifest)
    print(f"Pacote criado: {args.output} sha256={digest}")


if __name__ == "__main__":
    main()
