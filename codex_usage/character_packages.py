"""Secure, dependency-free character package registry.

The module deliberately keeps package bytes inert.  It never imports, executes or
serves a path supplied by a package without validating and resolving it below the
registry root first.  HTTP concerns are intentionally left to ``dashboard_server``;
the public service methods return JSON-serialisable dictionaries or immutable
bytes that can be wired to local endpoints.
"""

from __future__ import annotations

import binascii
import hashlib
import io
import json
import math
import os
import re
import shutil
import stat
import struct
import tempfile
import threading
import unicodedata
import zipfile
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Any, Callable, Iterable, Mapping, Sequence


BASE_DIR = Path(__file__).resolve().parents[1]
CHARACTER_PACKAGE_REGISTRY_ROOT = BASE_DIR / "runtime" / "character-packages"
NATIVE_CHARACTER_PACKAGE_ROOT = BASE_DIR / "web" / "assets" / "character-packages"
CHARACTER_PACKAGE_EXTENSION = ".codex-character.zip"
REGISTRY_SCHEMA_VERSION = "1.0.0"
PACKAGE_SCHEMA_VERSION = "1.0.0"
CURRENT_APP_VERSION = "5.0.0"
NATIVE_CHARACTER_IDS = frozenset({"explorer", "wizard", "mechanic", "orb"})


@dataclass(frozen=True)
class PackageLimits:
    """Hard limits applied before and while an archive is decompressed."""

    archive_bytes: int = 25 * 1024 * 1024
    files: int = 128
    directories: int = 128
    total_uncompressed_bytes: int = 64 * 1024 * 1024
    file_uncompressed_bytes: int = 16 * 1024 * 1024
    json_bytes: int = 1 * 1024 * 1024
    text_bytes: int = 256 * 1024
    path_bytes: int = 240
    compression_ratio: float = 100.0
    png_width: int = 4096
    png_height: int = 4096
    png_pixels: int = 16 * 1024 * 1024
    frames_per_state: int = 128
    total_frames: int = 512
    states: int = 128
    assets: int = 256


DEFAULT_LIMITS = PackageLimits()


@dataclass(frozen=True)
class PackageIssue:
    code: str
    message: str
    path: str = "$"

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "path": self.path, "message": self.message}


class CharacterPackageError(Exception):
    """Base exception carrying a stable machine-readable error code."""

    code = "character_package_error"

    def __init__(self, message: str, *, details: Any = None):
        super().__init__(message)
        self.details = details

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"error": self.code, "message": str(self)}
        if self.details is not None:
            result["details"] = deepcopy(self.details)
        return result


class PackageValidationError(CharacterPackageError):
    code = "invalid_character_package"

    def __init__(self, issues: Sequence[PackageIssue] | PackageIssue):
        issue_list = [issues] if isinstance(issues, PackageIssue) else list(issues)
        super().__init__(
            issue_list[0].message if issue_list else "Pacote de personagem invalido.",
            details=[item.as_dict() for item in issue_list],
        )
        self.issues = tuple(issue_list)


class PackageNotFoundError(CharacterPackageError):
    code = "character_package_not_found"


class PackageConflictError(CharacterPackageError):
    code = "character_package_conflict"


class PackageRevisionError(CharacterPackageError):
    code = "character_registry_revision_conflict"


class PackageInUseError(CharacterPackageError):
    code = "character_package_in_use"


@dataclass(frozen=True)
class SemVer:
    major: int
    minor: int
    patch: int
    prerelease: tuple[str, ...] = ()
    build: tuple[str, ...] = ()

    _PATTERN = re.compile(
        r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
        r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
        r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
    )

    @classmethod
    def parse(cls, value: Any, *, path: str = "$.version") -> "SemVer":
        if not isinstance(value, str):
            _invalid("semver", "Versao deve ser uma string SemVer.", path)
        match = cls._PATTERN.fullmatch(value)
        if not match:
            _invalid("semver", "Versao deve usar SemVer estrito.", path)
        prerelease = tuple((match.group(4) or "").split(".")) if match.group(4) else ()
        if any(part.isdigit() and len(part) > 1 and part.startswith("0") for part in prerelease):
            _invalid("semver", "Identificador numerico de pre-release nao pode ter zero inicial.", path)
        build = tuple((match.group(5) or "").split(".")) if match.group(5) else ()
        return cls(int(match.group(1)), int(match.group(2)), int(match.group(3)), prerelease, build)

    def _compare(self, other: "SemVer") -> int:
        core_left = (self.major, self.minor, self.patch)
        core_right = (other.major, other.minor, other.patch)
        if core_left != core_right:
            return -1 if core_left < core_right else 1
        if self.prerelease == other.prerelease:
            return 0
        if not self.prerelease:
            return 1
        if not other.prerelease:
            return -1
        for left, right in zip(self.prerelease, other.prerelease):
            if left == right:
                continue
            left_numeric, right_numeric = left.isdigit(), right.isdigit()
            if left_numeric and right_numeric:
                return -1 if int(left) < int(right) else 1
            if left_numeric != right_numeric:
                return -1 if left_numeric else 1
            return -1 if left < right else 1
        return -1 if len(self.prerelease) < len(other.prerelease) else 1

    def __lt__(self, other: "SemVer") -> bool:
        return self._compare(other) < 0

    def __le__(self, other: "SemVer") -> bool:
        return self._compare(other) <= 0

    def __gt__(self, other: "SemVer") -> bool:
        return self._compare(other) > 0

    def __ge__(self, other: "SemVer") -> bool:
        return self._compare(other) >= 0

    def __str__(self) -> str:
        value = f"{self.major}.{self.minor}.{self.patch}"
        if self.prerelease:
            value += "-" + ".".join(self.prerelease)
        if self.build:
            value += "+" + ".".join(self.build)
        return value


@dataclass(frozen=True)
class PngInfo:
    width: int
    height: int
    bit_depth: int
    color_type: int


@dataclass(frozen=True)
class ValidatedCharacterPackage:
    manifest: Mapping[str, Any]
    files: Mapping[str, bytes]
    pngs: Mapping[str, PngInfo]
    archive_sha256: str
    archive_bytes: int
    uncompressed_bytes: int

    @property
    def character_id(self) -> str:
        return str(self.manifest["id"])

    @property
    def version(self) -> str:
        return str(self.manifest["version"])

    def report(self) -> dict[str, Any]:
        return {
            "valid": True,
            "errors": [],
            "manifest": deepcopy(dict(self.manifest)),
            "package": {
                "sha256": self.archive_sha256,
                "compressedBytes": self.archive_bytes,
                "uncompressedBytes": self.uncompressed_bytes,
                "files": len(self.files),
            },
            "files": sorted(self.files),
        }


_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")
_STATE_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
_WINDOWS_DEVICE = re.compile(r"^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$", re.I)
_ALLOWED_ROOT_FILES = {
    "manifest.json",
    "behaviors.json",
    "phrases.json",
    "preview.png",
    "LICENSE.txt",
}
_REQUIRED_PACKAGE_FILES = frozenset(_ALLOWED_ROOT_FILES)
_JSON_FILES = frozenset({"manifest.json", "behaviors.json", "phrases.json"})
_TEXT_FILES = frozenset({"LICENSE.txt"})
_ALLOWED_COMPRESSION = frozenset({zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _invalid(code: str, message: str, path: str = "$") -> None:
    raise PackageValidationError(PackageIssue(code, message, path))


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _strict_json(data: bytes, *, path: str, max_bytes: int) -> Any:
    if len(data) > max_bytes:
        _invalid("json_too_large", "Arquivo JSON excede o limite permitido.", path)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        _invalid("json_encoding", "JSON deve usar UTF-8 estrito.", path)

    def pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate:{key}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        raise ValueError(f"constant:{value}")

    try:
        return json.loads(text, object_pairs_hook=pairs_hook, parse_constant=reject_constant)
    except (json.JSONDecodeError, UnicodeError, ValueError, RecursionError) as error:
        message = "JSON invalido, duplicado ou nao finito."
        if str(error).startswith("duplicate:"):
            message = f"Chave JSON duplicada: {str(error).split(':', 1)[1]}."
        _invalid("invalid_json", message, path)


def _safe_archive_path(value: str, *, directory: bool = False) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        _invalid("unsafe_path", "Caminho vazio ou com NUL nao e permitido.", "$.zip")
    if "\\" in value:
        _invalid("unsafe_path", "ZIP deve usar apenas separadores POSIX.", value)
    if value.startswith(("/", "//")) or re.match(r"^[A-Za-z]:", value):
        _invalid("unsafe_path", "Caminho absoluto nao e permitido.", value)
    if ":" in value:
        _invalid("unsafe_path", "ADS e dois-pontos nao sao permitidos.", value)
    candidate = value[:-1] if directory and value.endswith("/") else value
    if not candidate:
        _invalid("unsafe_path", "Entrada raiz nao e permitida.", value)
    parts = candidate.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        _invalid("unsafe_path", "Segmentos vazios, ponto e traversal nao sao permitidos.", value)
    for part in parts:
        if part.endswith((".", " ")) or any(ord(char) < 32 or ord(char) == 127 for char in part):
            _invalid("unsafe_path", "Nome incompativel com o filesystem local.", value)
        if _WINDOWS_DEVICE.fullmatch(part):
            _invalid("unsafe_path", "Nome reservado do Windows nao e permitido.", value)
    normalized = PurePosixPath(*parts).as_posix()
    if normalized != candidate:
        _invalid("unsafe_path", "Caminho deve estar normalizado.", value)
    return normalized


def _portable_key(path: str) -> str:
    return unicodedata.normalize("NFC", path).casefold()


def _validate_png(data: bytes, *, path: str, limits: PackageLimits) -> PngInfo:
    if not data.startswith(_PNG_SIGNATURE):
        _invalid("png_signature", "Arquivo .png nao possui assinatura PNG.", path)
    offset = len(_PNG_SIGNATURE)
    seen_ihdr = False
    seen_idat = False
    seen_iend = False
    info: PngInfo | None = None
    while offset < len(data):
        if len(data) - offset < 12:
            _invalid("png_structure", "Chunk PNG truncado.", path)
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        end = offset + 12 + length
        if end > len(data):
            _invalid("png_structure", "Chunk PNG excede o arquivo.", path)
        if not re.fullmatch(rb"[A-Za-z]{4}", chunk_type):
            _invalid("png_chunk", "Tipo de chunk PNG invalido.", path)
        payload = data[offset + 8 : offset + 8 + length]
        expected_crc = struct.unpack(">I", data[offset + 8 + length : end])[0]
        actual_crc = binascii.crc32(chunk_type + payload) & 0xFFFFFFFF
        if expected_crc != actual_crc:
            _invalid("png_crc", "CRC de chunk PNG invalido.", path)
        if not seen_ihdr and chunk_type != b"IHDR":
            _invalid("png_ihdr", "IHDR deve ser o primeiro chunk PNG.", path)
        if chunk_type == b"IHDR":
            if seen_ihdr or length != 13:
                _invalid("png_ihdr", "IHDR ausente, repetido ou invalido.", path)
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            if width < 1 or height < 1 or width > limits.png_width or height > limits.png_height:
                _invalid("png_dimensions", "Dimensoes PNG excedem os limites.", path)
            if width * height > limits.png_pixels:
                _invalid("png_pixels", "Quantidade de pixels PNG excede o limite.", path)
            valid_depths = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
            if color_type not in valid_depths or bit_depth not in valid_depths[color_type]:
                _invalid("png_ihdr", "Profundidade ou tipo de cor PNG invalido.", path)
            if compression != 0 or filtering != 0 or interlace not in {0, 1}:
                _invalid("png_ihdr", "Metodo PNG nao suportado.", path)
            info = PngInfo(width, height, bit_depth, color_type)
            seen_ihdr = True
        elif chunk_type == b"IDAT":
            seen_idat = True
        elif chunk_type == b"IEND":
            if length != 0 or seen_iend:
                _invalid("png_iend", "IEND invalido ou repetido.", path)
            seen_iend = True
            if end != len(data):
                _invalid("png_trailing_data", "Dados apos IEND nao sao permitidos.", path)
        elif chunk_type in {b"acTL", b"fcTL", b"fdAT"}:
            _invalid("apng_not_allowed", "APNG nao e permitido; use sprite sheet horizontal.", path)
        elif chunk_type[0] & 0x20 == 0 and chunk_type != b"PLTE":
            _invalid("png_critical_chunk", "Chunk PNG critico desconhecido.", path)
        offset = end
    if not seen_ihdr or not seen_idat or not seen_iend or info is None:
        _invalid("png_structure", "PNG deve conter IHDR, IDAT e IEND.", path)
    return info


def _validate_text(data: bytes, *, path: str, limit: int) -> str:
    if len(data) > limit:
        _invalid("text_too_large", "Arquivo de texto excede o limite.", path)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        _invalid("text_encoding", "Texto deve usar UTF-8.", path)
    if "\x00" in text:
        _invalid("text_nul", "Texto nao pode conter NUL.", path)
    return text


def _validate_behavior_fragments(behaviors: Any, phrases: Any, manifest: Mapping[str, Any]) -> None:
    phrase_groups = phrases.get("groups", phrases.get("phrases", [])) if isinstance(phrases, dict) else phrases
    triggers = behaviors.get("triggers", behaviors.get("behaviors", [])) if isinstance(behaviors, dict) else behaviors
    if not isinstance(phrase_groups, list) or not isinstance(triggers, list):
        _invalid("behavior_contract", "Falas e comportamentos devem declarar listas.", "behaviors.json")
    if len(phrase_groups) > 250 or len(triggers) > 500:
        _invalid("behavior_limit", "Pacote excede o limite de falas ou gatilhos.", "behaviors.json")
    phrase_ids: set[str] = set()
    macro_pattern = re.compile(r"{{\s*([a-z][a-z0-9_]*)\s*}}")
    allowed_macros = {
        "hora", "data", "tempo_sem_interacao", "temperatura", "clima", "cpu", "ram", "disco",
        "gpu", "gpu_memoria", "codex_5h_percentual", "codex_5h_reset", "codex_5h_atingido",
        "codex_semanal_percentual", "codex_semanal_reset", "codex_semanal_atingido", "coleta_status",
        "ultima_atualizacao",
    }
    def validate_speech(text: Any, path: str) -> None:
        if not isinstance(text, str) or not 1 <= len(text) <= 160:
            _invalid("phrase_contract", "Fala deve conter entre 1 e 160 caracteres.", path)
        tokens = re.findall(r"{{[^{}]*}}", text)
        malformed = any(macro_pattern.fullmatch(token) is None for token in tokens)
        if text.count("{{") != text.count("}}") or malformed or any(name not in allowed_macros for name in macro_pattern.findall(text)):
            _invalid("phrase_macro", "Fala contém macro inválida ou desconhecida.", path)

    for index, group in enumerate(phrase_groups):
        if not isinstance(group, dict) or not re.fullmatch(r"[a-z][a-z0-9_]*", str(group.get("id") or "")):
            _invalid("phrase_contract", "Grupo de falas requer ID seguro.", f"phrases.json.groups[{index}]")
        identifier = group["id"]
        if identifier in phrase_ids:
            _invalid("phrase_contract", "ID de fala duplicado.", f"phrases.json.groups[{index}].id")
        phrase_ids.add(identifier)
        texts = group.get("texts")
        if not isinstance(texts, list) or not texts or len(texts) > 50 or any(not isinstance(text, str) or not 1 <= len(text) <= 160 for text in texts):
            _invalid("phrase_contract", "Grupo deve conter falas curtas.", f"phrases.json.groups[{index}].texts")
        for text_index, text in enumerate(texts):
            validate_speech(text, f"phrases.json.groups[{index}].texts[{text_index}]")
    trigger_ids: set[str] = set()
    allowed_cards = {"hora", "interacao", "temperatura", "maquina", "codex_5h", "codex_semanal", "status"}
    allowed_operators = {">", ">=", "<", "<=", "==", "between"}
    def validate_condition(node: Any, path: str, depth: int = 0) -> None:
        if depth > 12 or not isinstance(node, dict):
            _invalid("behavior_condition", "Condição inválida ou profunda demais.", path)
        branches = [key for key in ("all", "any") if key in node]
        if branches:
            if len(branches) != 1 or len(node) != 1:
                _invalid("behavior_condition", "Grupo deve usar apenas all ou any.", path)
            children = node[branches[0]]
            if not isinstance(children, list) or not children or len(children) > 20:
                _invalid("behavior_condition", "Grupo lógico vazio ou acima do limite.", path)
            for child_index, child in enumerate(children):
                validate_condition(child, f"{path}.{branches[0]}[{child_index}]", depth + 1)
            return
        if "metric" in node:
            if not isinstance(node.get("metric"), str) or node.get("operator") not in allowed_operators or "value" not in node:
                _invalid("behavior_condition", "Comparação de métrica inválida.", path)
            if node["operator"] == "between" and (not isinstance(node["value"], list) or len(node["value"]) != 2):
                _invalid("behavior_condition", "between requer dois limites.", path)
            return
        if "event" in node and isinstance(node["event"], dict) and isinstance(node["event"].get("type"), str):
            return
        if "timeRange" in node and isinstance(node["timeRange"], dict) and all(isinstance(node["timeRange"].get(key), str) for key in ("start", "end")):
            return
        _invalid("behavior_condition", "Condição deve declarar métrica, evento, horário, all ou any.", path)

    for index, trigger in enumerate(triggers):
        if not isinstance(trigger, dict) or not re.fullmatch(r"[a-z][a-z0-9_]*", str(trigger.get("id") or "")):
            _invalid("behavior_contract", "Gatilho requer ID seguro.", f"behaviors.json.triggers[{index}]")
        if trigger["id"] in trigger_ids:
            _invalid("behavior_contract", "ID de gatilho duplicado.", f"behaviors.json.triggers[{index}].id")
        trigger_ids.add(trigger["id"])
        if not isinstance(trigger.get("when"), dict) or not isinstance(trigger.get("targetCard"), str) or trigger.get("targetCard") not in allowed_cards or not isinstance(trigger.get("spriteState"), str) or trigger.get("spriteState") not in manifest.get("states", {}):
            _invalid("behavior_contract", "Gatilho deve declarar when, targetCard e spriteState.", f"behaviors.json.triggers[{index}]")
        validate_condition(trigger["when"], f"behaviors.json.triggers[{index}].when")
        for field in ("enabled", "persistent", "repeatWhileActive", "preventRepeat"):
            if field in trigger and not isinstance(trigger[field], bool):
                _invalid("behavior_contract", f"{field} deve ser booleano.", f"behaviors.json.triggers[{index}].{field}")
        numeric_limits = {"priority": (0, 1000, True), "cooldownSeconds": (0, None, False), "durationSeconds": (0, 120, False), "holdSeconds": (0, 120, False)}
        for field, (minimum, maximum, integer) in numeric_limits.items():
            if field not in trigger:
                continue
            value = trigger[field]
            valid_number = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))
            if not valid_number or value < minimum or (maximum is not None and value > maximum) or (integer and not isinstance(value, int)):
                _invalid("behavior_contract", f"{field} fora do contrato.", f"behaviors.json.triggers[{index}].{field}")
        references = trigger.get("phraseRefs", [])
        if not isinstance(references, list) or any(not isinstance(reference, str) or reference not in phrase_ids for reference in references):
            _invalid("phrase_reference", "Gatilho referencia grupo de falas inexistente.", f"behaviors.json.triggers[{index}].phraseRefs")
        direct = trigger.get("phrases", [])
        fallback = trigger.get("fallbackPhrase")
        if not isinstance(direct, list) or len(direct) > 50:
            _invalid("behavior_contract", "phrases deve ser uma lista limitada.", f"behaviors.json.triggers[{index}].phrases")
        for text_index, text in enumerate(direct):
            validate_speech(text, f"behaviors.json.triggers[{index}].phrases[{text_index}]")
        if fallback is not None:
            validate_speech(fallback, f"behaviors.json.triggers[{index}].fallbackPhrase")
        if not references and not direct and not fallback:
            _invalid("behavior_contract", "Gatilho deve declarar fala, referência ou fallback.", f"behaviors.json.triggers[{index}]")


def _validate_behavior_contract_strict(behaviors: Any, phrases: Any, manifest: Mapping[str, Any]) -> None:
    """Mirror the public Studio fragment contract before a package can be installed."""

    if isinstance(behaviors, dict):
        if set(behaviors) - {"schemaVersion", "triggers", "behaviors"}:
            _invalid("behavior_contract", "behaviors.json has unknown properties.", "behaviors.json")
        if "triggers" in behaviors and "behaviors" in behaviors:
            _invalid("behavior_contract", "Declare triggers or behaviors, not both.", "behaviors.json")
        triggers = behaviors.get("triggers", behaviors.get("behaviors", []))
    else:
        triggers = behaviors
    if isinstance(phrases, dict):
        if set(phrases) - {"schemaVersion", "personality", "groups", "phrases"}:
            _invalid("phrase_contract", "phrases.json has unknown properties.", "phrases.json")
        if "groups" in phrases and "phrases" in phrases:
            _invalid("phrase_contract", "Declare groups or phrases, not both.", "phrases.json")
        groups = phrases.get("groups", phrases.get("phrases", []))
    else:
        groups = phrases
    if not isinstance(triggers, list) or not isinstance(groups, list):
        _invalid("behavior_contract", "Behavior fragments must be lists.", "behaviors.json")

    def number(value: Any, *, minimum: float | None = None, maximum: float | None = None, integer: bool = False) -> bool:
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
            return False
        if integer and not isinstance(value, int):
            return False
        return (minimum is None or value >= minimum) and (maximum is None or value <= maximum)

    metric_pattern = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")
    time_pattern = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")
    event_types = {"user_return", "collection_error", "collection_stale", "collection_recovery", "value_change", "click", "drag", "random_interval"}
    cards = {"hora", "interacao", "temperatura", "maquina", "codex_5h", "codex_semanal", "status"}
    behavior_states = {"idle", "walk", "inspect", "point", "talk", "happy", "worried", "critical", "hot", "cold", "sleep", "wake", "confused", "celebrate"}
    weekdays = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
    macro_pattern = re.compile(r"{{\s*([a-z][a-z0-9_]*)\s*}}")
    allowed_macros = {
        "hora", "data", "tempo_sem_interacao", "temperatura", "clima", "cpu", "ram", "disco",
        "gpu", "gpu_memoria", "codex_5h_percentual", "codex_5h_reset", "codex_5h_atingido",
        "codex_semanal_percentual", "codex_semanal_reset", "codex_semanal_atingido", "coleta_status",
        "ultima_atualizacao",
    }

    def speech(text: Any, path: str) -> None:
        if not isinstance(text, str) or not 1 <= len(text) <= 160:
            _invalid("phrase_contract", "Phrase must contain 1 to 160 characters.", path)
        tokens = re.findall(r"{{[^{}]*}}", text)
        if text.count("{{") != text.count("}}") or any(macro_pattern.fullmatch(token) is None for token in tokens) or any(name not in allowed_macros for name in macro_pattern.findall(text)):
            _invalid("phrase_macro", "Phrase contains an invalid or unknown macro.", path)

    def condition(node: Any, path: str, depth: int = 0) -> None:
        if not isinstance(node, dict) or depth > 12:
            _invalid("behavior_condition", "Condition is invalid or too deeply nested.", path)
        if set(node) == {"all"} or set(node) == {"any"}:
            key = next(iter(node))
            children = node[key]
            if not isinstance(children, list) or not 1 <= len(children) <= 20:
                _invalid("behavior_condition", "Logical groups require 1 to 20 conditions.", path)
            for index, child in enumerate(children):
                condition(child, f"{path}.{key}[{index}]", depth + 1)
            return
        if set(node) == {"metric", "operator", "value"}:
            metric, operator, value = node["metric"], node["operator"], node["value"]
            if not isinstance(metric, str) or not metric_pattern.fullmatch(metric) or operator not in {">", ">=", "<", "<=", "==", "between"}:
                _invalid("behavior_condition", "Metric comparison is invalid.", path)
            if operator == "between":
                if not isinstance(value, list) or len(value) != 2 or not all(number(item) for item in value) or value[1] < value[0]:
                    _invalid("behavior_condition", "between requires two ordered numbers.", f"{path}.value")
            elif not (isinstance(value, (str, bool)) or number(value)):
                _invalid("behavior_condition", "Scalar comparison value is invalid.", f"{path}.value")
            return
        if set(node) == {"event"} and isinstance(node["event"], dict):
            event = node["event"]
            allowed = {"type", "metric", "card", "phase", "minDelta", "minIntervalSeconds", "intervalSeconds"}
            event_type = event.get("type")
            if set(event) - allowed or not isinstance(event_type, str) or event_type not in event_types:
                _invalid("behavior_condition", "Event type or property is invalid.", f"{path}.event")
            if "metric" in event and (not isinstance(event["metric"], str) or not metric_pattern.fullmatch(event["metric"])):
                _invalid("behavior_condition", "Event metric is invalid.", f"{path}.event.metric")
            if "card" in event and (not isinstance(event["card"], str) or event["card"] not in cards | {"sprite"}):
                _invalid("behavior_condition", "Event card is invalid.", f"{path}.event.card")
            if "phase" in event and (not isinstance(event["phase"], str) or event["phase"] not in {"start", "move", "end"}):
                _invalid("behavior_condition", "Drag phase is invalid.", f"{path}.event.phase")
            for field in ("minDelta", "minIntervalSeconds"):
                if field in event and not number(event[field], minimum=0):
                    _invalid("behavior_condition", f"{field} must be non-negative.", f"{path}.event.{field}")
            if event_type == "value_change" and "metric" not in event:
                _invalid("behavior_condition", "value_change requires metric.", f"{path}.event")
            if event_type == "click" and "card" not in event:
                _invalid("behavior_condition", "click requires card.", f"{path}.event")
            interval = event.get("intervalSeconds")
            if event_type == "random_interval":
                if not isinstance(interval, dict) or set(interval) != {"min", "max"} or not all(number(interval.get(field), minimum=0) for field in ("min", "max")) or interval["max"] < interval["min"]:
                    _invalid("behavior_condition", "random_interval requires an ordered range.", f"{path}.event.intervalSeconds")
            elif interval is not None:
                _invalid("behavior_condition", "intervalSeconds is only valid for random_interval.", f"{path}.event.intervalSeconds")
            return
        if set(node) == {"timeRange"} and isinstance(node["timeRange"], dict):
            value = node["timeRange"]
            if set(value) - {"start", "end", "days"} or not all(isinstance(value.get(field), str) and time_pattern.fullmatch(value[field]) for field in ("start", "end")):
                _invalid("behavior_condition", "Time range requires valid HH:MM values.", f"{path}.timeRange")
            days = value.get("days")
            if days is not None and (not isinstance(days, list) or not days or any(not isinstance(day, str) for day in days) or len(days) != len(set(days)) or any(day not in weekdays for day in days)):
                _invalid("behavior_condition", "Time range days are invalid.", f"{path}.timeRange.days")
            return
        _invalid("behavior_condition", "Condition does not match the Studio contract.", path)

    phrase_ids: set[str] = set()
    for index, group in enumerate(groups):
        path = f"phrases.json.groups[{index}]"
        if not isinstance(group, dict) or set(group) - {"id", "texts", "weight"}:
            _invalid("phrase_contract", "Phrase group properties are invalid.", path)
        identifier = group.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", identifier) or identifier in phrase_ids:
            _invalid("phrase_contract", "Phrase group ID is invalid or duplicated.", f"{path}.id")
        phrase_ids.add(identifier)
        texts = group.get("texts")
        if not isinstance(texts, list) or not 1 <= len(texts) <= 50 or len(texts) != len(set(texts)):
            _invalid("phrase_contract", "Phrase group texts are invalid or duplicated.", f"{path}.texts")
        if "weight" in group and (not number(group["weight"], minimum=0) or group["weight"] == 0):
            _invalid("phrase_contract", "Phrase weight must be greater than zero.", f"{path}.weight")

    allowed_trigger = {
        "id", "name", "enabled", "when", "targetCard", "spriteState", "character", "topic",
        "phrases", "phraseRefs", "characterPhrases", "fallbackPhrase", "preventRepeat", "priority",
        "cooldownSeconds", "durationSeconds", "persistent", "repeatWhileActive", "holdSeconds",
    }
    required_trigger = {"id", "enabled", "when", "targetCard", "spriteState", "priority", "cooldownSeconds"}
    trigger_ids: set[str] = set()
    for index, trigger in enumerate(triggers):
        path = f"behaviors.json.triggers[{index}]"
        if not isinstance(trigger, dict) or set(trigger) - allowed_trigger or not required_trigger <= set(trigger):
            _invalid("behavior_contract", "Trigger properties are invalid or incomplete.", path)
        identifier = trigger.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", identifier) or identifier in trigger_ids:
            _invalid("behavior_contract", "Trigger ID is invalid or duplicated.", f"{path}.id")
        trigger_ids.add(identifier)
        if "name" in trigger and (not isinstance(trigger["name"], str) or not 1 <= len(trigger["name"]) <= 80):
            _invalid("behavior_contract", "Trigger name is invalid.", f"{path}.name")
        if "topic" in trigger and (not isinstance(trigger["topic"], str) or not re.fullmatch(r"[a-z][a-z0-9_]*", trigger["topic"])):
            _invalid("behavior_contract", "Trigger topic is invalid.", f"{path}.topic")
        if not isinstance(trigger["enabled"], bool) or trigger["targetCard"] not in cards or trigger["spriteState"] not in behavior_states or trigger["spriteState"] not in manifest.get("states", {}):
            _invalid("behavior_contract", "Trigger state, card, or enabled flag is invalid.", path)
        condition(trigger["when"], f"{path}.when")
        if not number(trigger["priority"], minimum=0, maximum=1000, integer=True) or not number(trigger["cooldownSeconds"], minimum=0):
            _invalid("behavior_contract", "Trigger priority or cooldown is invalid.", path)
        for field in ("durationSeconds", "holdSeconds"):
            if field in trigger and not number(trigger[field], minimum=0, maximum=120):
                _invalid("behavior_contract", f"{field} is outside the contract.", f"{path}.{field}")
        for field in ("persistent", "repeatWhileActive", "preventRepeat"):
            if field in trigger and not isinstance(trigger[field], bool):
                _invalid("behavior_contract", f"{field} must be boolean.", f"{path}.{field}")
        references = trigger.get("phraseRefs", [])
        if not isinstance(references, list) or any(not isinstance(reference, str) for reference in references) or len(references) != len(set(references)) or any(reference not in phrase_ids for reference in references):
            _invalid("phrase_reference", "Trigger phrase references are invalid.", f"{path}.phraseRefs")
        direct = trigger.get("phrases", [])
        if not isinstance(direct, list) or len(direct) > 50 or any(not isinstance(text, str) for text in direct) or len(direct) != len(set(direct)):
            _invalid("behavior_contract", "Trigger phrases are invalid.", f"{path}.phrases")
        character_phrases = trigger.get("characterPhrases", {})
        if not isinstance(character_phrases, dict) or ("characterPhrases" in trigger and not character_phrases):
            _invalid("behavior_contract", "Character phrases must be a non-empty map.", f"{path}.characterPhrases")
        for character_id, texts in character_phrases.items():
            if not isinstance(character_id, str) or not _ID_PATTERN.fullmatch(character_id) or not isinstance(texts, list) or not 1 <= len(texts) <= 50 or any(not isinstance(text, str) for text in texts) or len(texts) != len(set(texts)):
                _invalid("behavior_contract", "Character phrase entry is invalid.", f"{path}.characterPhrases.{character_id}")
            for text_index, text in enumerate(texts):
                speech(text, f"{path}.characterPhrases.{character_id}[{text_index}]")
        if not references and not direct and not character_phrases and not trigger.get("fallbackPhrase"):
            _invalid("behavior_contract", "Trigger requires a phrase source.", path)


def _string(value: Any, path: str, *, maximum: int = 160) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        _invalid("manifest_field", "Campo de texto obrigatorio invalido.", path)
    return value.strip()


def _string_list(value: Any, path: str, *, maximum: int = 64) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        _invalid("manifest_field", "Campo deve ser uma lista limitada.", path)
    result: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        text = _string(item, f"{path}[{index}]", maximum=64)
        key = text.casefold()
        if key in seen:
            _invalid("manifest_duplicate", "Lista nao pode conter duplicatas.", f"{path}[{index}]")
        seen.add(key)
        result.append(text)
    return result


def _version_satisfies(version: SemVer, expression: str) -> bool:
    expression = expression.strip()
    if not expression or expression == "*":
        return True
    for alternative in expression.split("||"):
        alternative = alternative.strip()
        hyphen = re.fullmatch(r"([^ ]+)\s+-\s+([^ ]+)", alternative)
        if hyphen:
            if SemVer.parse(hyphen.group(1), path="$.compatibility") <= version <= SemVer.parse(hyphen.group(2), path="$.compatibility"):
                return True
            continue
        clauses = [item for item in re.split(r"[\s,]+", alternative) if item]
        matches = True
        for clause in clauses:
            wildcard = re.fullmatch(r"(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?", clause)
            if wildcard and any(item in {None, "x", "X", "*"} for item in wildcard.groups()[1:]):
                major = int(wildcard.group(1))
                minor = wildcard.group(2)
                if version.major != major or (minor not in {None, "x", "X", "*"} and version.minor != int(minor)):
                    matches = False
                continue
            operator = "="
            raw_version = clause
            for prefix in (">=", "<=", ">", "<", "=", "^", "~"):
                if clause.startswith(prefix):
                    operator, raw_version = prefix, clause[len(prefix) :]
                    break
            target = SemVer.parse(raw_version, path="$.compatibility")
            if operator == ">=" and not version >= target:
                matches = False
            elif operator == "<=" and not version <= target:
                matches = False
            elif operator == ">" and not version > target:
                matches = False
            elif operator == "<" and not version < target:
                matches = False
            elif operator == "=" and version._compare(target) != 0:
                matches = False
            elif operator == "^":
                ceiling = SemVer(target.major + 1, 0, 0) if target.major else (SemVer(0, target.minor + 1, 0) if target.minor else SemVer(0, 0, target.patch + 1))
                if not target <= version < ceiling:
                    matches = False
            elif operator == "~":
                if not target <= version < SemVer(target.major, target.minor + 1, 0):
                    matches = False
        if matches:
            return True
    return False


def _compatibility_expression(value: Any) -> tuple[str | None, SemVer | None, SemVer | None, bool]:
    if isinstance(value, str):
        return value, None, None, False
    if not isinstance(value, dict) or not value:
        _invalid("compatibility", "Compatibilidade deve declarar uma faixa de versoes.", "$.compatibility")
    if isinstance(value.get("dashboard"), dict):
        value = value["dashboard"]
    expression = next((value.get(key) for key in ("app", "codex", "codexUsageMonitor", "range") if isinstance(value.get(key), str)), None)
    minimum_raw = next((value.get(key) for key in ("min", "minimum", "minVersion", "minAppVersion") if value.get(key) is not None), None)
    maximum_raw = next((value.get(key) for key in ("max", "maximum", "maxVersion", "maxAppVersion") if value.get(key) is not None), None)
    exclusive_raw = value.get("maxExclusive")
    minimum = SemVer.parse(minimum_raw, path="$.compatibility.min") if minimum_raw is not None else None
    maximum = SemVer.parse(exclusive_raw if exclusive_raw is not None else maximum_raw, path="$.compatibility.max") if (exclusive_raw is not None or maximum_raw is not None) else None
    exclusive = exclusive_raw is not None
    if expression is None and minimum is None and maximum is None:
        _invalid("compatibility", "Compatibilidade nao contem uma faixa reconhecida.", "$.compatibility")
    return expression, minimum, maximum, exclusive


def is_compatible(compatibility: Any, app_version: str = CURRENT_APP_VERSION) -> bool:
    current = SemVer.parse(app_version, path="appVersion")
    expression, minimum, maximum, exclusive = _compatibility_expression(compatibility)
    if expression is not None and not _version_satisfies(current, expression):
        return False
    if minimum is not None and current < minimum:
        return False
    if maximum is not None and (current >= maximum if exclusive else current > maximum):
        return False
    return True


def _manifest_assets(value: Any, *, limits: PackageLimits) -> dict[str, dict[str, Any]]:
    if isinstance(value, list):
        items: Iterable[tuple[str, Any]] = ((str(index), item) for index, item in enumerate(value))
    elif isinstance(value, dict):
        items = value.items()
    else:
        _invalid("assets", "assets deve ser objeto ou lista.", "$.assets")
    result: dict[str, dict[str, Any]] = {}
    count = 0
    for name, raw in items:
        count += 1
        if count > limits.assets:
            _invalid("asset_limit", "Manifesto excede o limite de assets.", "$.assets")
        if isinstance(raw, str):
            spec = {"path": raw}
        elif isinstance(raw, dict):
            spec = dict(raw)
        else:
            _invalid("asset", "Definicao de asset invalida.", f"$.assets.{name}")
        path_value = spec.get("path") or spec.get("asset") or spec.get("file")
        if path_value is None and isinstance(name, str) and name.startswith("assets/"):
            path_value = name
        path = _safe_archive_path(path_value) if isinstance(path_value, str) else ""
        if not path.startswith("assets/") or not path.lower().endswith(".png"):
            _invalid("asset_path", "Asset deve apontar para assets/*.png.", f"$.assets.{name}")
        media_type = spec.get("mediaType", spec.get("mime"))
        if media_type is not None and media_type != "image/png":
            _invalid("asset_mime", "MIME de asset deve ser image/png.", f"$.assets.{name}")
        if path in result:
            _invalid("asset_duplicate", "Asset declarado mais de uma vez.", f"$.assets.{name}")
        result[path] = spec
    if not result:
        _invalid("assets", "Ao menos um asset e obrigatorio.", "$.assets")
    return result


def _manifest_checksums(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or not value:
        _invalid("checksums", "checksums deve mapear arquivos para SHA-256.", "$.checksums")
    if "files" in value:
        if value.get("algorithm", "sha256") != "sha256" or not isinstance(value.get("files"), dict):
            _invalid("checksums", "checksums deve usar SHA-256 e declarar files.", "$.checksums")
        value = value["files"]
    result: dict[str, str] = {}
    for raw_path, raw_digest in value.items():
        path = _safe_archive_path(raw_path) if isinstance(raw_path, str) else ""
        digest = raw_digest.get("sha256") if isinstance(raw_digest, dict) else raw_digest
        if not isinstance(digest, str) or not _SHA256_PATTERN.fullmatch(digest):
            _invalid("checksum_format", "Checksum deve ser SHA-256 hexadecimal.", f"$.checksums.{raw_path}")
        if path in result:
            _invalid("checksum_duplicate", "Checksum duplicado.", f"$.checksums.{raw_path}")
        result[path] = digest.lower()
    return result


class CharacterPackageValidator:
    """Validates raw ZIP bytes and returns an immutable, fully inspected package."""

    def __init__(self, *, app_version: str = CURRENT_APP_VERSION, limits: PackageLimits = DEFAULT_LIMITS):
        SemVer.parse(app_version, path="appVersion")
        self.app_version = app_version
        self.limits = limits

    def inspect(self, archive: bytes | bytearray | memoryview, *, expected_id: str | None = None) -> dict[str, Any]:
        try:
            return self.validate(archive, expected_id=expected_id).report()
        except PackageValidationError as error:
            return {"valid": False, "errors": [item.as_dict() for item in error.issues], "manifest": None}

    def validate(self, archive: bytes | bytearray | memoryview, *, expected_id: str | None = None) -> ValidatedCharacterPackage:
        if not isinstance(archive, (bytes, bytearray, memoryview)):
            _invalid("archive_type", "Pacote deve ser fornecido como bytes ZIP crus.", "$.zip")
        raw = bytes(archive)
        if not raw or len(raw) > self.limits.archive_bytes:
            _invalid("archive_size", "Tamanho do ZIP vazio ou acima do limite.", "$.zip")
        if not raw.startswith(b"PK"):
            _invalid("zip_signature", "Pacote nao possui assinatura ZIP.", "$.zip")
        try:
            zip_file = zipfile.ZipFile(io.BytesIO(raw), "r")
        except (zipfile.BadZipFile, OSError, EOFError):
            _invalid("invalid_zip", "Arquivo ZIP invalido.", "$.zip")
        with zip_file:
            if len(zip_file.comment) > 1024:
                _invalid("zip_comment", "Comentario ZIP excede o limite.", "$.zip")
            files, total = self._read_entries(zip_file)
        missing = sorted(_REQUIRED_PACKAGE_FILES - files.keys())
        if missing:
            _invalid("missing_file", f"Arquivos obrigatorios ausentes: {', '.join(missing)}.", "$.zip")
        manifest = _strict_json(files["manifest.json"], path="manifest.json", max_bytes=self.limits.json_bytes)
        if not isinstance(manifest, dict):
            _invalid("manifest_type", "manifest.json deve conter um objeto.", "manifest.json")
        parsed = self._validate_manifest(manifest, files, expected_id=expected_id)
        behaviors = _strict_json(files["behaviors.json"], path="behaviors.json", max_bytes=self.limits.json_bytes)
        phrases = _strict_json(files["phrases.json"], path="phrases.json", max_bytes=self.limits.json_bytes)
        if not isinstance(behaviors, (dict, list)):
            _invalid("behaviors_type", "behaviors.json deve conter objeto ou lista.", "behaviors.json")
        if not isinstance(phrases, (dict, list)):
            _invalid("phrases_type", "phrases.json deve conter objeto ou lista.", "phrases.json")
        _validate_behavior_fragments(behaviors, phrases, parsed)
        _validate_behavior_contract_strict(behaviors, phrases, parsed)
        _validate_text(files["LICENSE.txt"], path="LICENSE.txt", limit=self.limits.text_bytes)
        pngs = {
            path: _validate_png(data, path=path, limits=self.limits)
            for path, data in files.items()
            if path.lower().endswith(".png")
        }
        self._validate_dimensions(parsed, pngs)
        frozen_files = MappingProxyType(dict(files))
        frozen_pngs = MappingProxyType(dict(pngs))
        return ValidatedCharacterPackage(
            manifest=MappingProxyType(deepcopy(parsed)),
            files=frozen_files,
            pngs=frozen_pngs,
            archive_sha256=_sha256(raw),
            archive_bytes=len(raw),
            uncompressed_bytes=total,
        )

    def _read_entries(self, archive: zipfile.ZipFile) -> tuple[dict[str, bytes], int]:
        infos = archive.infolist()
        if not infos:
            _invalid("empty_zip", "ZIP nao contem arquivos.", "$.zip")
        file_count = 0
        directory_count = 0
        total = 0
        portable: dict[str, str] = {}
        file_paths: set[str] = set()
        files: dict[str, bytes] = {}
        for info in infos:
            is_directory = info.is_dir() or info.filename.endswith("/")
            path = _safe_archive_path(info.filename, directory=is_directory)
            encoded_length = len(path.encode("utf-8"))
            if encoded_length > self.limits.path_bytes:
                _invalid("path_length", "Caminho ZIP excede o limite.", path)
            key = _portable_key(path)
            if key in portable:
                _invalid("path_collision", "Entradas ZIP colidem por Unicode/casefold.", path)
            portable[key] = path
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                _invalid("zip_link", "Links simbolicos nao sao permitidos.", path)
            file_type = stat.S_IFMT(mode)
            if file_type and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                _invalid("zip_special_file", "Entradas especiais nao sao permitidas.", path)
            if info.external_attr & 0x400:
                _invalid("zip_reparse", "Reparse points nao sao permitidos.", path)
            if info.flag_bits & 0x1:
                _invalid("zip_encrypted", "ZIP criptografado nao e permitido.", path)
            if info.compress_type not in _ALLOWED_COMPRESSION:
                _invalid("zip_method", "Metodo ZIP nao permitido; use store ou deflate.", path)
            if is_directory:
                directory_count += 1
                if directory_count > self.limits.directories:
                    _invalid("directory_limit", "ZIP excede o limite de diretorios.", path)
                if info.file_size or info.compress_size:
                    _invalid("directory_payload", "Diretorio ZIP nao pode conter payload.", path)
                if path != "assets" and not path.startswith("assets/"):
                    _invalid("directory_path", "Somente diretorios abaixo de assets/ sao permitidos.", path)
                continue
            file_count += 1
            if file_count > self.limits.files:
                _invalid("file_limit", "ZIP excede o limite de arquivos.", path)
            if info.file_size < 0 or info.file_size > self.limits.file_uncompressed_bytes:
                _invalid("file_size", "Arquivo descompactado excede o limite.", path)
            total += info.file_size
            if total > self.limits.total_uncompressed_bytes:
                _invalid("zip_bomb", "Total descompactado excede o limite.", "$.zip")
            if info.file_size and info.compress_size == 0:
                _invalid("zip_bomb", "Razao de compactacao invalida.", path)
            if info.compress_size and info.file_size / info.compress_size > self.limits.compression_ratio:
                _invalid("zip_bomb", "Razao de compactacao excede o limite.", path)
            if path in file_paths:
                _invalid("duplicate_path", "Arquivo ZIP duplicado.", path)
            file_paths.add(path)
            try:
                with archive.open(info, "r") as source:
                    data = source.read(self.limits.file_uncompressed_bytes + 1)
                    if source.read(1):
                        _invalid("file_size", "Arquivo excede o limite durante leitura.", path)
            except (zipfile.BadZipFile, RuntimeError, OSError, EOFError):
                _invalid("zip_crc", "Falha de integridade/CRC ao ler o ZIP.", path)
            if len(data) != info.file_size or len(data) > self.limits.file_uncompressed_bytes:
                _invalid("zip_size_mismatch", "Tamanho ZIP declarado diverge do conteudo.", path)
            self._validate_allowed_path(path)
            files[path] = data
        portable_files = {_portable_key(path) for path in file_paths}
        for path in file_paths:
            parts = path.split("/")
            prefixes = {_portable_key("/".join(parts[:index])) for index in range(1, len(parts))}
            if prefixes & portable_files:
                _invalid("path_collision", "Arquivo tambem e usado como diretorio.", path)
        return files, total

    @staticmethod
    def _validate_allowed_path(path: str) -> None:
        if path in _ALLOWED_ROOT_FILES:
            return
        if path.startswith("assets/") and path.lower().endswith(".png") and path.count("/") >= 1:
            return
        _invalid("file_type", "Somente JSON, PNG e LICENSE.txt previstos pelo contrato sao aceitos.", path)

    def _validate_manifest(self, manifest: dict[str, Any], files: Mapping[str, bytes], *, expected_id: str | None) -> dict[str, Any]:
        required = {
            "id", "name", "author", "version", "compatibility", "states", "assets",
            "personality", "tags", "capabilities", "checksums", "license", "fallback",
        }
        missing = sorted(required - manifest.keys())
        if missing:
            _invalid("manifest_required", f"Campos obrigatorios ausentes: {', '.join(missing)}.", "manifest.json")
        allowed = required | {
            "schemaVersion", "frame", "fps", "loop", "baseline", "anchor",
            "orientation", "visualIdentity", "groups", "description", "homepage",
        }
        unknown = sorted(set(manifest) - allowed)
        if unknown:
            _invalid("manifest_property", f"Campos de manifesto nao permitidos: {', '.join(unknown)}.", "manifest.json")
        schema_version = manifest.get("schemaVersion", PACKAGE_SCHEMA_VERSION)
        if schema_version != PACKAGE_SCHEMA_VERSION:
            _invalid("schema_version", "schemaVersion de pacote nao suportada.", "$.schemaVersion")
        character_id = manifest.get("id")
        if not isinstance(character_id, str) or not _ID_PATTERN.fullmatch(character_id):
            _invalid("character_id", "ID imutavel de personagem invalido.", "$.id")
        if expected_id is not None and character_id != expected_id:
            _invalid("id_mismatch", "ID do pacote difere do ID esperado.", "$.id")
        _string(manifest.get("name"), "$.name", maximum=120)
        author = manifest.get("author")
        if isinstance(author, str):
            _string(author, "$.author", maximum=160)
        elif isinstance(author, dict):
            _string(author.get("name"), "$.author.name", maximum=160)
            for optional in ("url", "email"):
                if optional in author:
                    _string(author[optional], f"$.author.{optional}", maximum=240)
        else:
            _invalid("author", "Autor deve ser texto ou objeto com nome.", "$.author")
        SemVer.parse(manifest.get("version"), path="$.version")
        compatible = is_compatible(manifest.get("compatibility"), self.app_version)
        if not compatible:
            _invalid("incompatible", f"Pacote incompativel com Codex Usage Monitor {self.app_version}.", "$.compatibility")
        _string_list(manifest.get("tags"), "$.tags", maximum=64)
        _string_list(manifest.get("capabilities"), "$.capabilities", maximum=64)
        frame = manifest.get("frame")
        if frame is not None:
            if not isinstance(frame, dict):
                _invalid("frame", "frame deve ser um objeto.", "$.frame")
            for key in ("width", "height"):
                value = frame.get(key)
                if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 2048:
                    _invalid("frame", "Dimensoes de frame devem ficar entre 1 e 2048.", f"$.frame.{key}")
            if frame.get("layout", "horizontal") != "horizontal":
                _invalid("frame_layout", "Somente sprite sheets horizontais sao aceitas.", "$.frame.layout")
        if "fps" in manifest:
            fps = manifest["fps"]
            if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not math.isfinite(float(fps)) or not 1 <= float(fps) <= 60:
                _invalid("fps", "FPS global deve ficar entre 1 e 60.", "$.fps")
        if "loop" in manifest and not isinstance(manifest["loop"], bool):
            _invalid("loop", "loop global deve ser booleano.", "$.loop")
        if "baseline" in manifest:
            baseline = manifest["baseline"]
            if isinstance(baseline, bool) or not isinstance(baseline, (int, float)) or not math.isfinite(float(baseline)) or not 0 <= float(baseline) <= 1:
                _invalid("baseline", "Baseline deve ficar entre 0 e 1.", "$.baseline")
        if "anchor" in manifest:
            anchor = manifest["anchor"]
            if not isinstance(anchor, dict) or any(
                isinstance(anchor.get(axis), bool)
                or not isinstance(anchor.get(axis), (int, float))
                or not math.isfinite(float(anchor[axis]))
                or not 0 <= float(anchor[axis]) <= 1
                for axis in ("x", "y")
            ):
                _invalid("anchor", "Ancora deve ter x/y normalizados.", "$.anchor")
        if "orientation" in manifest and manifest["orientation"] not in {"left", "right"}:
            _invalid("orientation", "Orientacao deve ser left ou right.", "$.orientation")
        personality = manifest.get("personality")
        if isinstance(personality, str):
            _string(personality, "$.personality", maximum=64)
        elif isinstance(personality, dict):
            _string(personality.get("id"), "$.personality.id", maximum=64)
            for key, expected in (("phrases", "phrases.json"), ("behaviors", "behaviors.json")):
                if key in personality and personality.get(key) != expected:
                    _invalid("personality_path", f"{key} deve apontar para {expected}.", f"$.personality.{key}")
        else:
            _invalid("personality", "Personalidade deve ser ID ou objeto com ID.", "$.personality")
        visual_identity = manifest.get("visualIdentity")
        if not isinstance(visual_identity, dict):
            _invalid("visual_identity", "visualIdentity deve ser um objeto.", "$.visualIdentity")
        _string(visual_identity.get("name", manifest.get("name")), "$.visualIdentity.name", maximum=120)
        baseline = visual_identity.get("baseline", 0.9)
        if isinstance(baseline, bool) or not isinstance(baseline, (int, float)) or not math.isfinite(float(baseline)) or not 0 <= float(baseline) <= 1:
            _invalid("baseline", "Baseline visual deve ficar entre 0 e 1.", "$.visualIdentity.baseline")
        anchor = visual_identity.get("anchor", {"x": 0.5, "y": 0.88})
        if not isinstance(anchor, dict) or any(
            isinstance(anchor.get(axis), bool)
            or not isinstance(anchor.get(axis), (int, float))
            or not math.isfinite(float(anchor[axis]))
            or not 0 <= float(anchor[axis]) <= 1
            for axis in ("x", "y")
        ):
            _invalid("anchor", "Ancora visual deve ter x/y normalizados.", "$.visualIdentity.anchor")
        if visual_identity.get("orientation", "right") not in {"left", "right"}:
            _invalid("orientation", "Orientacao visual deve ser left ou right.", "$.visualIdentity.orientation")
        license_value = manifest.get("license")
        if isinstance(license_value, str):
            _string(license_value, "$.license", maximum=120)
        elif isinstance(license_value, dict):
            if not any(isinstance(license_value.get(key), str) and license_value.get(key) for key in ("id", "name", "spdx")):
                _invalid("license", "Licenca deve declarar id, name ou spdx.", "$.license")
            license_file = license_value.get("file", "LICENSE.txt")
            if license_file != "LICENSE.txt":
                _invalid("license_path", "Arquivo de licenca deve ser LICENSE.txt.", "$.license.file")
        else:
            _invalid("license", "Licenca e obrigatoria.", "$.license")
        declared_assets = _manifest_assets(manifest.get("assets"), limits=self.limits)
        asset_aliases = {
            name: str(spec.get("path") or spec.get("asset") or spec.get("file") or name)
            for name, spec in (manifest.get("assets") or {}).items()
        } if isinstance(manifest.get("assets"), dict) else {}
        states = manifest.get("states")
        if not isinstance(states, dict) or not states or len(states) > self.limits.states:
            _invalid("states", "Estados devem formar um objeto nao vazio e limitado.", "$.states")
        fallback = manifest.get("fallback")
        if isinstance(fallback, dict):
            fallback = fallback.get("state")
        if not isinstance(fallback, str) or fallback not in states:
            _invalid("fallback", "Fallback deve apontar para um estado existente.", "$.fallback")
        total_frames = 0
        for state_name, raw_spec in states.items():
            if not isinstance(state_name, str) or not _STATE_PATTERN.fullmatch(state_name):
                _invalid("state_id", "ID de estado invalido.", f"$.states.{state_name}")
            if not isinstance(raw_spec, dict):
                _invalid("state", "Estado deve ser um objeto.", f"$.states.{state_name}")
            asset_path = raw_spec.get("asset") or raw_spec.get("path")
            asset_path = asset_aliases.get(asset_path, asset_path)
            asset_path = _safe_archive_path(asset_path) if isinstance(asset_path, str) else ""
            if asset_path not in declared_assets:
                _invalid("undeclared_asset", "Estado referencia asset nao declarado.", f"$.states.{state_name}.asset")
            frame_spec = raw_spec.get("frame") if isinstance(raw_spec.get("frame"), dict) else {}
            frames = raw_spec.get("frames", frame_spec.get("count", 1))
            if isinstance(frames, bool) or not isinstance(frames, int) or not 1 <= frames <= self.limits.frames_per_state:
                _invalid("frames", "Frames por estado fora do limite.", f"$.states.{state_name}.frames")
            total_frames += frames
            fps = raw_spec.get("fps", manifest.get("fps", 1))
            if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not math.isfinite(float(fps)) or not 1 <= float(fps) <= 60:
                _invalid("fps", "FPS deve ficar entre 1 e 60.", f"$.states.{state_name}.fps")
            if "loop" in raw_spec and not isinstance(raw_spec["loop"], bool):
                _invalid("loop", "loop deve ser booleano.", f"$.states.{state_name}.loop")
            state_fallback = raw_spec.get("fallback")
            if state_fallback is not None and state_fallback not in states:
                _invalid("fallback", "Fallback do estado deve existir no manifesto.", f"$.states.{state_name}.fallback")
        if total_frames > self.limits.total_frames:
            _invalid("frame_limit", "Total de frames do pacote excede o limite.", "$.states")
        missing_assets = sorted(set(declared_assets) - files.keys())
        if missing_assets:
            _invalid("missing_asset", f"Assets declarados ausentes: {', '.join(missing_assets)}.", "$.assets")
        undeclared_pngs = sorted(path for path in files if path.startswith("assets/") and path not in declared_assets)
        if undeclared_pngs:
            _invalid("undeclared_file", f"PNGs nao declarados: {', '.join(undeclared_pngs)}.", "$.assets")
        checksums = _manifest_checksums(manifest.get("checksums"))
        required_checksums = set(declared_assets) | {"behaviors.json", "phrases.json", "preview.png", "LICENSE.txt"}
        absent_checksums = sorted(required_checksums - checksums.keys())
        if absent_checksums:
            _invalid("missing_checksum", f"Checksums ausentes: {', '.join(absent_checksums)}.", "$.checksums")
        unknown_checksums = sorted(path for path in checksums if path not in files or path == "manifest.json")
        if unknown_checksums:
            _invalid("checksum_path", f"Checksums apontam para arquivos invalidos: {', '.join(unknown_checksums)}.", "$.checksums")
        for path, digest in checksums.items():
            if _sha256(files[path]) != digest:
                _invalid("checksum_mismatch", "Checksum SHA-256 invalido.", f"$.checksums.{path}")
        return deepcopy(manifest)

    def _validate_dimensions(self, manifest: Mapping[str, Any], pngs: Mapping[str, PngInfo]) -> None:
        frame = manifest.get("frame")
        global_width = frame.get("width") if isinstance(frame, dict) else None
        global_height = frame.get("height") if isinstance(frame, dict) else None
        if isinstance(frame, dict) and frame.get("layout", "horizontal") != "horizontal":
            _invalid("frame_layout", "Somente sprite sheets horizontais sao aceitas.", "$.frame.layout")
        raw_assets = manifest.get("assets") if isinstance(manifest.get("assets"), dict) else {}
        asset_aliases = {
            name: str(value.get("path") or value.get("asset") or value.get("file") or name) if isinstance(value, dict) else str(value)
            for name, value in raw_assets.items()
        }
        for state_name, spec in manifest["states"].items():
            asset = spec.get("asset") or spec.get("path")
            asset = asset_aliases.get(asset, asset)
            png = pngs[asset]
            frame_spec = spec.get("frame") if isinstance(spec.get("frame"), dict) else {}
            frames = int(spec.get("frames", frame_spec.get("count", 1)))
            frame_width = spec.get("frameWidth", frame_spec.get("width", global_width))
            frame_height = spec.get("frameHeight", frame_spec.get("height", global_height))
            if frame_width is not None:
                if isinstance(frame_width, bool) or not isinstance(frame_width, int) or not 1 <= frame_width <= 2048:
                    _invalid("frame_width", "Largura de frame invalida.", f"$.states.{state_name}")
                if png.width != frame_width * frames:
                    _invalid("sprite_dimensions", "Largura PNG nao corresponde a frameWidth * frames.", asset)
            elif png.width % frames:
                _invalid("sprite_dimensions", "Largura PNG nao e divisivel pelo total de frames.", asset)
            if frame_height is not None:
                if isinstance(frame_height, bool) or not isinstance(frame_height, int) or not 1 <= frame_height <= 2048:
                    _invalid("frame_height", "Altura de frame invalida.", f"$.states.{state_name}")
                if png.height != frame_height:
                    _invalid("sprite_dimensions", "Altura PNG nao corresponde ao frameHeight.", asset)


def _inside(path: Path, root: Path) -> Path:
    resolved_root = root.resolve()
    resolved = path.resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError as error:
        raise CharacterPackageError("Caminho recusado fora do registry.") from error
    return resolved


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _registry_revision(registry: Mapping[str, Any]) -> str:
    return _sha256(_canonical_bytes(registry))


ReferenceChecker = Callable[..., Any]


class CharacterPackageService:
    """Atomic runtime registry and lifecycle operations for character packages."""

    def __init__(
        self,
        *,
        registry_root: Path = CHARACTER_PACKAGE_REGISTRY_ROOT,
        native_package_root: Path = NATIVE_CHARACTER_PACKAGE_ROOT,
        app_version: str = CURRENT_APP_VERSION,
        limits: PackageLimits = DEFAULT_LIMITS,
        reference_checker: ReferenceChecker | None = None,
    ):
        self.registry_root = Path(registry_root).resolve()
        self.native_package_root = Path(native_package_root).resolve()
        self.installed_root = self.registry_root / "installed"
        self.archives_root = self.registry_root / "archives"
        self.staging_root = self.registry_root / ".staging"
        self.registry_path = self.registry_root / "registry.json"
        self.validator = CharacterPackageValidator(app_version=app_version, limits=limits)
        self.reference_checker = reference_checker
        self._lock = threading.RLock()
        self.registry_root.mkdir(parents=True, exist_ok=True)
        self.installed_root.mkdir(parents=True, exist_ok=True)
        self.archives_root.mkdir(parents=True, exist_ok=True)
        self.staging_root.mkdir(parents=True, exist_ok=True)
        for path in (self.installed_root, self.archives_root, self.staging_root, self.registry_path.parent):
            _inside(path, self.registry_root)
        with self._lock:
            if not self.registry_path.exists():
                self._write_registry(self._empty_registry())
            else:
                self._read_registry()

    @staticmethod
    def _empty_registry() -> dict[str, Any]:
        return {
            "schemaVersion": REGISTRY_SCHEMA_VERSION,
            "generation": 0,
            "updatedAt": None,
            "packages": {},
        }

    def _read_registry(self) -> dict[str, Any]:
        try:
            raw = self.registry_path.read_bytes()
            registry = _strict_json(raw, path=str(self.registry_path.name), max_bytes=4 * 1024 * 1024)
        except FileNotFoundError:
            registry = self._empty_registry()
        if not isinstance(registry, dict) or registry.get("schemaVersion") != REGISTRY_SCHEMA_VERSION:
            raise CharacterPackageError("Registry de personagens invalido ou incompativel.")
        if not isinstance(registry.get("generation"), int) or registry["generation"] < 0 or not isinstance(registry.get("packages"), dict):
            raise CharacterPackageError("Estrutura do registry de personagens invalida.")
        for character_id, record in registry["packages"].items():
            if not _ID_PATTERN.fullmatch(character_id) or not isinstance(record, dict) or not isinstance(record.get("versions"), dict):
                raise CharacterPackageError("Registro de personagem corrompido.")
            versions = record["versions"]
            if not versions:
                raise CharacterPackageError("Registro de personagem sem versoes.")
            try:
                for version, version_record in versions.items():
                    SemVer.parse(version, path="registry.version")
                    if not isinstance(version_record, dict) or version_record.get("version") != version:
                        raise CharacterPackageError("Registro de versao corrompido.")
                    digest = version_record.get("packageSha256")
                    manifest = version_record.get("manifest")
                    if not isinstance(digest, str) or not _SHA256_PATTERN.fullmatch(digest):
                        raise CharacterPackageError("Checksum de pacote ausente no registry.")
                    if not isinstance(manifest, dict) or manifest.get("id") != character_id or manifest.get("version") != version:
                        raise CharacterPackageError("Manifesto do registry diverge do registro.")
            except PackageValidationError as error:
                raise CharacterPackageError("SemVer invalido no registry.") from error
            active = record.get("activeVersion")
            if active is not None and active not in versions:
                raise CharacterPackageError("Versao ativa do registry nao existe.")
            if not isinstance(record.get("enabled"), bool) or not isinstance(record.get("native"), bool):
                raise CharacterPackageError("Flags do registry sao invalidas.")
        return registry

    def _write_registry(self, registry: dict[str, Any]) -> None:
        _atomic_write(_inside(self.registry_path, self.registry_root), _canonical_bytes(registry) + b"\n")

    def _check_revision(self, registry: Mapping[str, Any], expected_revision: str | None) -> str:
        current = _registry_revision(registry)
        if expected_revision is not None and expected_revision != current:
            raise PackageRevisionError("Registry foi alterado por outra operacao.", details={"currentRevision": current})
        return current

    def _commit(self, registry: dict[str, Any]) -> str:
        registry["generation"] = int(registry.get("generation", 0)) + 1
        registry["updatedAt"] = _utc_now()
        self._write_registry(registry)
        return _registry_revision(registry)

    def validate(self, archive: bytes | bytearray | memoryview, *, expected_id: str | None = None) -> dict[str, Any]:
        return self.validator.inspect(archive, expected_id=expected_id)

    def validate_or_raise(self, archive: bytes | bytearray | memoryview, *, expected_id: str | None = None) -> ValidatedCharacterPackage:
        return self.validator.validate(archive, expected_id=expected_id)

    validate_package = validate

    def catalog(self, *, include_disabled: bool = True) -> dict[str, Any]:
        with self._lock:
            registry = self._read_registry()
            characters = []
            for character_id, record in sorted(registry["packages"].items()):
                if not include_disabled and record.get("enabled") is False:
                    continue
                active = record.get("activeVersion")
                version_record = record.get("versions", {}).get(active, {})
                manifest = deepcopy(version_record.get("manifest"))
                characters.append({
                    "id": character_id,
                    "name": (manifest or {}).get("name", character_id),
                    "version": active,
                    "activeVersion": active,
                    "enabled": record.get("enabled") is not False,
                    "source": "native" if record.get("native") else "installed",
                    "native": bool(record.get("native")),
                    "compatible": True,
                    "versions": sorted(record.get("versions", {}), key=SemVer.parse, reverse=True),
                    "manifest": manifest,
                    "states": sorted((manifest or {}).get("states", {})),
                    "personality": (manifest or {}).get("personality"),
                    "tags": deepcopy((manifest or {}).get("tags", [])),
                    "capabilities": deepcopy((manifest or {}).get("capabilities", [])),
                    "packageSha256": version_record.get("packageSha256"),
                    "diagnostics": [],
                })
            return {
                "schemaVersion": REGISTRY_SCHEMA_VERSION,
                "appVersion": self.validator.app_version,
                "revision": _registry_revision(registry),
                "generation": registry["generation"],
                "updatedAt": registry.get("updatedAt"),
                "characters": characters,
            }

    def list_packages(self, *, include_disabled: bool = True) -> list[dict[str, Any]]:
        return self.catalog(include_disabled=include_disabled)["characters"]

    list = list_packages

    def install(
        self,
        archive: bytes | bytearray | memoryview,
        *,
        expected_revision: str | None = None,
        activate: bool = True,
        native: bool = False,
    ) -> dict[str, Any]:
        package = self.validator.validate(archive)
        raw = bytes(archive)
        if package.character_id in NATIVE_CHARACTER_IDS and not native:
            raise PackageConflictError("IDs de personagens nativos sao reservados.")
        if native and not self._official_native_matches(package, raw):
            raise PackageConflictError("Pacote nativo nao corresponde ao artefato oficial.")
        with self._lock:
            registry = self._read_registry()
            self._check_revision(registry, expected_revision)
            if package.character_id in registry["packages"]:
                raise PackageConflictError("Personagem ja instalado; use update().")
            self._remove_stored((self._version_directory(package.character_id, package.version), self._archive_path(package.character_id, package.version)))
            created = self._store_package(package, raw)
            try:
                registry["packages"][package.character_id] = self._new_record(package, native=native, activate=activate)
                revision = self._commit(registry)
            except Exception:
                self._remove_stored(created)
                raise
            return self._mutation_result(registry, package.character_id, revision)

    def update(
        self,
        archive: bytes | bytearray | memoryview,
        *,
        expected_revision: str | None = None,
        activate: bool = True,
    ) -> dict[str, Any]:
        package = self.validator.validate(archive)
        raw = bytes(archive)
        with self._lock:
            registry = self._read_registry()
            self._check_revision(registry, expected_revision)
            record = registry["packages"].get(package.character_id)
            if not record:
                raise PackageNotFoundError("Personagem nao instalado; use install().")
            if record.get("native") or package.character_id in NATIVE_CHARACTER_IDS:
                raise PackageConflictError("Personagens nativos so podem ser atualizados pela restauracao oficial.")
            if package.version in record["versions"]:
                raise PackageConflictError("Esta versao ja esta instalada.")
            highest = max((SemVer.parse(value) for value in record["versions"]), default=None)
            if highest is not None and SemVer.parse(package.version) <= highest:
                raise PackageConflictError("Atualizacao deve ter SemVer maior que as versoes instaladas.")
            created = self._store_package(package, raw)
            try:
                record["versions"][package.version] = self._version_record(package)
                if activate:
                    record["activeVersion"] = package.version
                    record["enabled"] = True
                revision = self._commit(registry)
            except Exception:
                self._remove_stored(created)
                raise
            return self._mutation_result(registry, package.character_id, revision)

    def activate(self, character_id: str, version: str | None = None, *, expected_revision: str | None = None) -> dict[str, Any]:
        with self._lock:
            registry = self._read_registry()
            self._check_revision(registry, expected_revision)
            record = self._record(registry, character_id)
            selected = version or record.get("activeVersion") or max(record["versions"], key=SemVer.parse)
            if selected not in record["versions"]:
                raise PackageNotFoundError("Versao solicitada nao esta instalada.")
            record["activeVersion"] = selected
            record["enabled"] = True
            revision = self._commit(registry)
            return self._mutation_result(registry, character_id, revision)

    def enable(self, character_id: str, *, expected_revision: str | None = None) -> dict[str, Any]:
        return self._set_enabled(character_id, True, expected_revision=expected_revision)

    def disable(self, character_id: str, *, expected_revision: str | None = None) -> dict[str, Any]:
        return self._set_enabled(character_id, False, expected_revision=expected_revision)

    def _set_enabled(self, character_id: str, enabled: bool, *, expected_revision: str | None) -> dict[str, Any]:
        with self._lock:
            registry = self._read_registry()
            self._check_revision(registry, expected_revision)
            record = self._record(registry, character_id)
            record["enabled"] = enabled
            revision = self._commit(registry)
            return self._mutation_result(registry, character_id, revision)

    def rollback(
        self,
        character_id: str,
        version: str | None = None,
        *,
        expected_revision: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            registry = self._read_registry()
            self._check_revision(registry, expected_revision)
            record = self._record(registry, character_id)
            current = record.get("activeVersion")
            if version is None:
                lower = [item for item in record["versions"] if current is None or SemVer.parse(item) < SemVer.parse(current)]
                if not lower:
                    raise PackageConflictError("Nao existe versao anterior para rollback.")
                version = max(lower, key=SemVer.parse)
            if version not in record["versions"] or version == current:
                raise PackageNotFoundError("Versao de rollback inexistente ou ja ativa.")
            record["activeVersion"] = version
            record["enabled"] = True
            revision = self._commit(registry)
            return self._mutation_result(registry, character_id, revision)

    def uninstall(
        self,
        character_id: str,
        *,
        version: str | None = None,
        expected_revision: str | None = None,
        force: bool = False,
        reference_checker: ReferenceChecker | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            registry = self._read_registry()
            self._check_revision(registry, expected_revision)
            record = self._record(registry, character_id)
            references = [] if version is not None and version != record.get("activeVersion") else self._references(reference_checker or self.reference_checker, character_id, version)
            if references and not force:
                raise PackageInUseError("Personagem esta em uso e nao pode ser removido.", details={"references": references})
            versions_to_remove = [version] if version is not None else list(record["versions"])
            if any(item not in record["versions"] for item in versions_to_remove):
                raise PackageNotFoundError("Versao solicitada nao esta instalada.")
            removed_paths = [
                (self._version_directory(character_id, item), self._archive_path(character_id, item))
                for item in versions_to_remove
            ]
            for item in versions_to_remove:
                del record["versions"][item]
            if not record["versions"]:
                del registry["packages"][character_id]
            elif record.get("activeVersion") in versions_to_remove:
                record["activeVersion"] = max(record["versions"], key=SemVer.parse)
            revision = self._commit(registry)
            for directory, archive_path in removed_paths:
                shutil.rmtree(directory, ignore_errors=True)
                archive_path.unlink(missing_ok=True)
            return {"ok": True, "id": character_id, "removedVersions": versions_to_remove, "revision": revision}

    def export_package(self, character_id: str, version: str | None = None) -> bytes:
        with self._lock:
            registry = self._read_registry()
            record = self._record(registry, character_id)
            selected = version or record.get("activeVersion")
            version_record = record["versions"].get(selected)
            if not version_record:
                raise PackageNotFoundError("Versao solicitada nao esta instalada.")
            archive_path = self._archive_path(character_id, selected)
            try:
                raw = archive_path.read_bytes()
            except FileNotFoundError as error:
                raise CharacterPackageError("Arquivo original do pacote nao esta disponivel.") from error
            if _sha256(raw) != version_record.get("packageSha256"):
                raise CharacterPackageError("Arquivo exportavel falhou na verificacao de integridade.")
            self.validator.validate(raw, expected_id=character_id)
            return raw

    export = export_package

    def restore_natives(
        self,
        packages: Mapping[str, bytes] | Iterable[bytes] | None = None,
        *,
        expected_revision: str | None = None,
        reset_state: bool = True,
    ) -> dict[str, Any]:
        raw_packages: list[bytes]
        if packages is None:
            raw_packages = [path.read_bytes() for path in sorted(self.native_package_root.glob(f"*{CHARACTER_PACKAGE_EXTENSION}"))]
        elif isinstance(packages, Mapping):
            raw_packages = []
            for expected_id, raw in packages.items():
                validated = self.validator.validate(raw, expected_id=expected_id)
                raw_packages.append(bytes(raw))
                if validated.character_id != expected_id:
                    _invalid("id_mismatch", "Pacote nativo diverge do ID informado.", "$.id")
        else:
            raw_packages = [bytes(raw) for raw in packages]
        validated_packages = [(self.validator.validate(raw), raw) for raw in raw_packages]
        ids = [package.character_id for package, _ in validated_packages]
        if len(ids) != len(set(ids)):
            raise PackageConflictError("Lista de restauracao contem IDs nativos duplicados.")
        for package, raw in validated_packages:
            if package.character_id not in NATIVE_CHARACTER_IDS or not self._official_native_matches(package, raw):
                raise PackageConflictError("Restauracao aceita somente pacotes nativos oficiais.")
        with self._lock:
            registry = self._read_registry()
            self._check_revision(registry, expected_revision)
            created_paths: list[tuple[Path, Path]] = []
            replacements: list[tuple[tuple[Path, Path], Path, Path, Path]] = []
            restored: list[dict[str, str]] = []
            changed = False

            def replace_stored(package: ValidatedCharacterPackage, raw: bytes) -> None:
                current_directory = self._version_directory(package.character_id, package.version)
                current_archive = self._archive_path(package.character_id, package.version)
                quarantine = Path(tempfile.mkdtemp(prefix=".native-backup-", dir=str(self.staging_root)))
                backup_directory = quarantine / "installed"
                backup_archive = quarantine / "archive.zip"
                try:
                    if current_directory.exists():
                        os.replace(current_directory, backup_directory)
                    if current_archive.exists():
                        os.replace(current_archive, backup_archive)
                    created = self._store_package(package, raw)
                except Exception:
                    self._remove_stored((current_directory, current_archive))
                    if backup_directory.exists():
                        current_directory.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(backup_directory, current_directory)
                    if backup_archive.exists():
                        current_archive.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(backup_archive, current_archive)
                    shutil.rmtree(quarantine, ignore_errors=True)
                    raise
                replacements.append((created, quarantine, backup_directory, backup_archive))

            try:
                for package, raw in validated_packages:
                    record = registry["packages"].get(package.character_id)
                    if record is None:
                        created_paths.append(self._store_package(package, raw))
                        record = self._new_record(package, native=True, activate=True)
                        registry["packages"][package.character_id] = record
                        changed = True
                    elif not record.get("native"):
                        raise PackageConflictError("ID nativo esta ocupado por um pacote nao oficial.")
                    elif package.version not in record["versions"]:
                        created_paths.append(self._store_package(package, raw))
                        record["versions"][package.version] = self._version_record(package)
                        changed = True
                    else:
                        stored_digest = record["versions"][package.version].get("packageSha256")
                        if stored_digest != package.archive_sha256:
                            replace_stored(package, raw)
                            record["versions"][package.version] = self._version_record(package)
                            changed = True
                        elif not self._stored_package_intact(package):
                            replace_stored(package, raw)
                            changed = True
                    if record.get("native") is not True:
                        record["native"] = True
                        changed = True
                    if reset_state:
                        if record.get("enabled") is not True or record.get("activeVersion") != package.version:
                            changed = True
                        record["enabled"] = True
                        record["activeVersion"] = package.version
                    elif not record.get("activeVersion"):
                        record["activeVersion"] = package.version
                        changed = True
                    restored.append({"id": package.character_id, "version": package.version})
                revision = self._commit(registry) if changed else _registry_revision(registry)
            except Exception:
                for created in created_paths:
                    self._remove_stored(created)
                for created, quarantine, backup_directory, backup_archive in reversed(replacements):
                    self._remove_stored(created)
                    current_directory, current_archive = created
                    if backup_directory.exists():
                        current_directory.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(backup_directory, current_directory)
                    if backup_archive.exists():
                        current_archive.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(backup_archive, current_archive)
                    shutil.rmtree(quarantine, ignore_errors=True)
                raise
            for _created, quarantine, _backup_directory, _backup_archive in replacements:
                shutil.rmtree(quarantine, ignore_errors=True)
            return {"ok": True, "restored": restored, "changed": changed, "revision": revision}

    def read_manifest(self, character_id: str, version: str | None = None) -> dict[str, Any]:
        with self._lock:
            registry = self._read_registry()
            record = self._record(registry, character_id)
            selected = version or record.get("activeVersion")
            version_record = record["versions"].get(selected)
            if not version_record:
                raise PackageNotFoundError("Versao solicitada nao esta instalada.")
            return deepcopy(version_record["manifest"])

    def read_file(self, character_id: str, package_path: str, version: str | None = None) -> tuple[bytes, str]:
        safe_path = _safe_archive_path(package_path)
        CharacterPackageValidator._validate_allowed_path(safe_path)
        with self._lock:
            registry = self._read_registry()
            record = self._record(registry, character_id)
            selected = version or record.get("activeVersion")
            if selected not in record["versions"]:
                raise PackageNotFoundError("Versao solicitada nao esta instalada.")
            version_record = record["versions"][selected]
            target = _inside(self._version_directory(character_id, selected) / PurePosixPath(safe_path), self.registry_root)
            try:
                data = target.read_bytes()
            except FileNotFoundError as error:
                raise PackageNotFoundError("Arquivo do pacote nao encontrado.") from error
            checksums_value = (version_record.get("manifest") or {}).get("checksums") or {}
            checksums = checksums_value.get("files", checksums_value) if isinstance(checksums_value, dict) else {}
            expected_digest = checksums.get(safe_path) if isinstance(checksums, dict) else None
            if expected_digest and _sha256(data) != expected_digest:
                raise CharacterPackageError("Arquivo do pacote falhou na verificacao de integridade.")
            media_type = "image/png" if safe_path.lower().endswith(".png") else ("application/json" if safe_path.lower().endswith(".json") else "text/plain; charset=utf-8")
            return data, media_type

    def _store_package(self, package: ValidatedCharacterPackage, raw: bytes) -> tuple[Path, Path]:
        destination = self._version_directory(package.character_id, package.version)
        archive_path = self._archive_path(package.character_id, package.version)
        if destination.exists() or archive_path.exists():
            raise PackageConflictError("Versao ja possui arquivos no registry.")
        staging = Path(tempfile.mkdtemp(prefix=".package-", dir=str(self.staging_root)))
        try:
            for relative, data in package.files.items():
                target = _inside(staging / PurePosixPath(relative), staging)
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as handle:
                    handle.write(data)
            destination.parent.mkdir(parents=True, exist_ok=True)
            archive_path.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staging, destination)
            try:
                _atomic_write(archive_path, raw)
            except Exception:
                shutil.rmtree(destination, ignore_errors=True)
                raise
            return destination, archive_path
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    @staticmethod
    def _version_record(package: ValidatedCharacterPackage) -> dict[str, Any]:
        return {
            "version": package.version,
            "installedAt": _utc_now(),
            "packageSha256": package.archive_sha256,
            "compressedBytes": package.archive_bytes,
            "uncompressedBytes": package.uncompressed_bytes,
            "manifest": deepcopy(dict(package.manifest)),
        }

    def _official_native_matches(self, package: ValidatedCharacterPackage, raw: bytes) -> bool:
        for path in self.native_package_root.glob(f"*{CHARACTER_PACKAGE_EXTENSION}"):
            try:
                official = self.validator.validate(path.read_bytes(), expected_id=package.character_id)
            except PackageValidationError:
                continue
            if official.archive_sha256 == package.archive_sha256 == _sha256(raw):
                return True
        return False

    def _new_record(self, package: ValidatedCharacterPackage, *, native: bool, activate: bool) -> dict[str, Any]:
        return {
            "id": package.character_id,
            "native": bool(native),
            "enabled": bool(activate),
            "activeVersion": package.version,
            "versions": {package.version: self._version_record(package)},
        }

    def _stored_package_intact(self, package: ValidatedCharacterPackage) -> bool:
        archive_path = self._archive_path(package.character_id, package.version)
        directory = self._version_directory(package.character_id, package.version)
        try:
            if _sha256(archive_path.read_bytes()) != package.archive_sha256:
                return False
            for relative, expected in package.files.items():
                target = _inside(directory / PurePosixPath(relative), self.registry_root)
                if _sha256(target.read_bytes()) != _sha256(expected):
                    return False
        except (FileNotFoundError, OSError, CharacterPackageError):
            return False
        return True

    def _version_directory(self, character_id: str, version: str) -> Path:
        if not _ID_PATTERN.fullmatch(character_id):
            raise PackageNotFoundError("ID de personagem invalido.")
        SemVer.parse(version, path="version")
        return _inside(self.installed_root / character_id / version, self.registry_root)

    def _archive_path(self, character_id: str, version: str) -> Path:
        if not _ID_PATTERN.fullmatch(character_id):
            raise PackageNotFoundError("ID de personagem invalido.")
        SemVer.parse(version, path="version")
        return _inside(self.archives_root / character_id / f"{version}{CHARACTER_PACKAGE_EXTENSION}", self.registry_root)

    @staticmethod
    def _record(registry: Mapping[str, Any], character_id: str) -> dict[str, Any]:
        if not isinstance(character_id, str) or not _ID_PATTERN.fullmatch(character_id):
            raise PackageNotFoundError("ID de personagem invalido.")
        record = registry["packages"].get(character_id)
        if not isinstance(record, dict):
            raise PackageNotFoundError("Personagem nao instalado.")
        return record

    @staticmethod
    def _references(checker: ReferenceChecker | None, character_id: str, version: str | None) -> list[Any]:
        if checker is None:
            return []
        try:
            result = checker(character_id, version)
        except TypeError:
            result = checker(character_id)
        if result is None or result is False:
            return []
        if result is True:
            return [{"type": "unknown", "id": character_id}]
        if isinstance(result, (str, dict)):
            return [deepcopy(result)]
        try:
            return deepcopy(list(result))
        except TypeError:
            return [{"type": "unknown", "value": str(result)}]

    @staticmethod
    def _remove_stored(paths: tuple[Path, Path]) -> None:
        directory, archive_path = paths
        shutil.rmtree(directory, ignore_errors=True)
        archive_path.unlink(missing_ok=True)

    def _mutation_result(self, registry: Mapping[str, Any], character_id: str, revision: str) -> dict[str, Any]:
        record = registry["packages"][character_id]
        return {
            "ok": True,
            "id": character_id,
            "activeVersion": record.get("activeVersion"),
            "enabled": record.get("enabled") is not False,
            "native": bool(record.get("native")),
            "versions": sorted(record["versions"], key=SemVer.parse, reverse=True),
            "revision": revision,
        }

    get_catalog = catalog
    install_package = install
    update_package = update
    activate_package = activate
    enable_package = enable
    disable_package = disable
    rollback_package = rollback
    uninstall_package = uninstall


__all__ = [
    "BASE_DIR",
    "CHARACTER_PACKAGE_EXTENSION",
    "CHARACTER_PACKAGE_REGISTRY_ROOT",
    "NATIVE_CHARACTER_PACKAGE_ROOT",
    "CURRENT_APP_VERSION",
    "DEFAULT_LIMITS",
    "PACKAGE_SCHEMA_VERSION",
    "REGISTRY_SCHEMA_VERSION",
    "CharacterPackageError",
    "CharacterPackageService",
    "CharacterPackageValidator",
    "PackageConflictError",
    "PackageInUseError",
    "PackageIssue",
    "PackageLimits",
    "PackageNotFoundError",
    "PackageRevisionError",
    "PackageValidationError",
    "PngInfo",
    "SemVer",
    "ValidatedCharacterPackage",
    "is_compatible",
]
