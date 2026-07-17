from __future__ import annotations

import json
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = BASE_DIR / "config.json"


class ConfigError(ValueError):
    pass


def load_config(path: Path | None = None) -> dict[str, Any]:
    config_path = path or DEFAULT_CONFIG_PATH
    if not config_path.exists():
        raise ConfigError(f"Arquivo de configuracao nao encontrado: {config_path}")

    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"JSON invalido em {config_path}: {exc}") from exc

    required = ["codex_usage_url", "timezone", "output_json", "health_json"]
    missing = [key for key in required if not config.get(key)]
    if missing:
        raise ConfigError(f"Campos obrigatorios ausentes no config.json: {', '.join(missing)}")

    dashboard = config.get("dashboard") or {}
    port = dashboard.get("port", 8088)
    if not isinstance(port, int) or not (1 <= port <= 65535):
        raise ConfigError("dashboard.port deve estar entre 1 e 65535")

    cdp = config.get("cdp_monitor") or {}
    cdp_port = cdp.get("port", 9222)
    if not isinstance(cdp_port, int) or not (1 <= cdp_port <= 65535):
        raise ConfigError("cdp_monitor.port deve estar entre 1 e 65535")

    providers = config.get("providers")
    if providers is not None:
        if not isinstance(providers, dict):
            raise ConfigError("providers deve ser um objeto")
        claude = providers.get("claude") or {}
        if not isinstance(claude, dict):
            raise ConfigError("providers.claude deve ser um objeto")
        strategy = claude.get("strategy", "auto")
        if strategy not in ("auto", "cli", "cdp", "api"):
            raise ConfigError("providers.claude.strategy deve ser auto, cli, cdp ou api")
        claude_cdp = claude.get("cdp") or {}
        claude_port = claude_cdp.get("port", 9223)
        if not isinstance(claude_port, int) or not (1 <= claude_port <= 65535):
            raise ConfigError("providers.claude.cdp.port deve estar entre 1 e 65535")
        if claude_port == cdp_port:
            raise ConfigError("providers.claude.cdp.port deve ser diferente de cdp_monitor.port")

    weather = config.get("weather") or {}
    if weather.get("enabled", False):
        latitude = weather.get("latitude")
        longitude = weather.get("longitude")
        if not isinstance(latitude, (int, float)) or not (-90 <= latitude <= 90):
            raise ConfigError("weather.latitude deve estar entre -90 e 90")
        if not isinstance(longitude, (int, float)) or not (-180 <= longitude <= 180):
            raise ConfigError("weather.longitude deve estar entre -180 e 180")

    return config


def resolve_path(config: dict[str, Any], key: str, default: str) -> Path:
    raw = config.get(key) or default
    path = Path(str(raw))
    if path.is_absolute():
        return path
    return BASE_DIR / path
