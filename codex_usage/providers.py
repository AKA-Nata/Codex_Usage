"""Camada multi-provedor de uso de IA.

Define o contrato comum ``AIUsageProvider`` e os provedores concretos
(Codex e Claude). O contrato padroniza janelas dinamicas de uso — nenhum
provedor assume quantidade fixa de janelas — e distingue explicitamente
"zero" (percentual 0 real) de "dado indisponivel" (``None``). Falhas de
coleta nunca apagam o ultimo dado valido: os coletores gravam somente o
arquivo de saude quando falham, e o status reflete os dois arquivos.
"""

from __future__ import annotations

import subprocess
import sys
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

from .claude_cli import probe_claude_cli, sanitize_cli_text
from .claude_monitor import (
    CLAUDE_HEALTH_JSON_KEY,
    CLAUDE_USAGE_JSON_KEY,
    DEFAULT_CLAUDE_HEALTH_JSON,
    DEFAULT_CLAUDE_USAGE_JSON,
    claude_cdp_settings,
)
from .config import BASE_DIR, resolve_path
from .storage import atomic_write_json, read_json
from .timeutils import get_timezone, now, now_iso

PROVIDER_STATES = ("ok", "stale", "error", "unavailable", "unsupported", "disabled")
CLAUDE_STRATEGIES = ("auto", "cli", "cdp", "api")
CLAUDE_CLI_PROBE_JSON = "data/claude-cli-probe.json"
CLAUDE_CLI_PROBE_TTL_SECONDS = 900

DEFAULT_PROVIDERS_CONFIG: dict[str, Any] = {
    "codex": {
        "enabled": True,
        "strategy": "cdp",
    },
    "claude": {
        "enabled": True,
        "strategy": "auto",
        "cli": {"path": None, "timeout_seconds": 20},
        "cdp": {
            "host": "127.0.0.1",
            "port": 9223,
            "profile_dir": "runtime/claude-cdp-profile",
            "usage_url": "https://claude.ai/settings/usage",
            "capture_wait_seconds": 20,
            "timeout_seconds": 45,
        },
        "api": {"enabled": False},
    },
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = deepcopy(value)
    return merged


def providers_config(config: dict[str, Any]) -> dict[str, Any]:
    """Resolve a secao ``providers`` com defaults e migracao de configs antigas.

    Configuracoes anteriores ao schema 5 nao possuem ``providers``; nesse
    caso o Codex permanece habilitado com a estrategia CDP historica e o
    Claude nasce em ``auto`` (degrada com UNAVAILABLE quando nao ha fonte).
    """

    return _deep_merge(DEFAULT_PROVIDERS_CONFIG, config.get("providers") or {})


def _parse_iso(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _is_stale(collected_at: Any, config: dict[str, Any]) -> bool:
    parsed = _parse_iso(collected_at)
    if parsed is None:
        return True
    timezone_name = config.get("timezone", "America/Sao_Paulo")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=get_timezone(timezone_name))
    age_minutes = (now(timezone_name) - parsed).total_seconds() / 60
    return age_minutes > float(config.get("stale_after_minutes", 45))


def _run_collector(module_name: str, timeout_seconds: int) -> dict[str, Any]:
    try:
        process = subprocess.run(
            [sys.executable, "-m", module_name],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            timeout=max(30, int(timeout_seconds)),
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "timeout": True, "message": "A coleta excedeu o tempo limite."}
    message = sanitize_cli_text(process.stderr or process.stdout or "", limit=1000)
    return {"ok": process.returncode == 0, "timeout": False, "return_code": process.returncode, "message": message}


class AIUsageProvider:
    """Contrato comum dos provedores de uso de IA."""

    provider_id: str = ""
    label: str = ""

    def __init__(self, config: dict[str, Any]):
        self.config = config
        self.settings = providers_config(config).get(self.provider_id) or {}

    @property
    def enabled(self) -> bool:
        return self.settings.get("enabled", True) is not False

    @property
    def strategy(self) -> str:
        return str(self.settings.get("strategy") or "auto")

    def available(self) -> bool:
        raise NotImplementedError

    def status(self) -> dict[str, Any]:
        raise NotImplementedError

    def refresh(self) -> dict[str, Any]:
        raise NotImplementedError

    def describe(self) -> dict[str, Any]:
        status = self.status()
        return {
            "provider": self.provider_id,
            "label": self.label,
            "enabled": self.enabled,
            "strategy": self.strategy,
            "state": status.get("state"),
            "source": status.get("source"),
            "available": self.available(),
            "collected_at": status.get("collected_at"),
        }

    def _base_status(self) -> dict[str, Any]:
        return {
            "provider": self.provider_id,
            "label": self.label,
            "enabled": self.enabled,
            "strategy": self.strategy,
            "state": "unavailable",
            "source": None,
            "collected_at": None,
            "last_success_at": None,
            "windows": [],
            "data_available": False,
            "health": {},
            "error": None,
        }


def _codex_window(window_id: str, raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not raw.get("found"):
        return None
    return {
        "id": window_id,
        "label": raw.get("label") or window_id,
        "window_seconds": raw.get("window_seconds"),
        "used_percent": raw.get("used_percent"),
        "remaining_percent": raw.get("remaining_percent"),
        "reset_at": raw.get("reset_at"),
        "reset_after_seconds": raw.get("reset_after_seconds"),
        "limit_reached": raw.get("limit_reached"),
        "found": True,
        "source": raw.get("source"),
    }


class CodexUsageProvider(AIUsageProvider):
    provider_id = "codex"
    label = "OpenAI Codex"

    def available(self) -> bool:
        if not self.enabled:
            return False
        usage_path = resolve_path(self.config, "output_json", "data/codex-usage.json")
        health_path = resolve_path(self.config, "health_json", "data/collector-health.json")
        return usage_path.exists() or health_path.exists() or bool(self.config.get("codex_usage_url"))

    def status(self) -> dict[str, Any]:
        status = self._base_status()
        if not self.enabled:
            status["state"] = "disabled"
            return status
        usage = read_json(resolve_path(self.config, "output_json", "data/codex-usage.json"), {}) or {}
        health = read_json(resolve_path(self.config, "health_json", "data/collector-health.json"), {}) or {}
        status["health"] = health
        status["last_success_at"] = health.get("last_success_at")

        resets = usage.get("resets") or {}
        windows = [
            window
            for window in (
                _codex_window("5h", resets.get("limite_5h")),
                _codex_window("weekly", resets.get("limite_semanal")),
            )
            if window
        ]
        status["windows"] = windows
        status["collected_at"] = usage.get("collected_at")
        status["source"] = usage.get("extraction_mode") or health.get("last_extraction_mode")
        status["data_available"] = any(
            window.get("used_percent") is not None or window.get("remaining_percent") is not None
            for window in windows
        )

        health_status = health.get("status")
        if health_status and health_status != "ok":
            status["state"] = "error"
            status["error"] = health.get("message")
        elif not usage and not health:
            status["state"] = "unavailable"
            status["error"] = "Nenhuma coleta do Codex foi registrada ainda."
        elif _is_stale(status["collected_at"], self.config):
            status["state"] = "stale"
        else:
            status["state"] = "ok"
        return status

    def refresh(self) -> dict[str, Any]:
        if not self.enabled:
            return {"ok": False, "message": "Provedor Codex desabilitado na configuração."}
        timeout = int(self.config.get("cdp_monitor_timeout_seconds", 45))
        result = _run_collector("codex_usage.cdp_monitor", timeout)
        return {**result, "status": self.status()}


class ClaudeUsageProvider(AIUsageProvider):
    provider_id = "claude"
    label = "Anthropic Claude"

    API_UNSUPPORTED_REASON = (
        "Não existe API pública oficial que exponha os limites de uso da assinatura "
        "Claude/Claude Code; a estratégia 'api' permanece indisponível para não inventar valores."
    )

    def _cli_settings(self) -> dict[str, Any]:
        raw = self.settings.get("cli") or {}
        timeout = raw.get("timeout_seconds", raw.get("timeoutSeconds", 20))
        try:
            timeout = max(1, int(timeout))
        except (TypeError, ValueError):
            timeout = 20
        return {"path": raw.get("path") or None, "timeout_seconds": timeout}

    def _cli_probe_path(self) -> Path:
        return resolve_path(self.config, "claude_cli_probe_json", CLAUDE_CLI_PROBE_JSON)

    def _read_cli_probe(self, *, allow_probe: bool = True) -> dict[str, Any]:
        probe = read_json(self._cli_probe_path(), None)
        if isinstance(probe, dict):
            checked = _parse_iso(probe.get("checked_at"))
            if checked is not None:
                timezone_name = self.config.get("timezone", "America/Sao_Paulo")
                if checked.tzinfo is None:
                    checked = checked.replace(tzinfo=get_timezone(timezone_name))
                age = (now(timezone_name) - checked).total_seconds()
                if 0 <= age <= CLAUDE_CLI_PROBE_TTL_SECONDS:
                    return probe
        if not allow_probe:
            return probe if isinstance(probe, dict) else {"strategy": "cli", "found": False, "usage_supported": False}
        return self.run_cli_probe()

    def run_cli_probe(self) -> dict[str, Any]:
        cli = self._cli_settings()
        probe = probe_claude_cli(
            cli["path"],
            timeout_seconds=cli["timeout_seconds"],
            timezone_name=self.config.get("timezone", "America/Sao_Paulo"),
        )
        atomic_write_json(self._cli_probe_path(), probe)
        return probe

    def available(self) -> bool:
        if not self.enabled:
            return False
        usage_path = resolve_path(self.config, CLAUDE_USAGE_JSON_KEY, DEFAULT_CLAUDE_USAGE_JSON)
        if usage_path.exists():
            return True
        probe = self._read_cli_probe(allow_probe=False)
        return bool(probe and probe.get("found"))

    def status(self) -> dict[str, Any]:
        status = self._base_status()
        if not self.enabled:
            status["state"] = "disabled"
            return status

        usage = read_json(resolve_path(self.config, CLAUDE_USAGE_JSON_KEY, DEFAULT_CLAUDE_USAGE_JSON), {}) or {}
        health = read_json(resolve_path(self.config, CLAUDE_HEALTH_JSON_KEY, DEFAULT_CLAUDE_HEALTH_JSON), {}) or {}
        probe = self._read_cli_probe(allow_probe=False) or {}

        status["health"] = health
        status["last_success_at"] = health.get("last_success_at")
        windows = [window for window in (usage.get("windows") or []) if isinstance(window, dict) and window.get("found")]
        status["windows"] = deepcopy(windows)
        status["collected_at"] = usage.get("collected_at")
        status["source"] = usage.get("extraction_mode") or health.get("last_extraction_mode")
        status["data_available"] = any(
            window.get("used_percent") is not None or window.get("remaining_percent") is not None
            for window in windows
        )
        status["cli"] = {
            "found": bool(probe.get("found")),
            "version": probe.get("version"),
            "usage_supported": bool(probe.get("usage_supported")),
            "auth": probe.get("auth") if isinstance(probe.get("auth"), dict) else None,
            "checked_at": probe.get("checked_at"),
        }

        health_status = health.get("status")
        if health_status and health_status not in ("ok", "cli_probe", "unsupported"):
            status["state"] = "error"
            status["error"] = health.get("message")
        elif status["data_available"]:
            status["state"] = "stale" if _is_stale(status["collected_at"], self.config) else "ok"
        elif self.strategy == "api":
            status["state"] = "unsupported"
            status["error"] = self.API_UNSUPPORTED_REASON
        elif self.strategy == "cli" or (self.strategy == "auto" and probe.get("found") and not usage):
            status["state"] = "unsupported"
            status["error"] = probe.get("usage_support_reason") or (
                "A CLI do Claude Code não expõe janelas de uso verificáveis."
            )
        else:
            status["state"] = "unavailable"
            status["error"] = health.get("message") or (
                "Nenhuma fonte confiável de uso do Claude está disponível no momento."
            )
        return status

    def _write_health(self, status: str, message: str | None, mode: str | None = None) -> None:
        timezone_name = self.config.get("timezone", "America/Sao_Paulo")
        path = resolve_path(self.config, CLAUDE_HEALTH_JSON_KEY, DEFAULT_CLAUDE_HEALTH_JSON)
        previous = read_json(path, {}) or {}
        is_ok = status == "ok"
        atomic_write_json(
            path,
            {
                "schema_version": 1,
                "provider": "claude",
                "status": status,
                "checked_at": now_iso(timezone_name),
                "last_success_at": now_iso(timezone_name) if is_ok else previous.get("last_success_at"),
                "last_extraction_mode": mode if is_ok or mode is not None else previous.get("last_extraction_mode"),
                "consecutive_failures": 0 if is_ok else int(previous.get("consecutive_failures") or 0) + 1,
                "message": message,
            },
        )

    def refresh(self) -> dict[str, Any]:
        if not self.enabled:
            return {"ok": False, "message": "Provedor Claude desabilitado na configuração."}

        strategy = self.strategy if self.strategy in CLAUDE_STRATEGIES else "auto"
        attempts: list[str] = []

        if strategy in ("auto", "cdp"):
            attempts.append("cdp")
            timeout = int((self.settings.get("cdp") or {}).get("timeout_seconds", 45))
            result = _run_collector("codex_usage.claude_monitor", timeout)
            if result["ok"]:
                return {**result, "strategy_used": "cdp", "status": self.status()}
            if strategy == "cdp":
                if result.get("timeout"):
                    self._write_health("error", "A coleta CDP do Claude excedeu o tempo limite.")
                return {**result, "strategy_used": "cdp", "status": self.status()}

        if strategy in ("auto", "cli"):
            attempts.append("cli")
            probe = self.run_cli_probe()
            usage = read_json(resolve_path(self.config, CLAUDE_USAGE_JSON_KEY, DEFAULT_CLAUDE_USAGE_JSON), {}) or {}
            if probe.get("found"):
                # A CLI confirma disponibilidade/autenticacao, mas nao publica
                # janelas de uso; o ultimo dado valido (se houver) e preservado.
                if not usage:
                    self._write_health(
                        "unsupported",
                        probe.get("usage_support_reason"),
                        mode="cli_probe",
                    )
                message = "CLI do Claude Code detectada; janelas de uso não são expostas pela CLI."
                return {
                    "ok": bool(usage),
                    "strategy_used": "cli",
                    "attempts": attempts,
                    "message": message,
                    "status": self.status(),
                }
            if not usage:
                self._write_health(
                    "error",
                    "Nenhuma fonte de uso do Claude respondeu: CDP indisponível e CLI não encontrada.",
                )
            return {
                "ok": False,
                "strategy_used": None,
                "attempts": attempts,
                "message": "Nenhuma fonte confiável de uso do Claude está disponível.",
                "status": self.status(),
            }

        if strategy == "api":
            self._write_health("unsupported", self.API_UNSUPPORTED_REASON)
            return {
                "ok": False,
                "strategy_used": "api",
                "attempts": ["api"],
                "message": self.API_UNSUPPORTED_REASON,
                "status": self.status(),
            }

        return {"ok": False, "message": f"Estratégia desconhecida: {strategy}", "status": self.status()}


def build_providers(config: dict[str, Any]) -> dict[str, AIUsageProvider]:
    """Registry ordenado dos provedores suportados."""

    return {
        "codex": CodexUsageProvider(config),
        "claude": ClaudeUsageProvider(config),
    }


def providers_usage_payload(providers: dict[str, AIUsageProvider], timezone_name: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "generated_at": now_iso(timezone_name),
        "providers": {provider_id: provider.status() for provider_id, provider in providers.items()},
    }
