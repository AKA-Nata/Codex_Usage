# Arquitetura

## Componentes

### `rpa_codex_usage_edge.py`

CLI principal. Controla lock, logging e códigos de saída.

### `codex_usage/collector.py`

Orquestra o Edge, observa respostas de rede, executa fetch autenticado e aciona o fallback DOM.

### `codex_usage/parsers.py`

Normaliza o contrato de rede e o texto visual para o mesmo modelo de saída.

### `dashboard_server.py`

Servidor HTTP local, sem dependências adicionais. Expõe:

- `GET /api/status`
- `GET /api/usage`
- `GET /api/health`
- `POST /api/refresh`

### `web/index.html`

Painel local responsivo, com atualização periódica e contagem regressiva em tempo real.

### `browser_extension/`

Extensão Manifest V3 para Edge/Chrome. O script em contexto principal observa
respostas fetch/XHR da aba de Analytics e lê seus cards como fallback. O service
worker recarrega somente a aba de Analytics em intervalo configurável (mínimo
de cinco minutos) e posta o modelo normalizado para `POST /api/ingest`. O
endpoint exige o token local em `runtime/browser-bridge-token.txt`.

### `codex_usage/cdp_monitor.py`

Alternativa sem extensao. Conecta somente a um Edge iniciado por
`scripts/start_cdp_edge.ps1`, cuja porta CDP e vinculada a `127.0.0.1` e cujo
perfil e separado. Observa respostas de rede que a propria aba recebe, le o DOM
como fallback e grava o mesmo contrato JSON usado pelo painel.

## Estratégia network-first

Durante o carregamento da página, o Playwright registra respostas cujo caminho corresponde aos itens de `network_endpoints`.

Se uma resposta válida for observada, ela recebe prioridade. Caso contrário, o coletor executa `fetch` dentro da própria página com `credentials: include`. Nenhum cookie é serializado no código.

## Estratégia de fallback

O fallback visual procura os textos exatos dos dois cards e sobe até o elemento `article`. Se o DOM mudar, ainda existe uma última tentativa baseada no texto integral da página.

## Tolerância a falhas

- JSON escrito por arquivo temporário + `os.replace`.
- Resultado anterior válido não é sobrescrito em falhas.
- Estado da tentativa separado em `collector-health.json`.
- Lock por arquivo com expiração de segurança.
- Tarefa agendada configurada para ignorar sobreposição.
- Logs com rotação de 1 MB e cinco backups.
- A extensão guarda o último payload normalizado em `chrome.storage.local` se a
  ponte local estiver temporariamente indisponível.
