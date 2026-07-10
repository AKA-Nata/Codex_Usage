from __future__ import annotations

import argparse
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse
from urllib.request import urlopen

import websocket

from .config import load_config, resolve_path
from .logging_setup import configure_logging
from .parsers import parse_dom_text, parse_network_payload
from .storage import atomic_write_json, read_json
from .timeutils import now_iso


class CdpUnavailableError(RuntimeError):
    pass


@dataclass
class CdpClient:
    socket: Any
    command_id: int = 0
    events: list[dict[str, Any]] = field(default_factory=list)

    def command(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.command_id += 1
        request_id = self.command_id
        self.socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            message = self._receive()
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(f"CDP {method}: {message['error'].get('message', 'erro desconhecido')}")
                return message.get("result") or {}
            self.events.append(message)

    def next_event(self) -> dict[str, Any]:
        if self.events:
            return self.events.pop(0)
        return self._receive()

    def _receive(self) -> dict[str, Any]:
        raw = self.socket.recv()
        if not raw:
            raise CdpUnavailableError("A conexao com o Edge foi encerrada.")
        return json.loads(raw)

    def close(self) -> None:
        self.socket.close()


def _cdp_settings(config: dict[str, Any]) -> dict[str, Any]:
    raw = config.get("cdp_monitor") or {}
    return {
        "host": str(raw.get("host", "127.0.0.1")),
        "port": int(raw.get("port", 9222)),
        "capture_wait_seconds": max(5, int(raw.get("capture_wait_seconds", 20))),
        "refresh_minutes": max(5, int(raw.get("refresh_minutes", 5))),
    }


def _targets(host: str, port: int) -> list[dict[str, Any]]:
    try:
        with urlopen(f"http://{host}:{port}/json", timeout=3) as response:
            result = json.loads(response.read().decode("utf-8"))
    except OSError as exc:
        raise CdpUnavailableError(
            "Nao foi possivel acessar a porta CDP do Edge. Execute scripts/start_cdp_edge.ps1 e faca login."
        ) from exc
    return result if isinstance(result, list) else []


def _select_target(targets: list[dict[str, Any]], usage_url: str) -> dict[str, Any]:
    expected = urlparse(usage_url)
    expected_prefix = f"{expected.scheme}://{expected.netloc}/codex/"
    pages = [target for target in targets if target.get("type") == "page"]
    for target in pages:
        if str(target.get("url", "")).startswith(expected_prefix):
            return target
    raise CdpUnavailableError("A aba de Analytics do Codex nao esta aberta no Edge CDP.")


def _interesting_response(url: str) -> bool:
    path = urlparse(url).path.lower()
    return "backend-api" in path and any(term in path for term in ("usage", "analytics", "rate", "limit", "wham"))


def _body_text(client: CdpClient) -> str:
    result = client.command(
        "Runtime.evaluate",
        {"expression": "document.body ? document.body.innerText : ''", "returnByValue": True},
    )
    value = ((result.get("result") or {}).get("value"))
    return value if isinstance(value, str) else ""


def _health(config: dict[str, Any], status: str, message: str | None, mode: str | None = None) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "status": status,
        "checked_at": now_iso(config.get("timezone", "America/Sao_Paulo")),
        "last_success_at": now_iso(config.get("timezone", "America/Sao_Paulo")) if status == "ok" else None,
        "last_extraction_mode": mode,
        "consecutive_failures": 0 if status == "ok" else 1,
        "message": message,
    }


def collect_from_open_tab(config: dict[str, Any], logger: logging.Logger, *, reload_page: bool = True) -> dict[str, Any]:
    settings = _cdp_settings(config)
    target = _select_target(_targets(settings["host"], settings["port"]), config["codex_usage_url"])
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

        for payload in reversed(payloads):
            try:
                result = parse_network_payload(payload, config["timezone"], "cdp_network_observed")
                logger.info("Coleta CDP concluida por resposta observada.")
                break
            except ValueError:
                continue
        else:
            result = None

        body = _body_text(client)
        if result is None:
            parsed_dom = parse_dom_text(body, config["timezone"])
            if parsed_dom.get("status") == "ok":
                result = parsed_dom
                result["extraction_mode"] = "cdp_dom_fallback"
                logger.info("Coleta CDP concluida pelo DOM.")

        output_path = resolve_path(config, "output_json", "data/codex-usage.json")
        health_path = resolve_path(config, "health_json", "data/collector-health.json")
        if result is None:
            challenge = "confirme que e humano" in body.lower() or "verify you are human" in body.lower()
            status = "human_verification_required" if challenge else "error"
            message = "O Edge exige verificacao humana." if challenge else "Nenhum dado de uso foi encontrado na aba aberta."
            atomic_write_json(health_path, _health(config, status, message))
            raise RuntimeError(message)

        result.update({"collected_at": now_iso(config["timezone"]), "source_url": target["url"]})
        atomic_write_json(output_path, result)
        atomic_write_json(health_path, _health(config, "ok", None, result.get("extraction_mode")))
        return result
    finally:
        client.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Monitora a aba aberta do Codex pelo CDP local.")
    parser.add_argument("--watch", action="store_true", help="Repete a coleta no intervalo configurado.")
    parser.add_argument("--no-reload", action="store_true", help="Le somente o estado atual da aba.")
    args = parser.parse_args()
    config = load_config()
    logger = configure_logging(resolve_path(config, "log_file", "logs/collector.log"))
    interval = _cdp_settings(config)["refresh_minutes"] * 60
    while True:
        try:
            print(json.dumps(collect_from_open_tab(config, logger, reload_page=not args.no_reload), ensure_ascii=False, indent=2))
        except Exception as exc:
            print(f"Falha no monitor CDP: {exc}")
            if not args.watch:
                return 1
        if not args.watch:
            return 0
        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
