# Codex Usage Monitor 4.0.1 — Python da máquina

Painel local para acompanhar os limites de uso de 5 horas e semanal do Codex,
com companheiros pixel art que circulam pela interface e interagem com relógio,
clima, uso da máquina e limites do Codex.

Esta distribuição **não cria VENV, não instala pacotes e não executa pip**.
Todos os processos utilizam exclusivamente o Python e as bibliotecas já
instalados na máquina.

## O que o painel mostra

- Percentual e horário de reset do limite de 5 horas.
- Percentual e horário de reset do limite semanal.
- Hora e data locais.
- Tempo sem interação do usuário com o painel.
- Temperatura atual da localização configurada.
- Uso de CPU, memória e disco da máquina.
- Estado do coletor CDP.

## Companheiros interativos

Os sprites são renderizados em uma camada livre e podem:

- andar pela tela;
- ser arrastados;
- visitar relógio, clima, máquina e cards do Codex;
- reagir por estado, movimento e fala às faixas de uso e ao tempo de reset;
- alertar sobre CPU, memória e disco elevados;
- sentir frio, calor e reagir à chuva;
- dormir após inatividade e acordar quando o usuário retorna;
- vigiar coleta desatualizada, com erro ou telemetria indisponível;
- falar ao serem clicados;
- trabalhar em grupos de um a três companheiros sem repetir a mesma fala.

No estúdio visual é possível escolher personagem principal, quantidade,
tamanho, velocidade e intervalo de fala. Falas, deslocamento, movimento livre e
reações contextuais podem ser ativados ou desativados separadamente.

## Requisitos

- Windows 10 ou 11;
- Microsoft Edge;
- Python 3.11 ou superior já instalado;
- bibliotecas `websocket-client`, `psutil` e `tzdata` instaladas nesse Python;
- login ativo em ChatGPT/Codex;
- acesso à internet para a temperatura atual.

O `requirements.txt` é apenas informativo. O projeto não instala dependências.

## Seleção do Python

Os scripts procuram:

1. `CODEX_USAGE_PYTHON`;
2. `py -3`;
3. `python`;
4. `python3`.

Para fixar um Python específico:

```powershell
$env:CODEX_USAGE_PYTHON = "C:\Python311\python.exe"
```

Detalhes: `docs/RUNTIME_PYTHON.md`.

## Preparação

O script abaixo apenas valida o Python, as bibliotecas e os testes. Ele não
cria VENV e não altera a máquina:

```powershell
.\scripts\install.ps1
```

Também é possível validar apenas o runtime:

```powershell
.\scripts\validate_environment.ps1
```

## Inicialização

Abra o Edge dedicado:

```powershell
.\scripts\start_cdp_edge.ps1
```

Faça login nessa janela e mantenha aberta a página:

```text
https://chatgpt.com/codex/cloud/settings/analytics?locale=pt-BR
```

Em outro terminal, inicie o monitor:

```powershell
.\scripts\monitor_open_tab.ps1
```

Em outro terminal, inicie o painel:

```powershell
.\scripts\start_dashboard.ps1
```

Painel:

```text
http://127.0.0.1:8088
```

## Temperatura

A localização fica em `config.json`:

```json
"weather": {
  "enabled": true,
  "location_label": "Blumenau",
  "latitude": -26.9194,
  "longitude": -49.0661,
  "cache_seconds": 600,
  "timeout_seconds": 5
}
```

Para desativar, altere `enabled` para `false`.

## API local

- `GET /api/status`: uso do Codex, saúde do coletor e configurações.
- `GET /api/usage`: último uso válido.
- `GET /api/health`: saúde da última coleta.
- `GET /api/telemetry`: relógio, máquina e temperatura.
- `POST /api/refresh`: executa coleta CDP sob demanda.

## Scripts

- `scripts/install.ps1`: valida o ambiente e os testes; não instala nada.
- `scripts/validate_environment.ps1`: mostra Python e bibliotecas selecionados.
- `scripts/start_cdp_edge.ps1`: abre o Edge dedicado.
- `scripts/monitor_open_tab.ps1`: monitor contínuo.
- `scripts/monitor_open_tab_once.ps1`: coleta única.
- `scripts/start_dashboard.ps1`: inicia o painel.
- `scripts/diagnose.ps1`: diagnóstico do runtime, Edge e coleta.
- `scripts/test.ps1`: compilação e testes.

## Segurança

Nunca compartilhe ou versione `runtime/`, pois o perfil isolado pode conter a
sessão do navegador. A porta CDP deve permanecer limitada a `127.0.0.1`. O
painel permanece em loopback por padrão.
