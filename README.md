# Codex Usage Monitor

Monitor local dos limites de uso de 5 horas e semanal exibidos na pagina de
Analytics do Codex. O projeto usa somente uma aba do Microsoft Edge iniciada
com CDP local; nao ha extensao de navegador, Playwright ou RPA headless.

## Requisitos

- Windows 10 ou 11
- Microsoft Edge
- Python 3.11 ou superior
- Login ativo em ChatGPT/Codex

## Primeiro uso

```powershell
.\scripts\install.ps1
.\scripts\start_cdp_edge.ps1
```

Faca login na janela do Edge aberta e mantenha a pagina de Analytics aberta:

```text
https://chatgpt.com/codex/cloud/settings/analytics?locale=pt-BR
```

Em outro terminal, inicie o monitor e o painel:

```powershell
.\scripts\monitor_open_tab.ps1
.\scripts\start_dashboard.ps1
```

O monitor atualiza a aba a cada cinco minutos. Para executar apenas uma coleta:

```powershell
.\scripts\monitor_open_tab_once.ps1
```

O painel fica em `http://127.0.0.1:8088`. O botao **Atualizar agora** executa
uma coleta CDP unica.

## Como funciona

1. `start_cdp_edge.ps1` abre um perfil isolado em `runtime/edge-cdp-profile`
   com a depuracao limitada a `127.0.0.1`.
2. `cdp_monitor.py` se conecta somente a aba de Analytics desse Edge.
3. O monitor prioriza a resposta de uso recebida pela pagina e usa o texto do
   DOM como fallback.
4. O ultimo resultado valido vai para `data/codex-usage.json`; a saude da
   ultima tentativa vai para `data/collector-health.json`.

## Scripts

- `scripts/install.ps1`: cria o ambiente Python e instala dependencias.
- `scripts/start_cdp_edge.ps1`: abre o Edge dedicado ao monitor.
- `scripts/monitor_open_tab.ps1`: monitora continuamente.
- `scripts/monitor_open_tab_once.ps1`: coleta uma vez.
- `scripts/start_dashboard.ps1`: abre o painel local.
- `scripts/diagnose.ps1`: mostra diagnostico e logs recentes.
- `scripts/test.ps1`: executa compilacao e testes unitarios.

## Seguranca

Nunca compartilhe ou versione `runtime/`, pois o perfil isolado pode conter a
sessao do navegador. A porta CDP concede controle da janela autenticada e deve
permanecer limitada ao loopback. Nao exponha o painel em rede sem uma camada de
autenticacao apropriada.

Consulte [arquitetura](docs/ARQUITETURA.md), [contrato observado](docs/NETWORK_CONTRACT.md)
e [seguranca](docs/SEGURANCA.md) para detalhes.
