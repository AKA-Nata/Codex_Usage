from __future__ import annotations

from typing import Any

from .timeutils import now_iso

_WINDOWS = ("limite_5h", "limite_semanal")


def _percent(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return max(0, min(100, int(round(float(value)))))
    except (TypeError, ValueError):
        return None


def _integer(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _text(value: Any, maximum: int = 80) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:maximum] if value else None


def normalize_browser_payload(payload: Any, timezone_name: str) -> dict[str, Any]:
    """Accept only the small, account-free schema sent by the browser extension."""
    if not isinstance(payload, dict):
        raise ValueError("O corpo da extensao deve ser um objeto JSON.")

    resets = payload.get("resets")
    if not isinstance(resets, dict):
        raise ValueError("O corpo da extensao nao possui resets validos.")

    normalized_resets: dict[str, dict[str, Any]] = {}
    found_any = False
    labels = {
        "limite_5h": "Limite de uso de 5 horas",
        "limite_semanal": "Limite de uso semanal",
    }
    for key in _WINDOWS:
        raw = resets.get(key)
        raw = raw if isinstance(raw, dict) else {}
        used = _percent(raw.get("used_percent"))
        remaining = _percent(raw.get("remaining_percent"))
        if remaining is None and used is not None:
            remaining = 100 - used
        if used is None and remaining is not None:
            used = 100 - remaining
        reset_at = _text(raw.get("reset_at"), 40)
        window_seconds = _integer(raw.get("window_seconds"))
        found = bool(raw.get("found")) or any(
            value is not None for value in (used, remaining, reset_at, window_seconds)
        )
        found_any = found_any or found
        normalized_resets[key] = {
            "label": labels[key],
            "found": found,
            "window_seconds": window_seconds,
            "used_percent": used,
            "remaining_percent": remaining,
            "reset_at": reset_at,
            "source": "browser",
        }

    if not found_any:
        raise ValueError("A extensao nao encontrou dados de uso aproveitaveis.")

    mode = payload.get("extraction_mode")
    if mode not in {"browser_network", "browser_dom", "browser_network_dom"}:
        mode = "browser_network_dom"

    return {
        "schema_version": 2,
        "status": "ok",
        "extraction_mode": mode,
        "collected_at": now_iso(timezone_name),
        "source_url": "https://chatgpt.com/codex/cloud/settings/analytics",
        "limit_reached": payload.get("limit_reached") if isinstance(payload.get("limit_reached"), bool) else None,
        "allowed": payload.get("allowed") if isinstance(payload.get("allowed"), bool) else None,
        "resets": normalized_resets,
    }
