from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from .config import resolve_path
from .parsers import parse_dom_text, parse_network_payload
from .storage import atomic_write_json, read_json
from .timeutils import now_iso


class AuthRequiredError(RuntimeError):
    pass


class ExtractionError(RuntimeError):
    pass


def _page_fetch_json(page, endpoint: str) -> dict[str, Any]:
    return page.evaluate(
        """
        async (endpoint) => {
          const response = await fetch(endpoint, {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            headers: {"accept": "application/json"}
          });
          const text = await response.text();
          let data = null;
          try { data = JSON.parse(text); } catch (_) {}
          return {
            ok: response.ok,
            status: response.status,
            url: response.url,
            contentType: response.headers.get("content-type"),
            data: data
          };
        }
        """,
        endpoint,
    )


def _launch_context(playwright, config: dict[str, Any], headless: bool):
    profile_dir = resolve_path(config, "profile_dir", "runtime/edge-profile")
    profile_dir.mkdir(parents=True, exist_ok=True)

    kwargs = {
        "user_data_dir": str(profile_dir),
        "headless": headless,
        "viewport": {"width": 1440, "height": 950},
        "locale": "pt-BR",
        "timezone_id": config.get("timezone", "America/Sao_Paulo"),
        "accept_downloads": False,
    }

    channel = config.get("browser_channel", "msedge")
    try:
        return playwright.chromium.launch_persistent_context(channel=channel, **kwargs)
    except PlaywrightError:
        if not config.get("fallback_to_chromium", True):
            raise
        return playwright.chromium.launch_persistent_context(**kwargs)


def _is_usage_url(url: str, endpoints: list[str]) -> bool:
    parsed = urlparse(url)
    path = parsed.path.rstrip("/")
    return any(path == endpoint.rstrip("/") for endpoint in endpoints)


def _looks_unauthenticated(page) -> bool:
    current = page.url.lower()
    if any(token in current for token in ["auth.openai.com", "/auth/", "/login"]):
        return True

    try:
        analytics = page.get_by_role("heading", name="Analítica do Codex", exact=True).count() > 0
    except Exception:
        analytics = False

    if analytics:
        return False

    try:
        body = page.locator("body").inner_text(timeout=3000).lower()
    except Exception:
        return False

    auth_terms = ["entrar", "fazer login", "log in", "sign in", "criar conta", "sign up"]
    return any(term in body for term in auth_terms) and "analítica do codex" not in body


def _wait_for_observed_payload(page, observed: list[dict[str, Any]], timeout_ms: int) -> dict[str, Any] | None:
    deadline = time.monotonic() + max(0, timeout_ms) / 1000
    while time.monotonic() < deadline:
        if observed:
            return observed[-1]
        page.wait_for_timeout(200)
    return observed[-1] if observed else None


def _extract_card_text(page, label: str) -> str | None:
    try:
        label_locator = page.get_by_text(label, exact=True).first
        label_locator.wait_for(state="visible", timeout=4000)
        article = label_locator.locator("xpath=ancestor::article[1]")
        if article.count() > 0:
            return article.inner_text(timeout=5000)
    except Exception:
        return None
    return None


def _extract_dom(page, config: dict[str, Any], logger: logging.Logger) -> dict[str, Any]:
    timeout_ms = int(config.get("dom_wait_timeout_ms", 15000))
    try:
        page.get_by_text("Limite de uso de 5 horas", exact=True).first.wait_for(
            state="visible", timeout=timeout_ms
        )
    except PlaywrightTimeoutError:
        pass

    five = _extract_card_text(page, "Limite de uso de 5 horas")
    weekly = _extract_card_text(page, "Limite de uso semanal")

    if five or weekly:
        combined = "\n".join(
            [
                "Limite de uso de 5 horas",
                five or "",
                "Limite de uso semanal",
                weekly or "",
            ]
        )
        try:
            body = page.locator("body").inner_text(timeout=5000)
            if "Limite de uso atingido" in body or "Você atingiu o limite" in body:
                combined += "\nLimite de uso atingido"
        except Exception:
            pass
    else:
        combined = page.locator("body").inner_text(timeout=15000)

    parsed = parse_dom_text(combined, config.get("timezone", "America/Sao_Paulo"))
    if parsed.get("status") != "ok":
        logger.warning("Fallback DOM não encontrou os dois cards esperados.")
        raise ExtractionError("Não foi possível extrair os resets pela rede nem pelo DOM.")
    return parsed


def _redact_text(value: str) -> str:
    value = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[EMAIL_REMOVIDO]", value)
    value = re.sub(r"user-[A-Za-z0-9_-]+", "user-[REMOVIDO]", value)
    return value


def _cleanup_debug(debug_dir: Path, keep_sets: int) -> None:
    if not debug_dir.exists():
        return
    files = sorted(
        [path for path in debug_dir.iterdir() if path.is_file()],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    # Cada conjunto atual possui no máximo dois arquivos.
    for path in files[max(2, keep_sets * 2):]:
        try:
            path.unlink()
        except OSError:
            pass


def _save_debug(page, config: dict[str, Any], suffix: str, logger: logging.Logger) -> None:
    debug_dir = resolve_path(config, "debug_dir", "runtime/debug")
    debug_dir.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%d_%H%M%S")

    try:
        page.screenshot(path=str(debug_dir / f"{timestamp}_{suffix}.png"), full_page=True)
    except Exception as exc:
        logger.debug("Falha ao salvar screenshot: %s", exc)

    try:
        body = page.locator("body").inner_text(timeout=5000)
        (debug_dir / f"{timestamp}_{suffix}.txt").write_text(
            _redact_text(body), encoding="utf-8"
        )
    except Exception as exc:
        logger.debug("Falha ao salvar texto de debug: %s", exc)

    _cleanup_debug(debug_dir, int(config.get("debug_retention_sets", 8)))


def _make_health(
    config: dict[str, Any],
    status: str,
    message: str | None,
    previous: dict[str, Any] | None,
    extraction_mode: str | None = None,
) -> dict[str, Any]:
    previous = previous or {}
    success = status == "ok"
    neutral = status == "login_completed"
    checked_at = now_iso(config.get("timezone", "America/Sao_Paulo"))
    return {
        "schema_version": 1,
        "status": status,
        "checked_at": checked_at,
        "last_success_at": checked_at if success else previous.get("last_success_at"),
        "last_extraction_mode": extraction_mode or previous.get("last_extraction_mode"),
        "consecutive_failures": (
            0 if success else int(previous.get("consecutive_failures", 0))
            if neutral else int(previous.get("consecutive_failures", 0)) + 1
        ),
        "message": message,
    }


def collect(
    config: dict[str, Any],
    logger: logging.Logger,
    *,
    headless: bool = True,
    login_mode: bool = False,
    force_dom: bool = False,
) -> dict[str, Any]:
    output_path = resolve_path(config, "output_json", "data/codex-usage.json")
    health_path = resolve_path(config, "health_json", "data/collector-health.json")
    previous_health = read_json(health_path, {})
    endpoints = [str(item) for item in config.get("network_endpoints", [])]
    timezone_name = config.get("timezone", "America/Sao_Paulo")

    page = None
    context = None
    with sync_playwright() as playwright:
        try:
            context = _launch_context(playwright, config, headless=headless)
            page = context.new_page()
            observed_payloads: list[dict[str, Any]] = []

            def on_response(response):
                if not _is_usage_url(response.url, endpoints) or response.status != 200:
                    return
                try:
                    payload = response.json()
                    if isinstance(payload, dict):
                        observed_payloads.append(payload)
                except Exception:
                    return

            page.on("response", on_response)
            page.goto(
                config["codex_usage_url"],
                wait_until="domcontentloaded",
                timeout=int(config.get("navigation_timeout_ms", 90000)),
            )

            if login_mode:
                print("\nEdge do RPA aberto.")
                print("Faça login e confirme que a tela Analítica do Codex carregou.")
                input("Pressione ENTER para salvar a sessão e encerrar...")
                health = _make_health(config, "login_completed", None, previous_health)
                atomic_write_json(health_path, health)
                return health

            page.wait_for_timeout(1000)
            if _looks_unauthenticated(page):
                raise AuthRequiredError(
                    "Sessão do perfil do RPA não autenticada. Execute scripts/first_login.ps1."
                )

            result: dict[str, Any] | None = None
            errors: list[str] = []

            if not force_dom:
                observed = _wait_for_observed_payload(
                    page,
                    observed_payloads,
                    int(config.get("network_capture_timeout_ms", 10000)),
                )
                if observed:
                    try:
                        result = parse_network_payload(observed, timezone_name, "network_observed")
                        logger.info("Coleta concluída usando resposta de rede observada.")
                    except Exception as exc:
                        errors.append(f"network_observed: {exc}")

                if result is None:
                    for endpoint in endpoints:
                        try:
                            response = _page_fetch_json(page, endpoint)
                            if response.get("ok") and isinstance(response.get("data"), dict):
                                result = parse_network_payload(
                                    response["data"], timezone_name, "network_fetch"
                                )
                                logger.info("Coleta concluída usando fetch autenticado: %s", endpoint)
                                break
                            errors.append(f"{endpoint}: HTTP {response.get('status')}")
                        except Exception as exc:
                            errors.append(f"{endpoint}: {exc}")

            if result is None:
                result = _extract_dom(page, config, logger)
                if errors:
                    result["network_warnings"] = errors
                logger.info("Coleta concluída usando fallback DOM.")

            collected_at = now_iso(timezone_name)
            result.update(
                {
                    "collected_at": collected_at,
                    "source_url": config["codex_usage_url"],
                }
            )
            atomic_write_json(output_path, result)
            health = _make_health(
                config,
                "ok",
                None,
                previous_health,
                extraction_mode=result.get("extraction_mode"),
            )
            atomic_write_json(health_path, health)

            if config.get("save_debug_on_success", False):
                _save_debug(page, config, "success", logger)

            return result

        except AuthRequiredError as exc:
            health = _make_health(config, "auth_required", str(exc), previous_health)
            atomic_write_json(health_path, health)
            if page is not None and config.get("save_debug_on_failure", True):
                _save_debug(page, config, "auth_required", logger)
            raise
        except Exception as exc:
            health = _make_health(config, "error", str(exc), previous_health)
            atomic_write_json(health_path, health)
            if page is not None and config.get("save_debug_on_failure", True):
                _save_debug(page, config, "error", logger)
            raise
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception:
                    pass
