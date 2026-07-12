from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from codex_usage.behavior_studio import (
    MAX_CONFIG_BYTES,
    BehaviorStudioService,
    StudioError,
    StudioRevisionConflict,
    StudioValidationError,
    build_macro_catalog,
)
from codex_usage.config import BASE_DIR, load_config, resolve_path
from codex_usage.storage import read_json
from codex_usage.telemetry import build_telemetry

WEB_DIR = BASE_DIR / "web"
CDP_MONITOR_COMMAND = [sys.executable, "-m", "codex_usage.cdp_monitor"]


class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "CodexUsageDashboard/4.2.0"

    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    @property
    def app_config(self):
        return self.server.app_config

    @property
    def studio_service(self):
        return self.server.studio_service

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'")
        super().end_headers()

    def _send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status=status)

    def _send_bytes(self, body, content_type, *, status=HTTPStatus.OK, disposition=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise StudioError("Content-Type deve ser application/json.")
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise StudioError("Content-Length invalido.") from exc
        if content_length <= 0:
            raise StudioError("Corpo JSON obrigatorio.")
        if content_length > MAX_CONFIG_BYTES:
            raise StudioError("Corpo JSON excede o tamanho permitido.")
        try:
            return json.loads(
                self.rfile.read(content_length).decode("utf-8"),
                parse_constant=lambda value: (_ for _ in ()).throw(StudioError(f"Constante JSON invalida: {value}.")),
            )
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise StudioError("Corpo JSON invalido.") from exc

    def _require_same_origin(self):
        if self._same_origin():
            return True
        self._send_json({"error": "Origin nao autorizado"}, HTTPStatus.FORBIDDEN)
        return False

    def _send_studio_error(self, exc):
        if isinstance(exc, StudioValidationError):
            self._send_json({"error": str(exc), "errors": exc.errors}, HTTPStatus.UNPROCESSABLE_ENTITY)
        elif isinstance(exc, StudioRevisionConflict):
            self._send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        elif isinstance(exc, StudioError):
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        else:
            self._send_json({"error": "Falha interna ao processar o Studio."}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _same_origin(self, *, loopback_only=True) -> bool:
        host_header = self.headers.get("Host", "")
        try:
            request_host = urlparse(f"//{host_header}").hostname
        except ValueError:
            return False
        if loopback_only and request_host not in {"127.0.0.1", "localhost", "::1"}:
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        return parsed.netloc == host_header and parsed.scheme == "http"

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path.startswith("/api/studio") and not self._require_same_origin():
            return
        if path == "/api/studio/config":
            try:
                self._send_json(self.studio_service.read_config())
            except Exception as exc:
                self._send_studio_error(exc)
            return
        if path == "/api/studio/schema":
            self._send_json(self.studio_service.read_schema())
            return
        if path == "/api/studio/config/export":
            try:
                body = json.dumps(self.studio_service.export_config(), ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
                self._send_bytes(
                    body,
                    "application/json; charset=utf-8",
                    disposition='attachment; filename="sprite-behaviors.json"',
                )
            except Exception as exc:
                self._send_studio_error(exc)
            return
        if path == "/api/studio/macros":
            try:
                config = self.studio_service.read_config()["config"]
                usage = read_json(resolve_path(self.app_config, "output_json", "data/codex-usage.json"), {})
                health = read_json(resolve_path(self.app_config, "health_json", "data/collector-health.json"), {})
                telemetry = build_telemetry(self.app_config)
                self._send_json({"macros": build_macro_catalog(config, usage=usage, health=health, telemetry=telemetry)})
            except Exception as exc:
                self._send_studio_error(exc)
            return
        if path == "/api/studio/history":
            try:
                query = parse_qs(parsed.query)
                limit = int((query.get("limit") or ["200"])[0])
                search = (query.get("q") or [""])[0]
                self._send_json({"entries": self.studio_service.read_history(limit=limit, query=search)})
            except ValueError as exc:
                self._send_studio_error(StudioError(str(exc)))
            except Exception as exc:
                self._send_studio_error(exc)
            return
        if path == "/api/status":
            usage = read_json(resolve_path(self.app_config, "output_json", "data/codex-usage.json"), {})
            health = read_json(resolve_path(self.app_config, "health_json", "data/collector-health.json"), {})
            dashboard = self.app_config.get("dashboard") or {}
            self._send_json({
                "usage": usage,
                "health": health,
                "settings": {
                    "stale_after_minutes": int(self.app_config.get("stale_after_minutes", 45)),
                    "auto_refresh_seconds": int(dashboard.get("auto_refresh_seconds", 60)),
                    "telemetry_refresh_seconds": int(dashboard.get("telemetry_refresh_seconds", 5)),
                },
            })
            return
        if path == "/api/usage":
            self._send_json(read_json(resolve_path(self.app_config, "output_json", "data/codex-usage.json"), {}))
            return
        if path == "/api/health":
            self._send_json(read_json(resolve_path(self.app_config, "health_json", "data/collector-health.json"), {}))
            return
        if path == "/api/telemetry":
            self._send_json(build_telemetry(self.app_config))
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path.startswith("/api/studio"):
            if not self._require_same_origin():
                return
            try:
                payload = self._read_json_body()
                if path == "/api/studio/config/validate":
                    config = payload.get("config") if isinstance(payload, dict) and "config" in payload else payload
                    self._send_json(self.studio_service.validate(config))
                    return
                if path == "/api/studio/config/import":
                    config = payload.get("config") if isinstance(payload, dict) else None
                    revision = payload.get("expectedRevision") if isinstance(payload, dict) else None
                    if not revision:
                        raise StudioError("expectedRevision obrigatoria para importar.")
                    self._send_json(self.studio_service.import_config(config, expected_revision=revision))
                    return
                if path == "/api/studio/config/restore-default":
                    revision = payload.get("expectedRevision") if isinstance(payload, dict) else None
                    if not revision:
                        raise StudioError("expectedRevision obrigatoria para restaurar.")
                    self._send_json(self.studio_service.restore_default(expected_revision=revision))
                    return
                if path == "/api/studio/history":
                    self._send_json({"entry": self.studio_service.append_history(payload)}, HTTPStatus.CREATED)
                    return
                self._send_json({"error": "Rota nao encontrada"}, HTTPStatus.NOT_FOUND)
            except Exception as exc:
                self._send_studio_error(exc)
            return

        if path != "/api/refresh":
            self._send_json({"error": "Rota nao encontrada"}, HTTPStatus.NOT_FOUND)
            return
        if not self._same_origin(loopback_only=False):
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

    def do_PUT(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path != "/api/studio/config":
            self._send_json({"error": "Rota nao encontrada"}, HTTPStatus.NOT_FOUND)
            return
        if not self._require_same_origin():
            return
        try:
            payload = self._read_json_body()
            if not isinstance(payload, dict):
                raise StudioError("Corpo do salvamento invalido.")
            if not payload.get("expectedRevision"):
                raise StudioError("expectedRevision obrigatoria para salvar.")
            self._send_json(self.studio_service.save_config(
                payload.get("config"),
                expected_revision=payload.get("expectedRevision"),
                reason="studio-save",
            ))
        except Exception as exc:
            self._send_studio_error(exc)

    def do_DELETE(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path != "/api/studio/history":
            self._send_json({"error": "Rota nao encontrada"}, HTTPStatus.NOT_FOUND)
            return
        if not self._require_same_origin():
            return
        try:
            self._send_json({"cleared": self.studio_service.clear_history()})
        except Exception as exc:
            self._send_studio_error(exc)


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
    server.studio_service = BehaviorStudioService()
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
