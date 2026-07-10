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
        raise ConfigError(f"Arquivo de configuração não encontrado: {config_path}")

    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"JSON inválido em {config_path}: {exc}") from exc

    required = ["codex_usage_url", "timezone", "output_json", "health_json"]
    missing = [key for key in required if not config.get(key)]
    if missing:
        raise ConfigError(f"Campos obrigatórios ausentes no config.json: {', '.join(missing)}")

    endpoints = config.get("network_endpoints")
    if not isinstance(endpoints, list) or not endpoints:
        raise ConfigError("network_endpoints deve ser uma lista não vazia")

    dashboard = config.get("dashboard") or {}
    port = dashboard.get("port", 8088)
    if not isinstance(port, int) or not (1 <= port <= 65535):
        raise ConfigError("dashboard.port deve estar entre 1 e 65535")

    return config


def resolve_path(config: dict[str, Any], key: str, default: str) -> Path:
    raw = config.get(key) or default
    path = Path(str(raw))
    if path.is_absolute():
        return path
    return BASE_DIR / path
