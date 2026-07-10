from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo


def get_timezone(name: str):
    try:
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


def now(name: str) -> datetime:
    return datetime.now(get_timezone(name))


def now_iso(name: str) -> str:
    return now(name).isoformat(timespec="seconds")


def epoch_to_iso(value: Any, timezone_name: str) -> str | None:
    if value is None:
        return None
    try:
        epoch = float(value)
        if epoch > 10_000_000_000:
            epoch /= 1000
        return datetime.fromtimestamp(epoch, tz=timezone.utc).astimezone(
            get_timezone(timezone_name)
        ).isoformat(timespec="seconds")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def seconds_from_now_to_iso(value: Any, timezone_name: str) -> str | None:
    if value is None:
        return None
    try:
        seconds = max(0, int(float(value)))
    except (TypeError, ValueError):
        return None
    return (now(timezone_name) + timedelta(seconds=seconds)).isoformat(timespec="seconds")


def seconds_until(iso_value: str | None, timezone_name: str) -> int | None:
    if not iso_value:
        return None
    try:
        dt = datetime.fromisoformat(iso_value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=get_timezone(timezone_name))
        return max(0, int((dt - now(timezone_name)).total_seconds()))
    except ValueError:
        return None
