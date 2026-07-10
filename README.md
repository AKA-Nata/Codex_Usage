# Codex Usage Reset RPA — v2

RPA local para consultar automaticamente os dois limites exibidos na tela de Analítica do Codex:

- Limite de uso de 5 horas
- Limite de uso semanal

O pacote não coleta saldo de créditos, não armazena senha e não copia cookies ou tokens do HAR para o código.

## Fluxo de coleta

A coleta segue três níveis:

1. **Network observado**: escuta a resposta que a própria página recebe de `/backend-api/wham/usage`.
2. **Network fetch**: se a página não disparar a chamada observável, executa um `fetch` autenticado dentro do Edge já logado.
3. **Fallback DOM**: se o contrato de rede mudar ou falhar, lê os cards visíveis da página, sem OCR.

O JSON válido anterior é preservado quando uma coleta falha. O erro fica separado em `data/collector-health.json`.

## Melhorias da versão 2

- Captura da chamada real da página antes do fetch direto.
- Classificação das janelas por duração: 18.000 segundos e 604.800 segundos.
- Fallback DOM por card, com fallback adicional pelo texto da página.
- Detecção de sessão expirada.
- Escrita atômica dos JSONs para evitar leitura parcial pelo painel.
- Preservação do último resultado válido em falhas.
- Lock contra execuções simultâneas.
- Log rotativo.
- Limpeza automática dos artefatos de debug antigos.
- Painel local com contagem regressiva em tempo real.
- Botão **Atualizar agora** no painel.
- Servidor local restrito a `127.0.0.1` por padrão.
- Agendamento com política `IgnoreNew`, evitando sobreposição.
- Testes unitários do contrato de rede e do fallback visual.

## Requisitos

- Windows 10 ou 11
- Microsoft Edge instalado
- Python 3.11 ou superior
- Acesso autenticado ao Codex pelo plano ChatGPT

## Início rápido

Extraia a pasta e abra o PowerShell nela.

```powershell
.\scripts\quick_start.ps1
```

O processo:

1. Cria `.venv`.
2. Instala Playwright.
3. Abre um Edge exclusivo do RPA para o login inicial.
4. Executa a primeira coleta.
5. Abre o painel local.

Também existe:

```bat
scripts\quick_start.bat
```

## Instalação manual

```powershell
.\scripts\install.ps1
.\scripts\first_login.ps1
.\scripts\run_once.ps1
.\scripts\start_dashboard.ps1
```

Painel:

```text
http://127.0.0.1:8088
```

## Perfil do Edge

O RPA usa um perfil persistente e separado em:

```text
runtime\edge-profile
```

Não aponte o Playwright para o perfil principal utilizado diariamente. Navegadores Chromium não permitem duas instâncias concorrentes no mesmo diretório de perfil, e a automação do perfil padrão pode falhar ou encerrar o navegador.

## Execuções disponíveis

Coleta headless:

```powershell
.\scripts\run_once.ps1
```

Coleta visível para diagnóstico:

```powershell
.\scripts\run_visible.ps1
```

Teste forçado do fallback visual:

```powershell
.\scripts\test_dom_fallback.ps1
```

Testes locais:

```powershell
.\scripts\test.ps1
```

Diagnóstico:

```powershell
.\scripts\diagnose.ps1
```

## Monitor da aba aberta

Quando o Cloudflare bloquear o navegador automatizado, use a extensao local em
`browser_extension/`. Ela observa somente respostas e cards da aba de Analytics
que voce ja autenticou; nao copia cookies, senha ou headers de autorizacao. A
cada cinco minutos, ela recarrega apenas essa aba.

1. Execute `powershell -ExecutionPolicy Bypass -File .\scripts\create_browser_bridge_token.ps1` e copie o token exibido.
2. Inicie o painel com `powershell -ExecutionPolicy Bypass -File .\scripts\start_dashboard.ps1`.
3. No Edge, abra `edge://extensions`, ative **Modo de desenvolvedor**, escolha **Carregar sem compactacao** e selecione `browser_extension`.
4. Abra **Detalhes** na extensao e depois **Opcoes**; cole o token e mantenha a URL local padrao.
5. Deixe aberta e recarregue a pagina de Analytics/Usage do Codex. Os dados validos passam a aparecer em `data/codex-usage.json` e no painel.

O intervalo minimo e cinco minutos. Para o LCD, consuma o JSON gerado ou
transmita seus campos por USB serial a um ESP32/Arduino.

### Sem extensao: Edge CDP local

Se a politica da empresa bloquear extensoes, ha um caminho nativo alternativo.
Ele inicia um Edge visivel em perfil separado com uma porta de depuracao restrita
ao proprio computador. Faca login nessa janela uma unica vez e mantenha a aba de
Analytics aberta; o monitor observa as respostas que a pagina realmente recebe e
usa o DOM como fallback. Nenhum cookie ou token e exportado.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start_cdp_edge.ps1
# na janela do Edge aberta, faca login e conclua eventual desafio humano
powershell -ExecutionPolicy Bypass -File .\scripts\monitor_open_tab.ps1
```

O segundo comando permanece em execucao e recarrega a aba a cada cinco minutos.
Para uma tentativa unica, use `scripts\monitor_open_tab_once.ps1`. A porta CDP
fica limitada a `127.0.0.1`; nao a exponha na rede e nao aponte o Edge CDP para
seu perfil diario.

## Agendamento automático

A cada 15 minutos:

```powershell
.\scripts\schedule_task.ps1
```

Intervalo personalizado, por exemplo 10 minutos:

```powershell
.\scripts\schedule_task.ps1 -Minutes 10
```

Remover:

```powershell
.\scripts\unschedule_task.ps1
```

A tarefa roda somente na sessão interativa do usuário autenticado e ignora uma nova execução quando a anterior ainda está ativa.

## Arquivos gerados

### `data/codex-usage.json`

Contém apenas o resultado válido mais recente:

```json
{
  "schema_version": 2,
  "status": "ok",
  "extraction_mode": "network_observed",
  "collected_at": "2026-07-09T15:30:00-03:00",
  "limit_reached": true,
  "allowed": false,
  "resets": {
    "limite_5h": {
      "remaining_percent": 14,
      "used_percent": 86,
      "window_seconds": 18000,
      "reset_at": "2026-07-09T18:31:10-03:00"
    },
    "limite_semanal": {
      "remaining_percent": 0,
      "used_percent": 100,
      "window_seconds": 604800,
      "reset_at": "2026-07-13T15:11:31-03:00"
    }
  }
}
```

### `data/collector-health.json`

Contém o estado da última tentativa:

```json
{
  "status": "ok",
  "checked_at": "2026-07-09T15:30:00-03:00",
  "last_success_at": "2026-07-09T15:30:00-03:00",
  "last_extraction_mode": "network_observed",
  "consecutive_failures": 0,
  "message": null
}
```

Em caso de falha, o painel continua exibindo o último `codex-usage.json` válido e informa que os dados estão anteriores.

## Códigos de saída

- `0`: sucesso
- `1`: falha geral
- `2`: login necessário
- `4`: outra coleta já está em execução
- `130`: cancelado pelo usuário

## Configuração

Principais opções em `config.json`:

- `network_endpoints`: endpoints internos candidatos.
- `profile_dir`: perfil persistente do Edge do RPA.
- `network_capture_timeout_ms`: tempo para observar a chamada feita pela página.
- `dom_wait_timeout_ms`: tempo para aguardar os cards visuais.
- `save_debug_on_failure`: grava screenshot e texto quando houver falha.
- `debug_retention_sets`: número máximo aproximado de conjuntos de debug.
- `dashboard.host`: mantenha `127.0.0.1` para uso local.
- `dashboard.port`: porta do painel.

## Segurança

- Não copie headers `Authorization` do HAR.
- Não copie cookies para o código.
- Não envie `runtime/edge-profile` para Git ou para terceiros.
- Não versione arquivos `.har`.
- O endpoint `/backend-api/wham/usage` é interno e pode mudar; por isso existe fallback DOM.
- O painel é restrito ao loopback por padrão.

Mais detalhes em `docs/SEGURANCA.md` e `docs/ARQUITETURA.md`.
