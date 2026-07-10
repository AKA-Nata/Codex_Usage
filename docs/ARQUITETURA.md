# Arquitetura

O projeto tem um unico fluxo de coleta:

```text
Edge dedicado com CDP -> codex_usage.cdp_monitor -> JSON local -> painel HTTP
```

## Componentes

- `scripts/start_cdp_edge.ps1`: inicia o Edge com perfil separado e CDP em
  `127.0.0.1`.
- `codex_usage/cdp_monitor.py`: encontra a aba de Analytics, observa respostas
  de rede e usa o DOM como fallback.
- `codex_usage/parsers.py`: normaliza os limites de 5 horas e semanal.
- `codex_usage/storage.py`: grava JSON de forma atomica.
- `dashboard_server.py`: entrega o painel e as rotas locais `GET /api/status`,
  `GET /api/usage`, `GET /api/health` e `POST /api/refresh`.
- `web/index.html`: exibe os dados e solicita atualizacao manual.

O monitor preserva o ultimo resultado valido quando uma tentativa falha e grava
o estado da tentativa em `data/collector-health.json`.
