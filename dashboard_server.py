from __future__ import annotations

import argparse
import hmac
import json
import subprocess
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from codex_usage.config import BASE_DIR, load_config, resolve_path
from codex_usage.ingest import normalize_browser_payload
from codex_usage.storage import atomic_write_json, read_json
from codex_usage.timeutils import now_iso

WEB_DIR = BASE_DIR / "web"
COLLECTOR_SCRIPT = BASE_DIR / "rpa_codex_usage_edge.py"


class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "CodexUsageDashboard/2.0"

    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    @property
    def app_config(self):
        return self.server.app_config

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _browser_bridge_token(self) -> str:
        path = resolve_path(
            self.app_config,
            "browser_bridge_token_file",
            "runtime/browser-bridge-token.txt",
        )
        try:
            return path.read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    def _ingest_browser_usage(self):
        token = self._browser_bridge_token()
        received_token = self.headers.get("X-Codex-Usage-Token", "")
        if not token:
            self._send_json(
                {"error": "Token da ponte local ausente. Execute scripts/create_browser_bridge_token.ps1."},
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        if not hmac.compare_digest(token, received_token):
            self._send_json({"error": "Token da ponte local invalido."}, HTTPStatus.UNAUTHORIZED)
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if not 0 < content_length <= 32_768:
                raise ValueError("Tamanho do corpo invalido.")
            body = self.rfile.read(content_length)
            payload = json.loads(body.decode("utf-8"))
            usage = normalize_browser_payload(payload, self.app_config.get("timezone", "America/Sao_Paulo"))
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            self._send_json({"error": f"Payload invalido: {exc}"}, HTTPStatus.BAD_REQUEST)
            return

        usage_path = resolve_path(self.app_config, "output_json", "data/codex-usage.json")
        health_path = resolve_path(self.app_config, "health_json", "data/collector-health.json")
        checked_at = now_iso(self.app_config.get("timezone", "America/Sao_Paulo"))
        atomic_write_json(usage_path, usage)
        atomic_write_json(
            health_path,
            {
                "schema_version": 1,
                "status": "ok",
                "checked_at": checked_at,
                "last_success_at": checked_at,
                "last_extraction_mode": usage["extraction_mode"],
                "consecutive_failures": 0,
                "message": None,
            },
        )
        self._send_json({"status": "ok", "collected_at": usage["collected_at"]})

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        host_header = self.headers.get("Host", "")
        return parsed.netloc == host_header and parsed.scheme in {"http", "https"}

    def do_GET(self):
        if self.path.startswith("/api/status"):
            usage = read_json(resolve_path(self.app_config, "output_json", "data/codex-usage.json"), {})
            health = read_json(resolve_path(self.app_config, "health_json", "data/collector-health.json"), {})
            dashboard = self.app_config.get("dashboard") or {}
            self._send_json({
                "usage": usage,
                "health": health,
                "settings": {
                    "stale_after_minutes": int(self.app_config.get("stale_after_minutes", 45)),
                    "auto_refresh_seconds": int(dashboard.get("auto_refresh_seconds", 60))
                }
            })
            return
        if self.path.startswith("/api/usage"):
            self._send_json(read_json(resolve_path(self.app_config, "output_json", "data/codex-usage.json"), {}))
            return
        if self.path.startswith("/api/health"):
            self._send_json(read_json(resolve_path(self.app_config, "health_json", "data/collector-health.json"), {}))
            return
        super().do_GET()

    def do_POST(self):
        if self.path.rstrip("/") == "/api/ingest":
            self._ingest_browser_usage()
            return
        if self.path.rstrip("/") != "/api/refresh":
            self._send_json({"error": "Rota não encontrada"}, HTTPStatus.NOT_FOUND)
            return
        if not self._same_origin():
            self._send_json({"error": "Origin não autorizado"}, HTTPStatus.FORBIDDEN)
            return

        timeout = int(self.app_config.get("collector_timeout_seconds", 150))
        try:
            process = subprocess.run(
                [sys.executable, str(COLLECTOR_SCRIPT)],
                cwd=BASE_DIR,
                capture_output=True,
                text=True,
                timeout=timeout,
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.TimeoutExpired:
            self._send_json({"error": "A coleta excedeu o tempo limite."}, HTTPStatus.GATEWAY_TIMEOUT)
            return

        usage = read_json(resolve_path(self.app_config, "output_json", "data/codex-usage.json"), {})
        health = read_json(resolve_path(self.app_config, "health_json", "data/collector-health.json"), {})
        payload = {
            "return_code": process.returncode,
            "usage": usage,
            "health": health,
            "message": (process.stderr or process.stdout or "").strip()[-1000:],
        }
        status = HTTPStatus.OK if process.returncode == 0 else HTTPStatus.CONFLICT
        self._send_json(payload, status)


def main() -> int:
    config = load_config()
    dashboard = config.get("dashboard") or {}

    parser = argparse.ArgumentParser(description="Servidor local do painel Codex Usage Reset.")
    parser.add_argument("--host", default=dashboard.get("host", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(dashboard.get("port", 8088)))
    parser.add_argument("--open", action="store_true", help="Abre o painel no navegador padrão.")
    args = parser.parse_args()

    loopback_hosts = {"127.0.0.1", "localhost", "::1"}
    if args.host not in loopback_hosts and not dashboard.get("allow_remote", False):
        print("Por segurança, o dashboard só pode escutar em loopback. Ajuste dashboard.allow_remote conscientemente.")
        return 2

    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    server.app_config = config
    url_host = "localhost" if args.host in {"0.0.0.0", "::"} else args.host
    url = f"http://{url_host}:{args.port}"

    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    print(f"Painel disponível em {url}")
    print("Pressione Ctrl+C para encerrar.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
