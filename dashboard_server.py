from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from codex_usage.config import BASE_DIR, load_config, resolve_path
from codex_usage.storage import read_json

WEB_DIR = BASE_DIR / "web"
CDP_MONITOR_COMMAND = [sys.executable, "-m", "codex_usage.cdp_monitor"]


class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "CodexUsageDashboard/3.0"

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
                    "auto_refresh_seconds": int(dashboard.get("auto_refresh_seconds", 60)),
                },
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
        if self.path.rstrip("/") != "/api/refresh":
            self._send_json({"error": "Rota nao encontrada"}, HTTPStatus.NOT_FOUND)
            return
        if not self._same_origin():
            self._send_json({"error": "Origin nao autorizado"}, HTTPStatus.FORBIDDEN)
            return

        timeout = max(30, int(self.app_config.get("cdp_monitor_timeout_seconds", 45)))
        try:
            process = subprocess.run(
                CDP_MONITOR_COMMAND,
                cwd=BASE_DIR,
                capture_output=True,
                text=True,
                timeout=timeout,
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.TimeoutExpired:
            self._send_json({"error": "A coleta CDP excedeu o tempo limite."}, HTTPStatus.GATEWAY_TIMEOUT)
            return

        usage = read_json(resolve_path(self.app_config, "output_json", "data/codex-usage.json"), {})
        health = read_json(resolve_path(self.app_config, "health_json", "data/collector-health.json"), {})
        payload = {
            "return_code": process.returncode,
            "usage": usage,
            "health": health,
            "message": (process.stderr or process.stdout or "").strip()[-1000:],
        }
        self._send_json(payload, HTTPStatus.OK if process.returncode == 0 else HTTPStatus.CONFLICT)


def main() -> int:
    config = load_config()
    dashboard = config.get("dashboard") or {}

    parser = argparse.ArgumentParser(description="Servidor local do painel de uso do Codex.")
    parser.add_argument("--host", default=dashboard.get("host", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(dashboard.get("port", 8088)))
    parser.add_argument("--open", action="store_true", help="Abre o painel no navegador padrao.")
    args = parser.parse_args()

    loopback_hosts = {"127.0.0.1", "localhost", "::1"}
    if args.host not in loopback_hosts and not dashboard.get("allow_remote", False):
        print("Por seguranca, o dashboard so pode escutar em loopback.")
        return 2

    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    server.app_config = config
    url_host = "localhost" if args.host in {"0.0.0.0", "::"} else args.host
    url = f"http://{url_host}:{args.port}"

    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    print(f"Painel disponivel em {url}")
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
