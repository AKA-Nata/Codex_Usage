"""Coleta o uso do Claude (claude.ai) pelo CDP local, isolado do Codex.

Espelha o modelo de ``cdp_monitor``: navegador dedicado com perfil
proprio (porta CDP distinta da do Codex), leitura preferencial de
respostas de rede estruturadas e DOM apenas como fallback. Nenhum cookie,
token ou header de autenticacao e exportado, copiado ou persistido; o
monitor observa somente a pagina de uso e grava percentuais/resets.
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from typing import Any
from urllib.parse import urlparse
from urllib.request import urlopen

import websocket

from .claude_parsers import detect_claude_page_state, parse_claude_dom_text, parse_claude_network_payload
from .config import load_config, resolve_path
from .logging_setup import configure_logging
from .storage import atomic_write_json, read_json
from .timeutils import now_iso


class ClaudeCdpUnavailableError(RuntimeError):
    pass


DEFAULT_CLAUDE_USAGE_URL = "https://claude.ai/settings/usage"
CLAUDE_USAGE_JSON_KEY = "claude_output_json"
CLAUDE_HEALTH_JSON_KEY = "claude_health_json"
DEFAULT_CLAUDE_USAGE_JSON = "data/claude-usage.json"
DEFAULT_CLAUDE_HEALTH_JSON = "data/claude-health.json"


def claude_cdp_settings(config: dict[str, Any]) -> dict[str, Any]:
    providers = config.get("providers") or {}
    claude = providers.get("claude") or {}
    raw = claude.get("cdp") or {}
    return {
        "host": str(raw.get("host", "127.0.0.1")),
        "port": int(raw.get("port", 9223)),
        "profile_dir": str(raw.get("profile_dir", raw.get("profileDir", "runtime/claude-cdp-profile"))),
        "usage_url": str(raw.get("usage_url", raw.get("usageUrl", DEFAULT_CLAUDE_USAGE_URL))),
        "capture_wait_seconds": max(5, int(raw.get("capture_wait_seconds", raw.get("captureWaitSeconds", 20)))),
    }


def _targets(host: str, port: int) -> list[dict[str, Any]]:
    try:
        with urlopen(f"http://{host}:{port}/json", timeout=3) as response:
            result = json.loads(response.read().decode("utf-8"))
    except OSError as exc:
        raise ClaudeCdpUnavailableError(
            "Nao foi possivel acessar a porta CDP do Claude. Execute scripts/start_cdp_claude_edge.ps1 e faca login."
        ) from exc
    return result if isinstance(result, list) else []


def _select_target(targets: list[dict[str, Any]], usage_url: str) -> dict[str, Any]:
    expected = urlparse(usage_url)
    origin = f"{expected.scheme}://{expected.netloc}"
    pages = [target for target in targets if target.get("type") == "page"]
    for target in pages:
        url = str(target.get("url", ""))
        if url.startswith(f"{origin}/settings"):
            return target
    for target in pages:
        if str(target.get("url", "")).startswith(origin):
            return target
    raise ClaudeCdpUnavailableError("A aba de uso do claude.ai nao esta aberta no navegador CDP dedicado.")


def _interesting_response(url: str) -> bool:
    parsed = urlparse(url)
    if "claude.ai" not in parsed.netloc:
        return False
    path = parsed.path.lower()
    return "/api/" in path and any(term in path for term in ("usage", "rate_limit", "rate-limits", "limits", "quota"))


def _health(config: dict[str, Any], status: str, message: str | None, mode: str | None = None) -> dict[str, Any]:
    timezone_name = config.get("timezone", "America/Sao_Paulo")
    return {
        "schema_version": 1,
        "provider": "claude",
        "status": status,
        "checked_at": now_iso(timezone_name),
        "last_success_at": now_iso(timezone_name) if status == "ok" else None,
        "last_extraction_mode": mode,
        "consecutive_failures": 0 if status == "ok" else 1,
        "message": message,
    }


def _safe_failure_message(exc: Exception) -> str:
    if isinstance(exc, ClaudeCdpUnavailableError):
        return (
            "Nao foi possivel concluir a coleta CDP do Claude. Verifique se o navegador "
            "dedicado esta aberto e se a pagina de uso do claude.ai permanece disponivel."
        )
    return "Falha inesperada durante a coleta CDP do Claude. Tente novamente."


def record_unhandled_failure(config: dict[str, Any], exc: Exception) -> str:
    message = _safe_failure_message(exc)
    health_path = resolve_path(config, CLAUDE_HEALTH_JSON_KEY, DEFAULT_CLAUDE_HEALTH_JSON)
    previous = read_json(health_path, {}) or {}
    failure = _health(config, "error", message)
    # A falha atual não pode apagar o marco da última coleta verificável.
    failure["last_success_at"] = previous.get("last_success_at")
    failure["consecutive_failures"] = int(previous.get("consecutive_failures") or 0) + 1
    failure["last_extraction_mode"] = previous.get("last_extraction_mode")
    atomic_write_json(health_path, failure)
    return message


def collect_claude_from_open_tab(config: dict[str, Any], logger: logging.Logger, *, reload_page: bool = True) -> dict[str, Any]:
    from .cdp_monitor import CdpClient

    settings = claude_cdp_settings(config)
    timezone_name = config.get("timezone", "America/Sao_Paulo")
    target = _select_target(_targets(settings["host"], settings["port"]), settings["usage_url"])
    socket = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=5)
    client = CdpClient(socket)
    candidates: dict[str, str] = {}
    payloads: list[dict[str, Any]] = []
    try:
        client.command("Page.enable")
        client.command("Network.enable")
        client.command("Runtime.enable")
        if reload_page:
            client.command("Page.reload", {"ignoreCache": True})

        deadline = time.monotonic() + settings["capture_wait_seconds"]
        while time.monotonic() < deadline:
            client.socket.settimeout(max(0.2, deadline - time.monotonic()))
            try:
                event = client.next_event()
            except (websocket.WebSocketTimeoutException, TimeoutError):
                break
            method = event.get("method")
            params = event.get("params") or {}
            if method == "Network.responseReceived":
                response = params.get("response") or {}
                url = str(response.get("url", ""))
                if response.get("status") == 200 and _interesting_response(url):
                    candidates[str(params.get("requestId", ""))] = url
            elif method == "Network.loadingFinished":
                request_id = str(params.get("requestId", ""))
                if request_id in candidates:
                    try:
                        body = client.command("Network.getResponseBody", {"requestId": request_id}).get("body", "")
                        decoded = json.loads(body)
                        if isinstance(decoded, dict):
                            payloads.append(decoded)
                    except (ValueError, RuntimeError):
                        pass

        result = None
        for payload in reversed(payloads):
            try:
                result = parse_claude_network_payload(payload, timezone_name, "cdp_network_observed")
                logger.info("Coleta Claude concluida por resposta observada.")
                break
            except ValueError:
                continue

        body = _body_text(client)
        page_url = str(_page_url(client) or target.get("url", ""))
        output_path = resolve_path(config, CLAUDE_USAGE_JSON_KEY, DEFAULT_CLAUDE_USAGE_JSON)
        health_path = resolve_path(config, CLAUDE_HEALTH_JSON_KEY, DEFAULT_CLAUDE_HEALTH_JSON)

        if result is None:
            parsed_dom = parse_claude_dom_text(body, timezone_name)
            if parsed_dom.get("status") == "ok":
                result = parsed_dom
                result["extraction_mode"] = "cdp_dom_fallback"
                logger.info("Coleta Claude concluida pelo DOM.")

        if result is None:
            state = detect_claude_page_state(body, page_url)
            if state == "human_verification_required":
                message = "O navegador do Claude exige verificacao humana."
            elif state == "login_required":
                message = "A sessao do claude.ai expirou. Faca login novamente no navegador dedicado."
            else:
                state = "error"
                message = "Nenhum dado de uso do Claude foi encontrado na aba aberta."
            atomic_write_json(health_path, _health(config, state, message))
            raise RuntimeError(message)

        result.update({"collected_at": now_iso(timezone_name), "source_url": page_url})
        atomic_write_json(output_path, result)
        atomic_write_json(health_path, _health(config, "ok", None, result.get("extraction_mode")))
        return result
    finally:
        client.close()


def _body_text(client: Any) -> str:
    result = client.command(
        "Runtime.evaluate",
        {"expression": "document.body ? document.body.innerText : ''", "returnByValue": True},
    )
    value = ((result.get("result") or {}).get("value"))
    return value if isinstance(value, str) else ""


def _page_url(client: Any) -> str | None:
    try:
        result = client.command(
            "Runtime.evaluate",
            {"expression": "location.href", "returnByValue": True},
        )
    except RuntimeError:
        return None
    value = ((result.get("result") or {}).get("value"))
    return value if isinstance(value, str) else None


def main() -> int:
    parser = argparse.ArgumentParser(description="Monitora a pagina de uso do claude.ai pelo CDP local dedicado.")
    parser.add_argument("--no-reload", action="store_true", help="Le somente o estado atual da aba.")
    args = parser.parse_args()
    config = load_config()
    logger = configure_logging(resolve_path(config, "log_file", "logs/collector.log"))
    health_path = resolve_path(config, CLAUDE_HEALTH_JSON_KEY, DEFAULT_CLAUDE_HEALTH_JSON)
    health_before = read_json(health_path, {})
    try:
        print(json.dumps(collect_claude_from_open_tab(config, logger, reload_page=not args.no_reload), ensure_ascii=False, indent=2))
    except Exception as exc:
        health_after = read_json(health_path, {})
        if health_after == health_before:
            message = record_unhandled_failure(config, exc)
        else:
            message = str(health_after.get("message") or _safe_failure_message(exc))
        print(f"Falha no monitor Claude: {message}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
