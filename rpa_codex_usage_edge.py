from __future__ import annotations

import argparse
import json
import sys

from codex_usage.collector import AuthRequiredError, collect
from codex_usage.config import load_config, resolve_path
from codex_usage.locking import CollectorBusyError, FileLock
from codex_usage.logging_setup import configure_logging


def main() -> int:
    parser = argparse.ArgumentParser(description="Captura os resets de uso do Codex.")
    parser.add_argument("--login", action="store_true", help="Abre o Edge visível para login inicial.")
    parser.add_argument("--headed", action="store_true", help="Executa com navegador visível.")
    parser.add_argument("--force-dom", action="store_true", help="Ignora a rede e testa somente o fallback DOM.")
    parser.add_argument("--verbose", action="store_true", help="Ativa logs detalhados.")
    args = parser.parse_args()

    try:
        config = load_config()
        logger = configure_logging(
            resolve_path(config, "log_file", "logs/collector.log"),
            verbose=args.verbose,
        )
        lock_path = resolve_path(config, "lock_file", "runtime/collector.lock")
        with FileLock(lock_path, int(config.get("lock_stale_seconds", 300))):
            result = collect(
                config,
                logger,
                headless=not (args.login or args.headed),
                login_mode=args.login,
                force_dom=args.force_dom,
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except CollectorBusyError as exc:
        print(str(exc), file=sys.stderr)
        return 4
    except AuthRequiredError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("Execução cancelada pelo usuário.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"Falha na coleta: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
