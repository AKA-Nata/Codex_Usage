from __future__ import annotations

import ctypes
import json
import platform
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import psutil
except ImportError:  # pragma: no cover - validated by scripts/_common.ps1
    psutil = None

from .config import BASE_DIR
from .timeutils import get_timezone


_WEATHER_CACHE_LOCK = threading.Lock()
_WEATHER_CACHE: dict[str, Any] = {"expires_at": 0.0, "payload": None, "cache_key": None}


@dataclass(frozen=True)
class WeatherDescription:
    label: str
    icon: str


_WEATHER_CODES: dict[int, WeatherDescription] = {
    0: WeatherDescription("Céu limpo", "☀"),
    1: WeatherDescription("Predominantemente limpo", "🌤"),
    2: WeatherDescription("Parcialmente nublado", "⛅"),
    3: WeatherDescription("Nublado", "☁"),
    45: WeatherDescription("Neblina", "🌫"),
    48: WeatherDescription("Neblina com geada", "🌫"),
    51: WeatherDescription("Garoa leve", "🌦"),
    53: WeatherDescription("Garoa", "🌦"),
    55: WeatherDescription("Garoa intensa", "🌧"),
    56: WeatherDescription("Garoa congelante", "🌧"),
    57: WeatherDescription("Garoa congelante intensa", "🌧"),
    61: WeatherDescription("Chuva leve", "🌦"),
    63: WeatherDescription("Chuva", "🌧"),
    65: WeatherDescription("Chuva forte", "🌧"),
    66: WeatherDescription("Chuva congelante", "🌧"),
    67: WeatherDescription("Chuva congelante forte", "🌧"),
    71: WeatherDescription("Neve leve", "🌨"),
    73: WeatherDescription("Neve", "🌨"),
    75: WeatherDescription("Neve forte", "❄"),
    77: WeatherDescription("Grãos de neve", "❄"),
    80: WeatherDescription("Pancadas leves", "🌦"),
    81: WeatherDescription("Pancadas de chuva", "🌧"),
    82: WeatherDescription("Pancadas fortes", "⛈"),
    85: WeatherDescription("Pancadas de neve", "🌨"),
    86: WeatherDescription("Pancadas fortes de neve", "❄"),
    95: WeatherDescription("Trovoadas", "⛈"),
    96: WeatherDescription("Trovoadas com granizo", "⛈"),
    99: WeatherDescription("Trovoadas fortes com granizo", "⛈"),
}


def describe_weather(code: Any) -> WeatherDescription:
    try:
        numeric_code = int(code)
    except (TypeError, ValueError):
        return WeatherDescription("Condição indisponível", "◌")
    return _WEATHER_CODES.get(numeric_code, WeatherDescription("Condição não identificada", "◌"))


def _round_or_none(value: Any, digits: int = 1) -> float | None:
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return None


def _gb(value: Any) -> float | None:
    try:
        return round(float(value) / (1024 ** 3), 1)
    except (TypeError, ValueError):
        return None


def get_windows_idle_seconds() -> float | None:
    """Retorna o tempo sem entrada no Windows, sem instalar hooks globais."""

    if platform.system().lower() != "windows":
        return None

    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

    try:
        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(info)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
            return None
        elapsed_ms = ctypes.windll.kernel32.GetTickCount64() - info.dwTime
        return round(max(0.0, elapsed_ms / 1000.0), 1)
    except Exception:
        return None


def get_machine_metrics() -> dict[str, Any]:
    if psutil is None:
        return {
            "status": "unavailable",
            "message": "psutil não instalado",
            "cpu_percent": None,
            "memory_percent": None,
            "disk_percent": None,
        }

    try:
        cpu_percent = round(float(psutil.cpu_percent(interval=0.12)), 1)
        memory = psutil.virtual_memory()
        disk_root = Path.home().anchor or str(BASE_DIR.anchor or BASE_DIR)
        disk = psutil.disk_usage(disk_root)

        battery = None
        try:
            raw_battery = psutil.sensors_battery()
            if raw_battery is not None:
                battery = {
                    "percent": _round_or_none(raw_battery.percent),
                    "plugged": bool(raw_battery.power_plugged),
                    "seconds_left": None if raw_battery.secsleft in {-1, -2} else raw_battery.secsleft,
                }
        except (AttributeError, OSError):
            battery = None

        return {
            "status": "ok",
            "cpu_percent": cpu_percent,
            "cpu_count_logical": psutil.cpu_count(logical=True),
            "memory_percent": round(float(memory.percent), 1),
            "memory_used_gb": _gb(memory.used),
            "memory_total_gb": _gb(memory.total),
            "disk_percent": round(float(disk.percent), 1),
            "disk_used_gb": _gb(disk.used),
            "disk_total_gb": _gb(disk.total),
            "battery": battery,
            "system_idle_seconds": get_windows_idle_seconds(),
        }
    except Exception as exc:
        return {
            "status": "error",
            "message": str(exc),
            "cpu_percent": None,
            "memory_percent": None,
            "disk_percent": None,
            "system_idle_seconds": get_windows_idle_seconds(),
        }


def _build_weather_url(weather_config: dict[str, Any]) -> str:
    params = {
        "latitude": weather_config["latitude"],
        "longitude": weather_config["longitude"],
        "current": "temperature_2m,apparent_temperature,is_day,weather_code,wind_speed_10m",
        "temperature_unit": "celsius",
        "wind_speed_unit": "kmh",
        "timezone": "auto",
    }
    return "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params)


def _weather_cache_key(weather_config: dict[str, Any]) -> str:
    return json.dumps(
        {
            "latitude": weather_config.get("latitude"),
            "longitude": weather_config.get("longitude"),
            "location_label": weather_config.get("location_label"),
        },
        sort_keys=True,
        ensure_ascii=False,
    )


def get_weather(weather_config: dict[str, Any] | None) -> dict[str, Any]:
    config = weather_config or {}
    if not config.get("enabled", False):
        return {
            "status": "disabled",
            "location": config.get("location_label") or "Não configurado",
            "temperature_c": None,
        }

    if config.get("latitude") is None or config.get("longitude") is None:
        return {
            "status": "error",
            "location": config.get("location_label") or "Não configurado",
            "message": "Latitude/longitude não configuradas",
            "temperature_c": None,
        }

    ttl_seconds = max(60, int(config.get("cache_seconds", 600)))
    cache_key = _weather_cache_key(config)
    now = time.time()

    with _WEATHER_CACHE_LOCK:
        if (
            _WEATHER_CACHE.get("cache_key") == cache_key
            and _WEATHER_CACHE.get("payload") is not None
            and float(_WEATHER_CACHE.get("expires_at", 0)) > now
        ):
            cached = dict(_WEATHER_CACHE["payload"])
            cached["cached"] = True
            return cached

    url = _build_weather_url(config)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "CodexUsageMonitor/4.0.1 local-dashboard"},
        method="GET",
    )

    try:
        with urllib.request.urlopen(request, timeout=max(2, int(config.get("timeout_seconds", 5)))) as response:
            raw = json.loads(response.read().decode("utf-8"))

        current = raw.get("current") or {}
        weather_code = current.get("weather_code")
        description = describe_weather(weather_code)
        payload = {
            "status": "ok",
            "location": config.get("location_label") or "Local configurado",
            "temperature_c": _round_or_none(current.get("temperature_2m")),
            "apparent_temperature_c": _round_or_none(current.get("apparent_temperature")),
            "wind_speed_kmh": _round_or_none(current.get("wind_speed_10m")),
            "weather_code": weather_code,
            "condition": description.label,
            "icon": description.icon,
            "is_day": bool(current.get("is_day")) if current.get("is_day") is not None else None,
            "observed_at": current.get("time"),
            "cached": False,
        }

        with _WEATHER_CACHE_LOCK:
            _WEATHER_CACHE.update(
                {
                    "cache_key": cache_key,
                    "payload": payload,
                    "expires_at": now + ttl_seconds,
                }
            )
        return payload
    except Exception as exc:
        with _WEATHER_CACHE_LOCK:
            cached_payload = _WEATHER_CACHE.get("payload")
            if _WEATHER_CACHE.get("cache_key") == cache_key and cached_payload:
                stale = dict(cached_payload)
                stale.update({"status": "stale", "cached": True, "message": str(exc)})
                return stale
        return {
            "status": "error",
            "location": config.get("location_label") or "Local configurado",
            "temperature_c": None,
            "message": str(exc),
            "cached": False,
        }


def build_telemetry(config: dict[str, Any]) -> dict[str, Any]:
    tz_name = str(config.get("timezone") or "America/Sao_Paulo")
    tz = get_timezone(tz_name)
    now = datetime.now(tz)
    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "timezone": tz_name,
        "clock": {
            "iso": now.isoformat(timespec="seconds"),
            "time": now.strftime("%H:%M:%S"),
            "date": now.strftime("%d/%m/%Y"),
        },
        "machine": get_machine_metrics(),
        "weather": get_weather(config.get("weather") or {}),
    }
