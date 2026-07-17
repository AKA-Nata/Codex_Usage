"""Sondagem segura da CLI do Claude Code.

A CLI oficial (verificada na versao 2.1.212) NAO expoe janelas de uso de
forma nao interativa: nenhum subcomando devolve percentuais ou resets de
limite em formato machine-readable. Por regra do projeto, uma resposta
textual gerada pelo modelo nunca e usada como telemetria; portanto esta
estrategia informa somente disponibilidade, versao e estado de
autenticacao (via ``claude auth status --json``, que e metadado oficial
da propria CLI) e declara suporte a uso como ``unsupported``.

Seguranca: subprocessos com argv fixo (sem shell), timeout obrigatorio,
saida sanitizada e nenhum token/segredo lido, logado ou persistido.
"""

from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from .timeutils import now_iso

CLAUDE_CLI_ENV_VAR = "CLAUDE_CLI_PATH"
DEFAULT_TIMEOUT_SECONDS = 20
_VERSION_PATTERN = re.compile(r"^(\d+\.\d+\.\d+)\b")
_SENSITIVE_PATTERN = re.compile(
    r"(token|cookie|authorization|bearer|secret|password|credential|api[_-]?key|sk-[A-Za-z0-9-]+)",
    re.IGNORECASE,
)

# Campos de ``claude auth status --json`` que podem ser expostos ao painel.
# E-mail, IDs de organizacao e nomes ficam de fora por serem dados pessoais.
_AUTH_ALLOWED_FIELDS = ("loggedIn", "authMethod", "subscriptionType")

_KNOWN_LOCATION_PATTERNS = (
    "~/.local/bin/claude.exe",
    "~/.local/bin/claude",
    "~/AppData/Roaming/npm/claude.cmd",
    "~/AppData/Local/Programs/claude-code/claude.exe",
    "~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude.exe",
)


def sanitize_cli_text(text: str, limit: int = 400) -> str:
    """Remove padroes sensiveis e trunca a saida da CLI antes de expor."""

    cleaned = _SENSITIVE_PATTERN.sub("[removido]", str(text or ""))
    cleaned = " ".join(cleaned.split())
    return cleaned[:limit]


def _subprocess_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


def _run_cli(executable: str, args: list[str], timeout_seconds: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        [executable, *args],
        capture_output=True,
        text=True,
        timeout=max(1, int(timeout_seconds)),
        encoding="utf-8",
        errors="replace",
        creationflags=_subprocess_flags(),
    )


def _candidate_paths(configured_path: str | None) -> list[str]:
    candidates: list[str] = []
    if configured_path:
        candidates.append(str(configured_path))
    env_path = os.environ.get(CLAUDE_CLI_ENV_VAR)
    if env_path:
        candidates.append(env_path)
    which = shutil.which("claude")
    if which:
        candidates.append(which)
    for pattern in _KNOWN_LOCATION_PATTERNS:
        expanded = os.path.expanduser(pattern)
        if "*" in expanded:
            candidates.extend(sorted(glob.glob(expanded), reverse=True))
        elif os.path.isfile(expanded):
            candidates.append(expanded)
    unique: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized = os.path.normcase(os.path.normpath(candidate))
        if normalized not in seen:
            seen.add(normalized)
            unique.append(candidate)
    return unique


def detect_claude_cli(configured_path: str | None = None, timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any] | None:
    """Localiza a CLI e confirma a identidade via ``--version``.

    Retorna ``{"path": ..., "version": ...}`` ou ``None`` quando nenhuma
    instalacao confiavel e encontrada.
    """

    for candidate in _candidate_paths(configured_path):
        if not os.path.isfile(candidate):
            continue
        try:
            process = _run_cli(candidate, ["--version"], timeout_seconds)
        except (OSError, subprocess.TimeoutExpired, subprocess.SubprocessError):
            continue
        if process.returncode != 0:
            continue
        output = (process.stdout or "").strip()
        match = _VERSION_PATTERN.match(output)
        if match and "claude" in output.lower():
            return {"path": candidate, "version": match.group(1)}
    return None


def read_auth_status(executable: str, timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Executa ``claude auth status --json`` e filtra campos permitidos."""

    try:
        process = _run_cli(executable, ["auth", "status", "--json"], timeout_seconds)
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "message": "A consulta de autenticação excedeu o tempo limite."}
    except (OSError, subprocess.SubprocessError):
        return {"status": "error", "message": "Não foi possível executar a CLI do Claude."}

    if process.returncode != 0:
        return {
            "status": "error",
            "message": sanitize_cli_text(process.stderr or process.stdout or "Falha ao consultar a autenticação."),
        }
    try:
        payload = json.loads(process.stdout or "{}")
    except json.JSONDecodeError:
        return {"status": "invalid_output", "message": "A CLI devolveu uma saída não reconhecida."}
    if not isinstance(payload, dict):
        return {"status": "invalid_output", "message": "A CLI devolveu uma saída não reconhecida."}
    result: dict[str, Any] = {"status": "ok"}
    for field in _AUTH_ALLOWED_FIELDS:
        if field in payload:
            value = payload[field]
            if isinstance(value, (str, bool)) and (not isinstance(value, str) or len(value) <= 64):
                result[field] = value
    return result


def probe_claude_cli(
    configured_path: str | None = None,
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    timezone_name: str = "America/Sao_Paulo",
) -> dict[str, Any]:
    """Sonda completa da estrategia CLI.

    O resultado declara explicitamente ``usage_supported: False`` — a CLI
    instalada nao publica limites de uso verificaveis; nenhum valor de uso
    e inventado a partir dela.
    """

    detected = detect_claude_cli(configured_path, timeout_seconds)
    probe: dict[str, Any] = {
        "strategy": "cli",
        "checked_at": now_iso(timezone_name),
        "found": detected is not None,
        "usage_supported": False,
        "usage_support_reason": (
            "A CLI do Claude Code não expõe janelas de uso em formato "
            "machine-readable; respostas do modelo não são aceitas como telemetria."
        ),
    }
    if not detected:
        probe["message"] = "CLI do Claude Code não encontrada nesta máquina."
        return probe
    probe["path"] = detected["path"]
    probe["version"] = detected["version"]
    probe["auth"] = read_auth_status(detected["path"], timeout_seconds)
    return probe


def open_claude_code(executable: str, cwd: Path | None = None) -> subprocess.Popen:
    """Abre o Claude Code em um novo terminal local (acao fixa, sem argumentos).

    Usada pela allowlist de acoes do dashboard; o caminho vem exclusivamente
    da deteccao no servidor — o navegador nunca fornece comando ou argumento.
    """

    working_dir = str(cwd or Path.home())
    if sys.platform == "win32":
        return subprocess.Popen(
            [executable],
            cwd=working_dir,
            creationflags=subprocess.CREATE_NEW_CONSOLE,
            close_fds=True,
        )
    return subprocess.Popen(  # pragma: no cover - fluxo fora do alvo Windows
        [executable],
        cwd=working_dir,
        start_new_session=True,
        close_fds=True,
    )
