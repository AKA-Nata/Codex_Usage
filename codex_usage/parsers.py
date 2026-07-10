from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any, Iterable

from .timeutils import epoch_to_iso, get_timezone, now, seconds_from_now_to_iso, seconds_until

PRIMARY_WINDOW_SECONDS = 18_000
WEEKLY_WINDOW_SECONDS = 604_800


def clamp_percent(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return max(0, min(100, int(round(float(value)))))
    except (TypeError, ValueError):
        return None


def first_present(data: dict[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        if key in data and data[key] is not None:
            return data[key]
    return None


def recursive_dicts(obj: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if isinstance(obj, dict):
        result.append(obj)
        for value in obj.values():
            result.extend(recursive_dicts(value))
    elif isinstance(obj, list):
        for item in obj:
            result.extend(recursive_dicts(item))
    return result


def looks_like_window(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    keys = set(value)
    return bool(
        keys
        & {
            "used_percent",
            "usedPercent",
            "remaining_percent",
            "remainingPercent",
            "reset_at",
            "resetAt",
            "reset_after_seconds",
            "resetAfterSeconds",
        }
    )


def window_duration(value: dict[str, Any]) -> int | None:
    raw = first_present(value, ["limit_window_seconds", "limitWindowSeconds", "window_seconds"])
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def classify_windows(payload: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    rate_limit = (
        payload.get("rate_limit")
        or payload.get("rateLimit")
        or payload.get("rate_limits")
        or payload.get("rateLimits")
        or {}
    )

    primary = None
    secondary = None
    if isinstance(rate_limit, dict):
        primary = rate_limit.get("primary_window") or rate_limit.get("primaryWindow")
        secondary = rate_limit.get("secondary_window") or rate_limit.get("secondaryWindow")

    primary = primary or payload.get("primary_window") or payload.get("primaryWindow")
    secondary = secondary or payload.get("secondary_window") or payload.get("secondaryWindow")

    direct = [item for item in [primary, secondary] if looks_like_window(item)]
    if direct:
        if len(direct) == 2:
            durations = [window_duration(item) for item in direct]
            if all(value is not None for value in durations):
                ordered = sorted(direct, key=lambda item: window_duration(item) or 0)
                return ordered[0], ordered[1]
        return (direct[0], direct[1] if len(direct) > 1 else None)

    candidates = [item for item in recursive_dicts(payload) if looks_like_window(item)]
    if not candidates:
        return None, None

    unique: list[dict[str, Any]] = []
    seen = set()
    for item in candidates:
        marker = id(item)
        if marker not in seen:
            seen.add(marker)
            unique.append(item)

    with_duration = [(window_duration(item), item) for item in unique]
    known = [(duration, item) for duration, item in with_duration if duration is not None]
    if known:
        known.sort(key=lambda pair: pair[0])
        primary = known[0][1]
        secondary = known[-1][1] if len(known) > 1 else None
        return primary, secondary

    return unique[0], unique[1] if len(unique) > 1 else None


def parse_window(label: str, window: Any, timezone_name: str, source: str) -> dict[str, Any]:
    if not isinstance(window, dict):
        return empty_window(label, source)

    used = clamp_percent(
        first_present(
            window,
            ["used_percent", "usedPercent", "usage_percent", "usagePercent", "percent_used", "percentUsed"],
        )
    )
    remaining = clamp_percent(
        first_present(
            window,
            ["remaining_percent", "remainingPercent", "percent_remaining", "percentRemaining"],
        )
    )
    if remaining is None and used is not None:
        remaining = 100 - used
    if used is None and remaining is not None:
        used = 100 - remaining

    reset_at_epoch = first_present(
        window,
        ["reset_at", "resetAt", "resets_at", "resetsAt", "reset_timestamp", "resetTimestamp"],
    )
    reset_after_seconds = first_present(
        window,
        ["reset_after_seconds", "resetAfterSeconds", "reset_after", "resetAfter", "seconds_until_reset", "secondsUntilReset"],
    )

    try:
        reset_after_seconds = int(float(reset_after_seconds)) if reset_after_seconds is not None else None
    except (TypeError, ValueError):
        reset_after_seconds = None

    reset_at = epoch_to_iso(reset_at_epoch, timezone_name)
    if reset_at is None:
        reset_at = seconds_from_now_to_iso(reset_after_seconds, timezone_name)

    duration = window_duration(window)
    found = any(value is not None for value in [used, remaining, reset_at_epoch, reset_after_seconds, duration])

    return {
        "label": label,
        "found": found,
        "window_seconds": duration,
        "used_percent": used,
        "remaining_percent": remaining,
        "reset_at_epoch": reset_at_epoch,
        "reset_at": reset_at,
        "reset_after_seconds": reset_after_seconds,
        "source": source,
    }


def empty_window(label: str, source: str) -> dict[str, Any]:
    return {
        "label": label,
        "found": False,
        "window_seconds": None,
        "used_percent": None,
        "remaining_percent": None,
        "reset_at_epoch": None,
        "reset_at": None,
        "reset_after_seconds": None,
        "source": source,
    }


def parse_network_payload(payload: dict[str, Any], timezone_name: str, mode: str) -> dict[str, Any]:
    primary, secondary = classify_windows(payload)
    five_hour = parse_window("Limite de uso de 5 horas", primary, timezone_name, "network")
    weekly = parse_window("Limite de uso semanal", secondary, timezone_name, "network")

    if not five_hour["found"] and not weekly["found"]:
        raise ValueError("O payload não contém janelas reconhecíveis de uso/reset.")

    rate_limit = (
        payload.get("rate_limit")
        or payload.get("rateLimit")
        or payload.get("rate_limits")
        or payload.get("rateLimits")
        or {}
    )
    if not isinstance(rate_limit, dict):
        rate_limit = {}

    return {
        "schema_version": 2,
        "status": "ok",
        "extraction_mode": mode,
        "limit_reached": first_present(rate_limit, ["limit_reached", "limitReached"]),
        "allowed": first_present(rate_limit, ["allowed", "is_allowed", "isAllowed"]),
        "resets": {
            "limite_5h": five_hour,
            "limite_semanal": weekly,
        },
    }


_PT_MONTHS = {
    "jan": 1, "jan.": 1, "janeiro": 1,
    "fev": 2, "fev.": 2, "fevereiro": 2,
    "mar": 3, "mar.": 3, "março": 3, "marco": 3,
    "abr": 4, "abr.": 4, "abril": 4,
    "mai": 5, "mai.": 5, "maio": 5,
    "jun": 6, "jun.": 6, "junho": 6,
    "jul": 7, "jul.": 7, "julho": 7,
    "ago": 8, "ago.": 8, "agosto": 8,
    "set": 9, "set.": 9, "setembro": 9,
    "out": 10, "out.": 10, "outubro": 10,
    "nov": 11, "nov.": 11, "novembro": 11,
    "dez": 12, "dez.": 12, "dezembro": 12,
}


def parse_ptbr_reset(raw: str | None, timezone_name: str) -> str | None:
    if not raw:
        return None
    text = " ".join(raw.strip().split())

    time_only = re.fullmatch(r"(\d{1,2}):(\d{2})", text)
    if time_only:
        hour, minute = map(int, time_only.groups())
        current = now(timezone_name)
        candidate = current.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate < current - timedelta(minutes=1):
            candidate += timedelta(days=1)
        return candidate.isoformat(timespec="seconds")

    full = re.fullmatch(
        r"(\d{1,2})\s+de\s+([a-zç.]+)\s+de\s+(\d{4})\s+(\d{1,2}):(\d{2})",
        text,
        flags=re.IGNORECASE,
    )
    if full:
        day = int(full.group(1))
        month = _PT_MONTHS.get(full.group(2).lower())
        year = int(full.group(3))
        hour = int(full.group(4))
        minute = int(full.group(5))
        if month:
            return datetime(year, month, day, hour, minute, tzinfo=get_timezone(timezone_name)).isoformat(
                timespec="seconds"
            )
    return None


def parse_dom_card(label: str, text: str, timezone_name: str, default_window_seconds: int) -> dict[str, Any]:
    percent_match = re.search(r"(\d{1,3})\s*%\s*restantes", text, re.IGNORECASE)
    reset_match = re.search(r"Redefinição\s*:?[ \t]*([^\r\n]+)", text, re.IGNORECASE)

    remaining = clamp_percent(percent_match.group(1)) if percent_match else None
    reset_raw = reset_match.group(1).strip() if reset_match else None
    reset_at = parse_ptbr_reset(reset_raw, timezone_name)

    return {
        "label": label,
        "found": remaining is not None or reset_at is not None,
        "window_seconds": default_window_seconds,
        "used_percent": None if remaining is None else 100 - remaining,
        "remaining_percent": remaining,
        "reset_at_epoch": None,
        "reset_at": reset_at,
        "reset_after_seconds": seconds_until(reset_at, timezone_name),
        "reset_display_raw": reset_raw,
        "source": "dom",
    }


def parse_dom_text(body_text: str, timezone_name: str) -> dict[str, Any]:
    normalized = "\n".join(" ".join(line.split()) for line in body_text.splitlines() if line.strip())

    def extract_block(label: str, next_labels: list[str]) -> str:
        end = "|".join(re.escape(item) for item in next_labels)
        match = re.search(
            rf"{re.escape(label)}(?P<block>.*?)(?={end}|$)",
            normalized,
            flags=re.IGNORECASE | re.DOTALL,
        )
        return match.group("block") if match else ""

    five_text = extract_block(
        "Limite de uso de 5 horas",
        ["Limite de uso semanal", "Créditos restantes", "Recarga automática", "Detalhes do uso"],
    )
    weekly_text = extract_block(
        "Limite de uso semanal",
        ["Créditos restantes", "Recarga automática", "Detalhes do uso"],
    )

    five_hour = parse_dom_card(
        "Limite de uso de 5 horas", five_text, timezone_name, PRIMARY_WINDOW_SECONDS
    )
    weekly = parse_dom_card(
        "Limite de uso semanal", weekly_text, timezone_name, WEEKLY_WINDOW_SECONDS
    )

    return {
        "schema_version": 2,
        "status": "ok" if five_hour["found"] or weekly["found"] else "not_found",
        "extraction_mode": "dom_fallback",
        "limit_reached": (
            "Limite de uso atingido" in normalized
            or "Você atingiu o limite de mensagens do Codex" in normalized
        ),
        "allowed": None,
        "resets": {
            "limite_5h": five_hour,
            "limite_semanal": weekly,
        },
    }
