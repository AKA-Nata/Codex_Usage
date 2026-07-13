from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .config import BASE_DIR
from .storage import atomic_write_json


BEHAVIOR_CONFIG_PATH = BASE_DIR / "web" / "config" / "sprite-behaviors.json"
BEHAVIOR_SCHEMA_PATH = BASE_DIR / "web" / "config" / "sprite-behaviors.schema.json"
BEHAVIOR_DEFAULT_CONFIG_PATH = BASE_DIR / "web" / "config" / "sprite-behaviors.default.json"
STUDIO_RUNTIME_DIR = BASE_DIR / "runtime" / "behavior-studio"
MAX_CONFIG_BYTES = 1_000_000
MAX_HISTORY_ENTRIES = 2_000
MACRO_PATTERN = re.compile(r"{{\s*([a-z][a-z0-9_]*)\s*}}")
SENSITIVE_HISTORY_PATTERN = re.compile(
    r"(?i)(cookie|authorization|bearer|token|session|profile|secret|password|credential|api[_-]?key|websocket[_-]?debugger[_-]?url)"
)
CHARACTER_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")


class StudioError(ValueError):
    """Base error intentionally safe to expose through the local API."""


class StudioValidationError(StudioError):
    def __init__(self, errors: list[dict[str, str]]):
        super().__init__("A configuracao nao atende ao schema.")
        self.errors = errors


class StudioRevisionConflict(StudioError):
    pass


def migrate_behavior_config(config: Any) -> tuple[Any, list[dict[str, Any]]]:
    """Return a migrated copy of 4.2/4.3 behavior data and an audit trail."""

    migrated = deepcopy(config)
    changes: list[dict[str, Any]] = []
    if not isinstance(migrated, dict):
        return migrated, changes
    metadata = migrated.get("metadata")
    if isinstance(metadata, dict) and str(metadata.get("schemaVersion") or "").startswith("2."):
        previous = metadata.get("schemaVersion")
        metadata["schemaVersion"] = "3.0.0"
        changes.append({"path": "$.metadata.schemaVersion", "before": previous, "after": "3.0.0"})
        if str(metadata.get("version") or "").startswith("2."):
            previous = metadata.get("version")
            metadata["version"] = "3.0.0"
            changes.append({"path": "$.metadata.version", "before": previous, "after": "3.0.0"})
    triggers = migrated.get("triggers")
    if isinstance(triggers, list):
        for index, trigger in enumerate(triggers):
            if not isinstance(trigger, dict) or "character" not in trigger:
                continue
            legacy = trigger.get("character")
            if legacy == "auto":
                selector = {"kind": "auto", "value": None}
            elif isinstance(legacy, str) and CHARACTER_ID_PATTERN.fullmatch(legacy):
                selector = {"kind": "id", "value": legacy}
            else:
                continue
            trigger["character"] = selector
            changes.append({"path": f"$.triggers[{index}].character", "before": legacy, "after": selector})
    return migrated, changes


def _json_equal(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    return left == right


def _matches_type(value: Any, expected: str) -> bool:
    return {
        "null": value is None,
        "boolean": isinstance(value, bool),
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value),
    }.get(expected, True)


def _child_path(path: str, key: str | int) -> str:
    if isinstance(key, int):
        return f"{path}[{key}]"
    return f"{path}.{key}" if path else str(key)


class Draft202012Validator:
    """Small dependency-free validator for the vocabulary used by this project.

    The Studio always reads the committed JSON Schema and evaluates its refs and
    constraints. This keeps the no-VENV/no-install workflow intact while making
    the backend, rather than only the browser, the final persistence gate.
    """

    def __init__(self, schema: dict[str, Any]):
        self.schema = schema

    def validate(self, instance: Any) -> list[dict[str, str]]:
        return self._validate(instance, self.schema, "$")

    def _resolve_ref(self, reference: str) -> dict[str, Any]:
        if not reference.startswith("#/"):
            return {}
        current: Any = self.schema
        for raw_part in reference[2:].split("/"):
            part = raw_part.replace("~1", "/").replace("~0", "~")
            if not isinstance(current, dict) or part not in current:
                return {}
            current = current[part]
        return current if isinstance(current, dict) else {}

    @staticmethod
    def _error(path: str, keyword: str, message: str) -> dict[str, str]:
        return {"path": path, "keyword": keyword, "message": message}

    def _validate(self, instance: Any, schema: dict[str, Any], path: str) -> list[dict[str, str]]:
        if not isinstance(schema, dict):
            return []
        if "$ref" in schema:
            resolved = self._resolve_ref(str(schema["$ref"]))
            if not resolved:
                return [self._error(path, "$ref", "Referencia de schema nao encontrada.")]
            return self._validate(instance, resolved, path)

        errors: list[dict[str, str]] = []

        if "allOf" in schema:
            for branch in schema["allOf"]:
                errors.extend(self._validate(instance, branch, path))
        if "anyOf" in schema:
            reports = [self._validate(instance, branch, path) for branch in schema["anyOf"]]
            if reports and all(report for report in reports):
                errors.append(self._error(path, "anyOf", "O valor nao corresponde a nenhuma alternativa permitida."))
        if "oneOf" in schema:
            reports = [self._validate(instance, branch, path) for branch in schema["oneOf"]]
            if sum(not report for report in reports) != 1:
                errors.append(self._error(path, "oneOf", "O valor deve corresponder a exatamente uma alternativa."))
        if "if" in schema:
            condition_matches = not self._validate(instance, schema["if"], path)
            selected = schema.get("then") if condition_matches else schema.get("else")
            if selected:
                errors.extend(self._validate(instance, selected, path))

        expected_type = schema.get("type")
        if expected_type:
            allowed_types = expected_type if isinstance(expected_type, list) else [expected_type]
            if not any(_matches_type(instance, item) for item in allowed_types):
                errors.append(self._error(path, "type", f"Tipo invalido; esperado: {', '.join(allowed_types)}."))
                return errors

        if "const" in schema and not _json_equal(instance, schema["const"]):
            errors.append(self._error(path, "const", "Valor diferente do literal exigido."))
        if "enum" in schema and not any(_json_equal(instance, item) for item in schema["enum"]):
            errors.append(self._error(path, "enum", "Valor fora das opcoes permitidas."))

        if isinstance(instance, dict):
            if len(instance) < int(schema.get("minProperties", 0)):
                errors.append(self._error(path, "minProperties", "O objeto possui menos campos que o permitido."))
            if "maxProperties" in schema and len(instance) > int(schema["maxProperties"]):
                errors.append(self._error(path, "maxProperties", "O objeto possui mais campos que o permitido."))
            required = schema.get("required", [])
            for key in required:
                if key not in instance:
                    errors.append(self._error(_child_path(path, key), "required", "Campo obrigatorio ausente."))

            property_names = schema.get("propertyNames")
            if isinstance(property_names, dict):
                for key in instance:
                    errors.extend(self._validate(key, property_names, _child_path(path, key)))

            properties = schema.get("properties", {})
            for key, value in instance.items():
                if key in properties:
                    errors.extend(self._validate(value, properties[key], _child_path(path, key)))
                    continue
                additional = schema.get("additionalProperties", True)
                if additional is False:
                    errors.append(self._error(_child_path(path, key), "additionalProperties", "Campo nao permitido pelo schema."))
                elif isinstance(additional, dict):
                    errors.extend(self._validate(value, additional, _child_path(path, key)))

        if isinstance(instance, list):
            if len(instance) < int(schema.get("minItems", 0)):
                errors.append(self._error(path, "minItems", "A lista possui menos itens que o permitido."))
            if "maxItems" in schema and len(instance) > int(schema["maxItems"]):
                errors.append(self._error(path, "maxItems", "A lista possui mais itens que o permitido."))
            if schema.get("uniqueItems"):
                serialized = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in instance]
                if len(serialized) != len(set(serialized)):
                    errors.append(self._error(path, "uniqueItems", "A lista contem itens repetidos."))
            if isinstance(schema.get("items"), dict):
                for index, value in enumerate(instance):
                    errors.extend(self._validate(value, schema["items"], _child_path(path, index)))

        if isinstance(instance, str):
            if len(instance) < int(schema.get("minLength", 0)):
                errors.append(self._error(path, "minLength", "Texto menor que o minimo permitido."))
            if "maxLength" in schema and len(instance) > int(schema["maxLength"]):
                errors.append(self._error(path, "maxLength", "Texto maior que o maximo permitido."))
            pattern = schema.get("pattern")
            if pattern and re.search(pattern, instance) is None:
                errors.append(self._error(path, "pattern", "Texto fora do formato esperado."))

        if isinstance(instance, (int, float)) and not isinstance(instance, bool):
            if "minimum" in schema and instance < schema["minimum"]:
                errors.append(self._error(path, "minimum", "Numero abaixo do minimo permitido."))
            if "maximum" in schema and instance > schema["maximum"]:
                errors.append(self._error(path, "maximum", "Numero acima do maximo permitido."))
            if "exclusiveMinimum" in schema and instance <= schema["exclusiveMinimum"]:
                errors.append(self._error(path, "exclusiveMinimum", "Numero deve ser maior que o limite minimo."))

        return errors


def _iter_ranges(value: Any, path: str = "$") -> Iterable[tuple[str, dict[str, Any]]]:
    if isinstance(value, dict):
        if set(value) == {"min", "max"}:
            yield path, value
        for key, child in value.items():
            yield from _iter_ranges(child, _child_path(path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_ranges(child, _child_path(path, index))


def _iter_between_values(value: Any, path: str = "$") -> Iterable[tuple[str, list[Any]]]:
    if isinstance(value, dict):
        if value.get("operator") == "between" and isinstance(value.get("value"), list):
            yield _child_path(path, "value"), value["value"]
        for key, child in value.items():
            yield from _iter_between_values(child, _child_path(path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_between_values(child, _child_path(path, index))


def validate_behavior_semantics(config: Any) -> list[dict[str, str]]:
    if not isinstance(config, dict):
        return []
    errors: list[dict[str, str]] = []
    macros = config.get("macros") if isinstance(config.get("macros"), dict) else {}
    declared_macros = set(macros)
    for name, spec in macros.items():
        if isinstance(spec, dict) and spec.get("token") != f"{{{{{name}}}}}":
            errors.append({"path": f"$.macros.{name}.token", "keyword": "macroToken", "message": "O token deve corresponder ao nome da macro."})

    phrases = config.get("phrases") if isinstance(config.get("phrases"), list) else []
    triggers = config.get("triggers") if isinstance(config.get("triggers"), list) else []
    phrase_ids: set[str] = set()
    for index, group in enumerate(phrases):
        identifier = group.get("id") if isinstance(group, dict) else None
        if identifier in phrase_ids:
            errors.append({"path": f"$.phrases[{index}].id", "keyword": "uniqueId", "message": "ID de fala duplicado."})
        if identifier:
            phrase_ids.add(identifier)

    casual = ((config.get("defaultBehavior") or {}).get("casualSpeech") or {}) if isinstance(config.get("defaultBehavior"), dict) else {}
    casual_refs = casual.get("phraseIds") if isinstance(casual, dict) and isinstance(casual.get("phraseIds"), list) else []
    for ref_index, phrase_ref in enumerate(casual_refs):
        if phrase_ref not in phrase_ids:
            errors.append({"path": f"$.defaultBehavior.casualSpeech.phraseIds[{ref_index}]", "keyword": "phraseRef", "message": "Referencia de fala inexistente."})

    trigger_ids: set[str] = set()
    for index, trigger in enumerate(triggers):
        if not isinstance(trigger, dict):
            continue
        identifier = trigger.get("id")
        if identifier in trigger_ids:
            errors.append({"path": f"$.triggers[{index}].id", "keyword": "uniqueId", "message": "ID de gatilho duplicado."})
        if identifier:
            trigger_ids.add(identifier)
        phrase_refs = trigger.get("phraseRefs") if isinstance(trigger.get("phraseRefs"), list) else []
        for ref_index, phrase_ref in enumerate(phrase_refs):
            if phrase_ref not in phrase_ids:
                errors.append({"path": f"$.triggers[{index}].phraseRefs[{ref_index}]", "keyword": "phraseRef", "message": "Referencia de fala inexistente."})
        character_phrases = trigger.get("characterPhrases")
        if isinstance(character_phrases, dict) and not character_phrases:
            errors.append({"path": f"$.triggers[{index}].characterPhrases", "keyword": "minProperties", "message": "Falas por personagem nao podem usar um mapa vazio."})

    phrase_sources: list[tuple[str, str]] = []
    for index, group in enumerate(phrases):
        if isinstance(group, dict):
            texts = group.get("texts") if isinstance(group.get("texts"), list) else []
            phrase_sources.extend((f"$.phrases[{index}].texts[{text_index}]", text) for text_index, text in enumerate(texts) if isinstance(text, str))
    for index, trigger in enumerate(triggers):
        if not isinstance(trigger, dict):
            continue
        direct_phrases = trigger.get("phrases") if isinstance(trigger.get("phrases"), list) else []
        phrase_sources.extend((f"$.triggers[{index}].phrases[{text_index}]", text) for text_index, text in enumerate(direct_phrases) if isinstance(text, str))
        if isinstance(trigger.get("fallbackPhrase"), str):
            phrase_sources.append((f"$.triggers[{index}].fallbackPhrase", trigger["fallbackPhrase"]))
        character_phrases = trigger.get("characterPhrases") if isinstance(trigger.get("characterPhrases"), dict) else {}
        for character, texts in character_phrases.items():
            safe_texts = texts if isinstance(texts, list) else []
            phrase_sources.extend((f"$.triggers[{index}].characterPhrases.{character}[{text_index}]", text) for text_index, text in enumerate(safe_texts) if isinstance(text, str))
    for path, text in phrase_sources:
        token_like_values = re.findall(r"{{[^{}]*}}", text)
        for token in token_like_values:
            if re.fullmatch(r"{{\s*[a-z][a-z0-9_]*\s*}}", token) is None:
                errors.append({"path": path, "keyword": "malformedMacro", "message": f"Macro malformada: {token}."})
        if text.count("{{") != text.count("}}"):
            errors.append({"path": path, "keyword": "malformedMacro", "message": "A fala possui chaves de macro desbalanceadas."})
        for macro_name in MACRO_PATTERN.findall(text):
            if macro_name not in declared_macros:
                errors.append({"path": path, "keyword": "unknownMacro", "message": f"Macro nao declarada: {macro_name}."})

    for path, limits in _iter_ranges(config):
        minimum, maximum = limits.get("min"), limits.get("max")
        if isinstance(minimum, (int, float)) and isinstance(maximum, (int, float)) and maximum < minimum:
            errors.append({"path": path, "keyword": "orderedRange", "message": "max deve ser maior ou igual a min."})
    for path, limits in _iter_between_values(config):
        if len(limits) == 2 and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in limits) and limits[1] < limits[0]:
            errors.append({"path": path, "keyword": "orderedRange", "message": "O limite final deve ser maior ou igual ao inicial."})
    return errors


def _read_json(path: Path, *, max_bytes: int = MAX_CONFIG_BYTES) -> Any:
    if path.stat().st_size > max_bytes:
        raise StudioError("Arquivo JSON excede o tamanho permitido.")
    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(StudioError(f"Constante JSON invalida: {value}.")),
        )
    except json.JSONDecodeError as exc:
        raise StudioError("Arquivo JSON invalido.") from exc


def _revision(config: Any) -> str:
    canonical = json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _ensure_inside(path: Path, root: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise StudioError("Caminho fora do diretorio autorizado.") from exc
    return resolved


def _safe_scalar(value: Any) -> str | int | float | bool | None:
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return str(value)[:300]


def _redact_history_text(value: Any, *, maximum: int = 300) -> str:
    text = str(value or "")[:maximum]
    if SENSITIVE_HISTORY_PATTERN.search(text):
        return "[conteudo sensivel removido]"
    return text


def _condition_metric_names(value: Any) -> set[str]:
    names: set[str] = set()
    if isinstance(value, dict):
        metric = value.get("metric")
        if isinstance(metric, str):
            names.add(metric)
        event_metric = value.get("event", {}).get("metric") if isinstance(value.get("event"), dict) else None
        if isinstance(event_metric, str):
            names.add(event_metric)
        for child in value.values():
            names.update(_condition_metric_names(child))
    elif isinstance(value, list):
        for child in value:
            names.update(_condition_metric_names(child))
    return names


def _seconds_until(value: Any, now: datetime) -> float | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0.0, (parsed.astimezone(timezone.utc) - now).total_seconds())
    except (TypeError, ValueError):
        return None


def _timestamp_milliseconds(value: Any) -> float | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp() * 1000
    except (TypeError, ValueError, OSError):
        return None


def _get_by_path(value: Any, source_path: Any) -> Any:
    current = value
    for key in str(source_path or "").split("."):
        if not key or not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def _format_macro_value(value: Any, spec: dict[str, Any]) -> str:
    if value is None or value == "":
        return str(spec.get("fallback") if spec.get("fallback") is not None else "--")
    macro_type = spec.get("type")
    if macro_type == "duration":
        try:
            total = max(0, int(float(value)))
        except (TypeError, ValueError):
            return str(spec.get("fallback") or "--")
        days, rest = divmod(total, 86400)
        hours, rest = divmod(rest, 3600)
        minutes, seconds = divmod(rest, 60)
        parts = []
        if days:
            parts.append(f"{days}d")
        if hours:
            parts.append(f"{hours}h")
        if minutes:
            parts.append(f"{minutes}min")
        if not parts:
            parts.append(f"{seconds}s")
        return " ".join(parts)
    if macro_type == "datetime":
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00")) if not isinstance(value, (int, float)) else datetime.fromtimestamp(value / 1000, timezone.utc)
            return parsed.astimezone().strftime("%d/%m/%Y %H:%M")
        except (TypeError, ValueError, OSError):
            return str(spec.get("fallback") or "--")
    if macro_type == "boolean" and isinstance(value, bool):
        return "sim" if value else "não"
    if isinstance(value, float):
        return f"{value:.1f}".rstrip("0").rstrip(".")
    return str(value)


def build_macro_catalog(
    config: dict[str, Any],
    *,
    usage: dict[str, Any] | None = None,
    health: dict[str, Any] | None = None,
    telemetry: dict[str, Any] | None = None,
    panel_idle_seconds: float | None = None,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    usage, health, telemetry = usage or {}, health or {}, telemetry or {}
    now = now or datetime.now(timezone.utc)
    machine, weather, clock = telemetry.get("machine") or {}, telemetry.get("weather") or {}, telemetry.get("clock") or {}
    five_hour = ((usage.get("resets") or {}).get("limite_5h") or {})
    weekly = ((usage.get("resets") or {}).get("limite_semanal") or {})
    normalized_context = {
        "clock": {
            "time": clock.get("time") or now.astimezone().strftime("%H:%M:%S"),
            "date": clock.get("date") or now.astimezone().strftime("%d/%m/%Y"),
        },
        "idleSeconds": panel_idle_seconds if panel_idle_seconds is not None else machine.get("system_idle_seconds"),
        "weather": {
            "temperatureC": weather.get("temperature_c"),
            "condition": weather.get("condition"),
        },
        "machine": {
            "cpuPercent": machine.get("cpu_percent"),
            "memoryPercent": machine.get("memory_percent"),
            "diskPercent": machine.get("disk_percent"),
            "gpuPercent": machine.get("gpu_percent"),
            "gpuMemoryPercent": machine.get("gpu_memory_percent"),
        },
        "codex": {
            "fiveHourPercent": five_hour.get("remaining_percent"),
            "fiveHourResetSeconds": _seconds_until(five_hour.get("reset_at"), now),
            "fiveHourLimitReached": five_hour.get("limit_reached"),
            "weeklyPercent": weekly.get("remaining_percent"),
            "weeklyResetSeconds": _seconds_until(weekly.get("reset_at"), now),
            "weeklyLimitReached": weekly.get("limit_reached"),
        },
        "collection": {
            "status": health.get("status"),
            "collectedAtMs": _timestamp_milliseconds(usage.get("collected_at")),
        },
    }
    catalog = []
    for name, spec in (config.get("macros") or {}).items():
        raw_value = _get_by_path(normalized_context, spec.get("sourcePath"))
        available = raw_value is not None and raw_value != ""
        catalog.append({
            "macro": name,
            "token": spec.get("token") or f"{{{{{name}}}}}",
            "description": spec.get("description") or "",
            "origin": spec.get("origin") or "",
            "type": spec.get("type") or "string",
            "unit": spec.get("unit") or "",
            "fallback": spec.get("fallback"),
            "value": _safe_scalar(raw_value),
            "displayValue": _format_macro_value(raw_value, spec),
            "available": available,
        })
    return catalog


class BehaviorStudioService:
    def __init__(
        self,
        *,
        config_path: Path = BEHAVIOR_CONFIG_PATH,
        schema_path: Path = BEHAVIOR_SCHEMA_PATH,
        default_config_path: Path = BEHAVIOR_DEFAULT_CONFIG_PATH,
        runtime_dir: Path = STUDIO_RUNTIME_DIR,
    ):
        self.config_root = config_path.parent.resolve()
        self.config_path = _ensure_inside(config_path, self.config_root)
        self.schema_path = _ensure_inside(schema_path, self.config_root)
        self.default_config_path = _ensure_inside(default_config_path, self.config_root)
        self.runtime_root = runtime_dir.resolve()
        self.backup_dir = self.runtime_root / "backups"
        self.history_path = self.runtime_root / "history.jsonl"
        self.lock = threading.RLock()
        self.schema = _read_json(self.schema_path)
        self.validator = Draft202012Validator(self.schema)
        default_report = self.validate(_read_json(self.default_config_path))
        if not default_report["valid"]:
            raise StudioError("A configuracao padrao versionada e invalida.")

    def validate(self, config: Any) -> dict[str, Any]:
        errors = self.validator.validate(config)
        errors.extend(validate_behavior_semantics(config))
        deduplicated = []
        seen = set()
        for error in errors:
            signature = (error.get("path"), error.get("keyword"), error.get("message"))
            if signature in seen:
                continue
            seen.add(signature)
            deduplicated.append(error)
        return {"valid": not deduplicated, "errors": deduplicated}

    def read_config(self) -> dict[str, Any]:
        with self.lock:
            config = _read_json(self.config_path)
            config, migrations = migrate_behavior_config(config)
            report = self.validate(config)
            if report["valid"] and migrations:
                self._backup(_read_json(self.config_path), "automatic-migration")
                atomic_write_json(self.config_path, config)
            return {"config": config, "revision": _revision(config), "migrations": migrations, **report}

    def read_schema(self) -> dict[str, Any]:
        return deepcopy(self.schema)

    def _backup(self, current: dict[str, Any], reason: str) -> str:
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        _ensure_inside(self.backup_dir, self.runtime_root)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        name = f"{timestamp}-{re.sub(r'[^a-z0-9-]', '-', reason.lower())[:24]}.json"
        path = _ensure_inside(self.backup_dir / name, self.backup_dir)
        atomic_write_json(path, current)
        backups = sorted(self.backup_dir.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
        for old_backup in backups[50:]:
            _ensure_inside(old_backup, self.backup_dir).unlink(missing_ok=True)
        return name

    def save_config(self, config: Any, *, expected_revision: str | None = None, reason: str = "save") -> dict[str, Any]:
        if not isinstance(config, dict):
            raise StudioValidationError([{"path": "$", "keyword": "type", "message": "A configuracao deve ser um objeto JSON."}])
        candidate, migrations = migrate_behavior_config(config)
        report = self.validate(candidate)
        if not report["valid"]:
            raise StudioValidationError(report["errors"])
        with self.lock:
            current = _read_json(self.config_path)
            current_revision = _revision(current)
            if expected_revision and expected_revision != current_revision:
                raise StudioRevisionConflict("A configuracao mudou desde a ultima leitura. Recarregue o Studio antes de salvar.")
            backup_name = self._backup(current, reason)
            atomic_write_json(self.config_path, deepcopy(candidate))
            return {
                "config": deepcopy(candidate),
                "revision": _revision(candidate),
                "valid": True,
                "errors": [],
                "backup": backup_name,
                "migrations": migrations,
            }

    def restore_default(self, *, expected_revision: str | None = None) -> dict[str, Any]:
        with self.lock:
            default_config = _read_json(self.default_config_path)
            return self.save_config(default_config, expected_revision=expected_revision, reason="restore-default")

    def export_config(self) -> dict[str, Any]:
        return deepcopy(self.read_config()["config"])

    def import_config(self, config: Any, *, expected_revision: str | None = None) -> dict[str, Any]:
        return self.save_config(config, expected_revision=expected_revision, reason="import")

    def append_history(self, entry: Any) -> dict[str, Any]:
        if not isinstance(entry, dict):
            raise StudioError("Registro de historico invalido.")
        allowed = {
            "triggerId", "triggerName", "timestamp", "values", "character", "card", "phrase",
            "state", "priority", "durationSeconds", "cooldownSeconds", "holdSeconds", "result", "error", "source",
        }
        clean = {key: entry.get(key) for key in allowed if key in entry}
        clean["triggerId"] = str(clean.get("triggerId") or "desconhecido")[:80]
        clean["timestamp"] = str(clean.get("timestamp") or datetime.now(timezone.utc).isoformat())[:80]
        for key in ("triggerName", "character", "card", "phrase", "state", "result", "error", "source"):
            if key in clean and clean[key] is not None:
                clean[key] = _redact_history_text(clean[key], maximum=500 if key in {"phrase", "error"} else 120)
        for key in ("priority", "durationSeconds", "cooldownSeconds", "holdSeconds"):
            if key in clean:
                clean[key] = _safe_scalar(clean[key])
        values = clean.get("values") if isinstance(clean.get("values"), dict) else {}
        current_config = _read_json(self.config_path)
        allowed_value_keys = set(current_config.get("macros") or {})
        allowed_value_keys.update({"hora", "coleta_status", "card_evento", "fase_arraste", "tempo_sem_interacao"})
        for trigger in current_config.get("triggers") or []:
            if isinstance(trigger, dict):
                allowed_value_keys.update(_condition_metric_names(trigger.get("when")))
        sanitized_values: dict[str, Any] = {}
        for raw_key, value in list(values.items())[:50]:
            key = str(raw_key)[:80]
            if SENSITIVE_HISTORY_PATTERN.search(key):
                continue
            if key not in allowed_value_keys and not key.startswith("evento:"):
                continue
            scalar = _safe_scalar(value)
            sanitized_values[key] = _redact_history_text(scalar) if isinstance(scalar, str) else scalar
        clean["values"] = sanitized_values
        line = json.dumps(clean, ensure_ascii=False, separators=(",", ":"))
        with self.lock:
            self.runtime_root.mkdir(parents=True, exist_ok=True)
            _ensure_inside(self.history_path, self.runtime_root)
            with self.history_path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
            lines = self.history_path.read_text(encoding="utf-8").splitlines()
            if len(lines) > MAX_HISTORY_ENTRIES:
                self.history_path.write_text("\n".join(lines[-MAX_HISTORY_ENTRIES:]) + "\n", encoding="utf-8", newline="\n")
        return clean

    def read_history(self, *, limit: int = 200, query: str = "") -> list[dict[str, Any]]:
        bounded_limit = max(1, min(500, int(limit)))
        normalized_query = str(query or "").strip().lower()
        with self.lock:
            if not self.history_path.exists():
                return []
            records = []
            for line in reversed(self.history_path.read_text(encoding="utf-8").splitlines()):
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if normalized_query and normalized_query not in json.dumps(record, ensure_ascii=False).lower():
                    continue
                records.append(record)
                if len(records) >= bounded_limit:
                    break
            return records

    def clear_history(self) -> int:
        with self.lock:
            count = 0
            if self.history_path.exists():
                for line in self.history_path.read_text(encoding="utf-8").splitlines():
                    try:
                        json.loads(line)
                        count += 1
                    except json.JSONDecodeError:
                        continue
            _ensure_inside(self.history_path, self.runtime_root).unlink(missing_ok=True)
            return count
