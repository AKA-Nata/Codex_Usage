from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from typing import Any, Callable


def _identifier(value: Any, fallback: str) -> str:
    normalized = re.sub(r"[^a-z0-9_]+", "_", str(value or "").lower()).strip("_")
    if not normalized or not normalized[0].isalpha():
        normalized = fallback
    return normalized[:96]


def _document(service: Any, character_id: str, filename: str) -> Any:
    body, _media_type = service.read_file(character_id, filename)
    return json.loads(body.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def compose_effective_behavior_config(
    official_config: dict[str, Any],
    package_service: Any,
    *,
    validate: Callable[[Any], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Compose enabled package fragments without mutating the official config."""

    effective = deepcopy(official_config)
    diagnostics: list[dict[str, Any]] = []
    packages: list[dict[str, str]] = []
    catalog = package_service.catalog(include_disabled=False)
    for character in catalog.get("characters", []):
        character_id = character.get("id")
        if not character_id or character.get("enabled") is False or character.get("compatible") is False:
            continue
        try:
            phrases_doc = _document(package_service, character_id, "phrases.json")
            behaviors_doc = _document(package_service, character_id, "behaviors.json")
            raw_phrases = phrases_doc.get("groups", phrases_doc.get("phrases", [])) if isinstance(phrases_doc, dict) else phrases_doc
            raw_triggers = behaviors_doc.get("triggers", behaviors_doc.get("behaviors", [])) if isinstance(behaviors_doc, dict) else behaviors_doc
            if not isinstance(raw_phrases, list) or not isinstance(raw_triggers, list):
                raise ValueError("behaviors.json e phrases.json devem declarar listas.")
            namespace = _identifier(character_id, "package")
            phrase_ids: dict[str, str] = {}
            additions_phrases = []
            for index, group in enumerate(raw_phrases):
                if not isinstance(group, dict):
                    raise ValueError("Grupo de falas inválido.")
                original = str(group.get("id") or f"phrase_{index + 1}")
                identifier = _identifier(f"pkg_{namespace}_{original}", f"pkg_{namespace}_phrase_{index + 1}")
                phrase_ids[original] = identifier
                additions_phrases.append({**deepcopy(group), "id": identifier})
            additions_triggers = []
            for index, trigger in enumerate(raw_triggers):
                if not isinstance(trigger, dict):
                    raise ValueError("Gatilho de pacote inválido.")
                original = str(trigger.get("id") or f"trigger_{index + 1}")
                candidate = deepcopy(trigger)
                candidate["id"] = _identifier(f"pkg_{namespace}_{original}", f"pkg_{namespace}_trigger_{index + 1}")
                candidate["name"] = str(candidate.get("name") or original)[:80]
                candidate["character"] = {"kind": "id", "value": character_id}
                if isinstance(candidate.get("phraseRefs"), list):
                    candidate["phraseRefs"] = [phrase_ids.get(str(item), str(item)) for item in candidate["phraseRefs"]]
                additions_triggers.append(candidate)
            trial = deepcopy(effective)
            trial.setdefault("phrases", []).extend(additions_phrases)
            trial.setdefault("triggers", []).extend(additions_triggers)
            report = validate(trial) if validate else {"valid": True, "errors": []}
            if not report.get("valid"):
                raise ValueError((report.get("errors") or [{"message": "fragmento inválido"}])[0].get("message"))
            effective = trial
            packages.append({"id": character_id, "version": str(character.get("version") or "")})
        except Exception as error:
            diagnostics.append({"id": character_id, "level": "error", "code": "behavior_fragment_rejected", "message": str(error)[:240]})
    canonical = json.dumps(effective, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "config": effective,
        "revision": hashlib.sha256(canonical).hexdigest(),
        "packages": packages,
        "diagnostics": diagnostics,
        "sourceRevision": catalog.get("revision"),
    }


__all__ = ["compose_effective_behavior_config"]
