from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from codex_usage.behavior_studio import (
    MAX_CONFIG_BYTES,
    BehaviorStudioService,
    StudioError,
    StudioRevisionConflict,
    StudioValidationError,
    build_macro_catalog,
)
from codex_usage.claude_cli import open_claude_code
from codex_usage.config import BASE_DIR, load_config, resolve_path
from codex_usage.character_behaviors import compose_effective_behavior_config
from codex_usage.character_packages import (
    DEFAULT_LIMITS,
    CharacterPackageError,
    CharacterPackageService,
    PackageConflictError,
    PackageInUseError,
    PackageNotFoundError,
    PackageRevisionError,
    PackageValidationError,
)
from codex_usage.providers import build_providers, providers_usage_payload
from codex_usage.storage import read_json
from codex_usage.telemetry import build_telemetry

WEB_DIR = BASE_DIR / "web"
CDP_MONITOR_COMMAND = [sys.executable, "-m", "codex_usage.cdp_monitor"]
CHARACTER_API = "/api/studio/characters/v1"
CHARACTER_CATALOG_API = "/api/characters/v1/catalog"
CHARACTER_ASSET_API = "/api/characters/v1/assets/"
PROVIDERS_API = "/api/providers"


def build_character_catalog(package_service):
    payload = package_service.catalog()
    by_id = {item["id"]: item for item in payload.get("characters", [])}
    for character_id in ("explorer", "wizard", "mechanic", "orb"):
        manifest_path = WEB_DIR / "assets" / "characters" / character_id / "character.json"
        if character_id not in by_id and manifest_path.is_file():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            by_id[character_id] = {
                "id": character_id,
                "name": manifest.get("name", character_id),
                "version": manifest.get("version"),
                "activeVersion": manifest.get("version"),
                "enabled": True,
                "source": "native",
                "native": True,
                "compatible": True,
                "versions": [manifest.get("version")],
                "manifest": manifest,
                "manifestUrl": f"/assets/characters/{character_id}/character.json",
                "assetBaseUrl": f"/assets/characters/{character_id}/",
                "states": sorted((manifest.get("states") or {}).keys()),
                "personality": manifest.get("personality"),
                "tags": manifest.get("tags", []),
                "capabilities": manifest.get("capabilities", []),
                "diagnostics": [],
            }
    for item in by_id.values():
        if item.get("source") != "native" or not item.get("assetBaseUrl"):
            version = item.get("activeVersion") or item.get("version")
            item["assetBaseUrl"] = f"{CHARACTER_ASSET_API}{item['id']}/{version}/"
            item["manifestUrl"] = f"{CHARACTER_CATALOG_API}/{item['id']}/manifest"
    return {**payload, "characters": sorted(by_id.values(), key=lambda item: (not item.get("native", False), item["id"]))}


def character_references(studio_service, character_id, _version=None, package_service=None):
    config = studio_service.read_config()["config"]
    catalog = package_service.catalog().get("characters", []) if package_service is not None else []
    character = next((item for item in catalog if item.get("id") == character_id), None)
    manifest = (character or {}).get("manifest") or {}
    tags = {str(item).strip().lower() for item in ((character or {}).get("tags") or manifest.get("tags") or [])}
    capabilities = {str(item).strip().lower() for item in ((character or {}).get("capabilities") or manifest.get("capabilities") or [])}
    personality_value = (character or {}).get("personality") or manifest.get("personality")
    if isinstance(personality_value, dict):
        personality_values = {
            str(personality_value.get(key) or "").strip().lower()
            for key in ("id", "type", "name", "label")
        } - {""}
    else:
        personality_values = {str(personality_value or "").strip().lower()} - {""}
    groups = config.get("characterGroups") or {}

    def selector_matches(selector, stack=()):
        if isinstance(selector, str):
            kind, value = ("auto", None) if selector == "auto" else ("id", selector)
        elif isinstance(selector, dict):
            kind, value = selector.get("kind"), selector.get("value")
        else:
            return False
        kind = str(kind or "auto").strip().lower()
        value = str(value or "").strip().lower()
        if kind == "id":
            return value == character_id
        if kind == "tag":
            return value in tags
        if kind == "capability":
            return value in capabilities
        if kind == "personality":
            return value in personality_values
        if kind == "group" and value and value not in stack:
            return any(selector_matches(item, (*stack, value)) for item in groups.get(value, []))
        return False

    references = []
    for index, trigger in enumerate(config.get("triggers") or []):
        if not isinstance(trigger, dict) or trigger.get("enabled") is False:
            continue
        selector = trigger.get("character") if isinstance(trigger, dict) else None
        if selector_matches(selector) or character_id in (trigger.get("characterPhrases") or {}):
            references.append({"type": "trigger", "id": trigger.get("id"), "path": f"$.triggers[{index}]"})
    return references


class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "CodexUsageDashboard/5.0.0"

    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    @property
    def app_config(self):
        return self.server.app_config

    @property
    def studio_service(self):
        return self.server.studio_service

    @property
    def character_service(self):
        return self.server.character_service

    @property
    def providers(self):
        return self.server.providers

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'")
        super().end_headers()

    def _send_json(self, payload, status=HTTPStatus.OK, *, headers=None):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status=status, headers=headers)

    def _send_bytes(self, body, content_type, *, status=HTTPStatus.OK, disposition=None, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if disposition:
            self.send_header("Content-Disposition", disposition)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _character_expected_revision(self):
        value = self.headers.get("If-Match")
        if not value:
            raise PackageRevisionError("If-Match obrigatorio para alterar personagens.")
        value = value.strip()
        if value.startswith("W/"):
            value = value[2:].strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = value[1:-1]
        if len(value) != 64 or any(character not in "0123456789abcdef" for character in value.lower()):
            raise PackageRevisionError("If-Match do registry de personagens e invalido.")
        return value.lower()

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

    def _read_package_body(self):
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise CharacterPackageError("Content-Length invalido.") from exc
        if content_length <= 0 or content_length > DEFAULT_LIMITS.archive_bytes:
            raise CharacterPackageError("Pacote vazio ou acima do limite permitido.")
        if content_type not in {"application/zip", "application/x-zip-compressed", "application/vnd.codex-character+zip"}:
            self.rfile.read(content_length)
            raise CharacterPackageError("Content-Type deve identificar um pacote ZIP.")
        body = self.rfile.read(content_length)
        if len(body) != content_length:
            raise CharacterPackageError("Pacote truncado durante o envio.")
        return body

    def _require_same_origin(self):
        if self._same_origin():
            return True
        self._discard_request_body()
        self._send_json({"error": "Origin nao autorizado"}, HTTPStatus.FORBIDDEN)
        return False

    def _discard_request_body(self):
        try:
            declared = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.close_connection = True
            return
        if declared <= 0:
            return
        remaining = min(declared, DEFAULT_LIMITS.archive_bytes)
        while remaining:
            chunk = self.rfile.read(min(64 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
        if declared > DEFAULT_LIMITS.archive_bytes or remaining:
            self.close_connection = True

    def _send_studio_error(self, exc):
        if isinstance(exc, StudioValidationError):
            self._send_json({"error": str(exc), "errors": exc.errors}, HTTPStatus.UNPROCESSABLE_ENTITY)
        elif isinstance(exc, StudioRevisionConflict):
            self._send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        elif isinstance(exc, StudioError):
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        else:
            self._send_json({"error": "Falha interna ao processar o Studio."}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _send_character_error(self, exc):
        payload = exc.as_dict() if isinstance(exc, CharacterPackageError) else {"error": "character_package_internal_error", "message": "Falha interna ao processar o pacote."}
        if isinstance(exc, PackageValidationError):
            status = HTTPStatus.UNPROCESSABLE_ENTITY
        elif isinstance(exc, PackageNotFoundError):
            status = HTTPStatus.NOT_FOUND
        elif isinstance(exc, (PackageConflictError, PackageRevisionError, PackageInUseError)):
            status = HTTPStatus.CONFLICT
        elif isinstance(exc, CharacterPackageError):
            status = HTTPStatus.BAD_REQUEST
        else:
            status = HTTPStatus.INTERNAL_SERVER_ERROR
        self._send_json(payload, status)

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
        if (path.startswith("/api/studio") or path.startswith("/api/characters") or path.startswith("/api/behaviors")) and not self._require_same_origin():
            return
        if path in {CHARACTER_CATALOG_API, CHARACTER_API}:
            try:
                payload = build_character_catalog(self.character_service)
                self._send_json(payload, headers={"ETag": f'"{payload["revision"]}"'})
            except Exception as exc:
                self._send_character_error(exc)
            return
        if path.startswith(f"{CHARACTER_CATALOG_API}/") and path.endswith("/manifest"):
            try:
                character_id = unquote(path[len(CHARACTER_CATALOG_API) + 1:-len("/manifest")].strip("/"))
                catalog_item = next(item for item in build_character_catalog(self.character_service)["characters"] if item["id"] == character_id)
                self._send_json(catalog_item["manifest"])
            except (StopIteration, CharacterPackageError):
                self._send_character_error(PackageNotFoundError("Manifesto de personagem nao encontrado."))
            return
        if path in {"/api/behaviors/v1/effective", "/api/behaviors/v1/effective/diagnostics"}:
            try:
                result = compose_effective_behavior_config(
                    self.studio_service.read_config()["config"],
                    self.character_service,
                    validate=self.studio_service.validate,
                )
                if path.endswith("/diagnostics"):
                    self._send_json({key: value for key, value in result.items() if key != "config"})
                else:
                    self._send_json(result["config"])
            except Exception as exc:
                self._send_character_error(exc)
            return
        if path.startswith(CHARACTER_ASSET_API):
            try:
                relative = path[len(CHARACTER_ASSET_API):]
                character_id, version, package_path = [unquote(part) for part in relative.split("/", 2)]
                body, content_type = self.character_service.read_file(character_id, package_path, version=version)
                self._send_bytes(body, content_type)
            except (ValueError, CharacterPackageError) as exc:
                self._send_character_error(exc if isinstance(exc, CharacterPackageError) else PackageNotFoundError("Asset de personagem invalido."))
            return
        if path.startswith(f"{CHARACTER_API}/") and path.endswith("/export"):
            try:
                character_id = unquote(path[len(CHARACTER_API) + 1:-len("/export")].strip("/"))
                version = (parse_qs(parsed.query).get("version") or [None])[0]
                body = self.character_service.export_package(character_id, version=version)
                self._send_bytes(body, "application/vnd.codex-character+zip", disposition=f'attachment; filename="{character_id}-{version or "current"}.codex-character.zip"')
            except Exception as exc:
                self._send_character_error(exc)
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
                claude_usage = read_json(resolve_path(self.app_config, "claude_output_json", "data/claude-usage.json"), {})
                claude_health = read_json(resolve_path(self.app_config, "claude_health_json", "data/claude-health.json"), {})
                telemetry = build_telemetry(self.app_config)
                self._send_json({"macros": build_macro_catalog(
                    config,
                    usage=usage,
                    health=health,
                    telemetry=telemetry,
                    claude_usage=claude_usage,
                    claude_health=claude_health,
                )})
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
        if path == PROVIDERS_API:
            self._send_json({
                "schema_version": 1,
                "providers": [provider.describe() for provider in self.providers.values()],
            })
            return
        if path == f"{PROVIDERS_API}/usage":
            self._send_json(providers_usage_payload(self.providers, self.app_config.get("timezone", "America/Sao_Paulo")))
            return
        if path.startswith(f"{PROVIDERS_API}/") and path.endswith("/status"):
            provider_id = unquote(path[len(PROVIDERS_API) + 1:-len("/status")].strip("/"))
            provider = self.providers.get(provider_id)
            if provider is None:
                self._send_json({"error": "Provedor desconhecido"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(provider.status())
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
        if path.startswith(CHARACTER_API):
            if not self._require_same_origin():
                return
            try:
                if path == f"{CHARACTER_API}/validate":
                    self._send_json(self.character_service.validate_package(self._read_package_body()))
                    return
                if path == f"{CHARACTER_API}/install":
                    archive = self._read_package_body()
                    result = self.character_service.install_package(
                        archive,
                        expected_revision=self._character_expected_revision(),
                    )
                    self._send_json(result, HTTPStatus.CREATED)
                    return
                if path == f"{CHARACTER_API}/restore-natives":
                    self._read_json_body()
                    self._send_json(self.character_service.restore_natives(expected_revision=self._character_expected_revision()))
                    return
                relative = path[len(CHARACTER_API):].strip("/")
                if relative.startswith("bundled/") and relative.endswith("/install"):
                    character_id = unquote(relative[len("bundled/"):-len("/install")].strip("/"))
                    self._read_json_body()
                    self._send_json(self.character_service.install_bundled(character_id, expected_revision=self._character_expected_revision()), HTTPStatus.CREATED)
                    return
                character_id, action = [unquote(part) for part in relative.split("/", 1)]
                if action == "update":
                    archive = self._read_package_body()
                    self.character_service.validate_or_raise(archive, expected_id=character_id)
                    self._send_json(self.character_service.update_package(archive, expected_revision=self._character_expected_revision()))
                    return
                payload = self._read_json_body()
                expected_revision = self._character_expected_revision()
                if action == "enable":
                    self._send_json(self.character_service.enable_package(character_id, expected_revision=expected_revision))
                elif action == "disable":
                    self._send_json(self.character_service.disable_package(character_id, expected_revision=expected_revision))
                elif action == "activate":
                    self._send_json(self.character_service.activate_package(character_id, payload.get("version"), expected_revision=expected_revision))
                elif action == "rollback":
                    self._send_json(self.character_service.rollback_package(character_id, payload.get("version"), expected_revision=expected_revision))
                else:
                    self._send_json({"error": "Rota nao encontrada"}, HTTPStatus.NOT_FOUND)
                return
            except Exception as exc:
                self._send_character_error(exc)
            return
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

        if path.startswith(f"{PROVIDERS_API}/") and path.endswith("/refresh"):
            if not self._same_origin(loopback_only=False):
                self._send_json({"error": "Origin nao autorizado"}, HTTPStatus.FORBIDDEN)
                return
            provider_id = unquote(path[len(PROVIDERS_API) + 1:-len("/refresh")].strip("/"))
            provider = self.providers.get(provider_id)
            if provider is None:
                self._send_json({"error": "Provedor desconhecido"}, HTTPStatus.NOT_FOUND)
                return
            result = provider.refresh()
            self._send_json(result, HTTPStatus.OK if result.get("ok") else HTTPStatus.CONFLICT)
            return

        if path == "/api/actions/open-claude-code":
            # Acao fixa da allowlist local: nenhum comando ou argumento vem do
            # navegador; o executavel e resolvido exclusivamente no servidor.
            if not self._require_same_origin():
                return
            self._discard_request_body()
            claude = self.providers.get("claude")
            probe = claude.run_cli_probe() if claude is not None and claude.enabled else {}
            cli_path = probe.get("path") if probe.get("found") else None
            if not cli_path:
                self._send_json(
                    {"ok": False, "error": "CLI do Claude Code não detectada nesta máquina."},
                    HTTPStatus.CONFLICT,
                )
                return
            try:
                open_claude_code(cli_path)
            except OSError:
                self._send_json({"ok": False, "error": "Falha ao iniciar o Claude Code."}, HTTPStatus.INTERNAL_SERVER_ERROR)
                return
            self._send_json({"ok": True, "message": "Claude Code iniciado em um novo terminal."})
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
        if path.startswith(f"{CHARACTER_API}/"):
            if not self._require_same_origin():
                return
            try:
                character_id = unquote(path[len(CHARACTER_API):].strip("/"))
                archive = self._read_package_body()
                self.character_service.validate_or_raise(archive, expected_id=character_id)
                self._send_json(self.character_service.update_package(archive, expected_revision=self._character_expected_revision()))
            except Exception as exc:
                self._send_character_error(exc)
            return
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
        if path.startswith(f"{CHARACTER_API}/"):
            if not self._require_same_origin():
                return
            try:
                parsed = urlparse(self.path)
                character_id = unquote(path[len(CHARACTER_API):].strip("/"))
                version = (parse_qs(parsed.query).get("version") or [None])[0]
                self._send_json(self.character_service.uninstall_package(
                    character_id,
                    version=version,
                    expected_revision=self._character_expected_revision(),
                ))
            except Exception as exc:
                self._send_character_error(exc)
            return
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
    parser.add_argument("--character-registry-root", default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()

    loopback_hosts = {"127.0.0.1", "localhost", "::1"}
    if args.host not in loopback_hosts and not dashboard.get("allow_remote", False):
        print("Por seguranca, o dashboard so pode escutar em loopback.")
        return 2

    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    server.app_config = config
    server.providers = build_providers(config)
    server.studio_service = BehaviorStudioService()
    server.character_service = CharacterPackageService(
        **({"registry_root": args.character_registry_root} if args.character_registry_root else {}),
    )
    server.character_service.reference_checker = lambda character_id, version=None: character_references(
        server.studio_service,
        character_id,
        version,
        server.character_service,
    )
    server.character_service.restore_natives(reset_state=False)
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
