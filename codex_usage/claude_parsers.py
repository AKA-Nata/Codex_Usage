"""Parsers do uso do Claude (claude.ai).

O payload de rede vem de um contrato observado (nao documentado) da pagina
de uso do claude.ai. As janelas retornadas variam por plano; por isso o
parser nunca assume quantidade fixa de janelas e nunca inventa valores:
somente janelas reconhecidas no payload entram no resultado.
"""

from __future__ import annotations

import re
from typing import Any

from .parsers import clamp_percent, first_present, recursive_dicts
from .timeutils import epoch_to_iso, now, seconds_from_now_to_iso, seconds_until

SESSION_WINDOW_SECONDS = 18_000
WEEKLY_WINDOW_SECONDS = 604_800

# Chaves observadas no payload interno do claude.ai por janela conhecida.
_KNOWN_WINDOW_KEYS: dict[str, dict[str, Any]] = {
    "five_hour": {"id": "session", "label": "Sessão (5 horas)", "duration": SESSION_WINDOW_SECONDS},
    "fiveHour": {"id": "session", "label": "Sessão (5 horas)", "duration": SESSION_WINDOW_SECONDS},
    "session": {"id": "session", "label": "Sessão (5 horas)", "duration": SESSION_WINDOW_SECONDS},
    "seven_day": {"id": "weekly", "label": "Limite semanal", "duration": WEEKLY_WINDOW_SECONDS},
    "sevenDay": {"id": "weekly", "label": "Limite semanal", "duration": WEEKLY_WINDOW_SECONDS},
    "weekly": {"id": "weekly", "label": "Limite semanal", "duration": WEEKLY_WINDOW_SECONDS},
    "seven_day_opus": {"id": "weekly_opus", "label": "Semanal (Opus)", "duration": WEEKLY_WINDOW_SECONDS},
    "sevenDayOpus": {"id": "weekly_opus", "label": "Semanal (Opus)", "duration": WEEKLY_WINDOW_SECONDS},
    "seven_day_sonnet": {"id": "weekly_sonnet", "label": "Semanal (Sonnet)", "duration": WEEKLY_WINDOW_SECONDS},
}

_USED_KEYS = (
    "utilization",
    "used_percent",
    "usedPercent",
    "usage_percent",
    "usagePercent",
    "percent_used",
    "percentUsed",
)
_REMAINING_KEYS = ("remaining_percent", "remainingPercent", "percent_remaining", "percentRemaining")
_RESET_AT_KEYS = ("resets_at", "resetsAt", "reset_at", "resetAt", "reset_timestamp", "resetTimestamp")
_RESET_AFTER_KEYS = (
    "reset_after_seconds",
    "resetAfterSeconds",
    "seconds_until_reset",
    "secondsUntilReset",
)


def _looks_like_claude_window(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    keys = set(value)
    return bool(keys & set(_USED_KEYS)) or bool(keys & set(_REMAINING_KEYS)) or bool(keys & set(_RESET_AT_KEYS))


def _iso_reset(raw_reset: Any, reset_after: Any, timezone_name: str) -> tuple[str | None, int | None]:
    reset_at = None
    if isinstance(raw_reset, str) and raw_reset:
        # Contrato observado usa ISO-8601; epoch chega como numero.
        try:
            float(raw_reset)
            reset_at = epoch_to_iso(raw_reset, timezone_name)
        except ValueError:
            normalized = raw_reset.replace("Z", "+00:00")
            reset_at = normalized if re.match(r"^\d{4}-\d{2}-\d{2}[T ]", normalized) else None
    elif raw_reset is not None:
        reset_at = epoch_to_iso(raw_reset, timezone_name)

    reset_after_seconds = None
    if reset_after is not None:
        try:
            reset_after_seconds = max(0, int(float(reset_after)))
        except (TypeError, ValueError):
            reset_after_seconds = None

    if reset_at is None and reset_after_seconds is not None:
        reset_at = seconds_from_now_to_iso(reset_after_seconds, timezone_name)
    if reset_after_seconds is None and reset_at is not None:
        reset_after_seconds = seconds_until(reset_at, timezone_name)
    return reset_at, reset_after_seconds


def parse_claude_window(window_id: str, label: str, duration: int | None, raw: Any, timezone_name: str, source: str) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    used = clamp_percent(first_present(raw, _USED_KEYS))
    remaining = clamp_percent(first_present(raw, _REMAINING_KEYS))
    if remaining is None and used is not None:
        remaining = 100 - used
    if used is None and remaining is not None:
        used = 100 - remaining

    reset_at, reset_after_seconds = _iso_reset(
        first_present(raw, _RESET_AT_KEYS),
        first_present(raw, _RESET_AFTER_KEYS),
        timezone_name,
    )
    limit_reached = first_present(raw, ["limit_reached", "limitReached", "at_limit", "atLimit"])
    if limit_reached is None and used is not None:
        limit_reached = used >= 100

    if used is None and remaining is None and reset_at is None:
        return None

    raw_duration = first_present(raw, ["limit_window_seconds", "limitWindowSeconds", "window_seconds", "windowSeconds"])
    try:
        raw_duration = int(raw_duration) if raw_duration is not None else None
    except (TypeError, ValueError):
        raw_duration = None

    return {
        "id": window_id,
        "label": label,
        "window_seconds": raw_duration or duration,
        "used_percent": used,
        "remaining_percent": remaining,
        "reset_at": reset_at,
        "reset_after_seconds": reset_after_seconds,
        "limit_reached": bool(limit_reached) if limit_reached is not None else None,
        "found": True,
        "source": source,
    }


def parse_claude_network_payload(payload: dict[str, Any], timezone_name: str, mode: str) -> dict[str, Any]:
    """Extrai janelas de uso de um payload observado do claude.ai.

    Primeiro tenta as chaves conhecidas (five_hour/seven_day/...); depois
    varre estruturas aninhadas com aparencia de janela. Se nada for
    reconhecido, levanta ValueError para o coletor tentar outro payload.
    """

    if not isinstance(payload, dict):
        raise ValueError("Payload de uso do Claude deve ser um objeto JSON.")

    windows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    def add_window(window: dict[str, Any] | None) -> None:
        if window and window["id"] not in seen_ids:
            seen_ids.add(window["id"])
            windows.append(window)

    for container in recursive_dicts(payload):
        for key, spec in _KNOWN_WINDOW_KEYS.items():
            if key in container:
                add_window(
                    parse_claude_window(
                        spec["id"], spec["label"], spec["duration"], container[key], timezone_name, "network"
                    )
                )

    if not windows:
        anonymous = [item for item in recursive_dicts(payload) if _looks_like_claude_window(item)]
        for index, raw in enumerate(anonymous):
            add_window(
                parse_claude_window(
                    f"janela_{index + 1}", f"Janela {index + 1}", None, raw, timezone_name, "network"
                )
            )

    if not windows:
        raise ValueError("O payload não contém janelas reconhecíveis de uso do Claude.")

    return {
        "schema_version": 1,
        "provider": "claude",
        "status": "ok",
        "extraction_mode": mode,
        "windows": windows,
    }


_DOM_SESSION_LABELS = ("sessão atual", "sessao atual", "current session", "session usage", "limite de sessão")
_DOM_WEEKLY_LABELS = ("todos os modelos", "limite semanal", "weekly limit", "all models", "semanal")
_DOM_OPUS_LABELS = ("opus",)

_PERCENT_PATTERN = re.compile(r"(\d{1,3})\s*%")
_RESET_PATTERN = re.compile(
    r"(?:reset[as]?|redefini[çc][ãa]o)[^\d]{0,40}(\d{1,2}:\d{2})",
    re.IGNORECASE,
)


def _dom_percent_used(block: str) -> int | None:
    match = _PERCENT_PATTERN.search(block)
    if not match:
        return None
    percent = clamp_percent(match.group(1))
    if percent is None:
        return None
    lowered = block.lower()
    # A pagina do claude.ai exibe percentual USADO; textos com
    # "restante(s)/left" indicam o complemento.
    if "restante" in lowered or "left" in lowered or "remaining" in lowered:
        return 100 - percent
    return percent


def _dom_reset_at(block: str, timezone_name: str) -> str | None:
    match = _RESET_PATTERN.search(block)
    if not match:
        return None
    hour, minute = match.group(1).split(":")
    current = now(timezone_name)
    candidate = current.replace(hour=int(hour), minute=int(minute), second=0, microsecond=0)
    if candidate < current:
        candidate = candidate.replace(day=candidate.day)
        from datetime import timedelta

        candidate += timedelta(days=1)
    return candidate.isoformat(timespec="seconds")


def parse_claude_dom_text(body_text: str, timezone_name: str) -> dict[str, Any]:
    """Fallback de DOM da pagina de uso do claude.ai (pt-BR e en)."""

    normalized = "\n".join(" ".join(line.split()) for line in body_text.splitlines() if line.strip())
    lowered = normalized.lower()

    def block_for(labels: tuple[str, ...]) -> str:
        for label in labels:
            index = lowered.find(label)
            if index >= 0:
                return normalized[index:index + 220]
        return ""

    windows: list[dict[str, Any]] = []
    for window_id, label, duration, labels in (
        ("session", "Sessão (5 horas)", SESSION_WINDOW_SECONDS, _DOM_SESSION_LABELS),
        ("weekly", "Limite semanal", WEEKLY_WINDOW_SECONDS, _DOM_WEEKLY_LABELS),
        ("weekly_opus", "Semanal (Opus)", WEEKLY_WINDOW_SECONDS, _DOM_OPUS_LABELS),
    ):
        block = block_for(labels)
        if not block:
            continue
        used = _dom_percent_used(block)
        reset_at = _dom_reset_at(block, timezone_name)
        if used is None and reset_at is None:
            continue
        windows.append({
            "id": window_id,
            "label": label,
            "window_seconds": duration,
            "used_percent": used,
            "remaining_percent": None if used is None else 100 - used,
            "reset_at": reset_at,
            "reset_after_seconds": seconds_until(reset_at, timezone_name),
            "limit_reached": None,
            "found": True,
            "source": "dom",
        })

    return {
        "schema_version": 1,
        "provider": "claude",
        "status": "ok" if windows else "not_found",
        "extraction_mode": "dom_fallback",
        "windows": windows,
    }


def detect_claude_page_state(body_text: str, page_url: str = "") -> str | None:
    """Identifica login expirado ou verificacao humana na pagina do claude.ai."""

    lowered = f"{body_text}\n{page_url}".lower()
    if any(term in lowered for term in ("verify you are human", "confirme que e humano", "confirme que é humano", "just a moment", "cf-challenge")):
        return "human_verification_required"
    login_terms = ("sign in to claude", "log in to claude", "entre na sua conta", "faça login", "faca login", "/login")
    if any(term in lowered for term in login_terms):
        return "login_required"
    return None
