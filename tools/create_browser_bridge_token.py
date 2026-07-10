from __future__ import annotations

import argparse
import secrets

from codex_usage.config import load_config, resolve_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Cria o token local da extensao do navegador.")
    parser.add_argument("--rotate", action="store_true", help="Substitui um token existente.")
    args = parser.parse_args()

    config = load_config()
    token_path = resolve_path(config, "browser_bridge_token_file", "runtime/browser-bridge-token.txt")
    if token_path.exists() and not args.rotate:
        token = token_path.read_text(encoding="utf-8").strip()
    else:
        token_path.parent.mkdir(parents=True, exist_ok=True)
        token = secrets.token_urlsafe(32)
        token_path.write_text(f"{token}\n", encoding="utf-8", newline="\n")

    print("Cole este token nas Opcoes da extensao, no campo Token da ponte local:")
    print(token)
    print(f"Arquivo local: {token_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
