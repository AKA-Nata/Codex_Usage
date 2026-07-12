# Codex Usage Monitor 4.1.1 — Python da máquina

Painel local para acompanhar os limites de uso de 5 horas e semanal do Codex,
com companheiros pixel art que circulam pela interface e reagem aos dados reais
de relógio, clima, máquina, inatividade e coleta.

Esta distribuição **não cria VENV, não instala pacotes e não executa pip**.
Todos os processos utilizam exclusivamente o Python e as bibliotecas já
instalados na máquina.

## O que o painel mostra

- Quatro cards ambientais: hora/data, interação, clima e máquina.
- Dois cards do Codex: limite de 5 horas e limite semanal, com percentual e
  reset.
- Estado do coletor e horário da última atualização, de forma discreta no
  cabeçalho.

O dashboard 4+2 elimina blocos decorativos redundantes e reserva zonas seguras
nos cards. Os sprites permanecem visualmente acima do painel, sem cobrir textos,
botões ou gráficos.

## Companheiros interativos

Os sprites são renderizados em uma camada livre e podem:

- andar pela tela;
- ser arrastados;
- visitar relógio, clima, máquina e cards do Codex;
- reagir por estado, movimento e fala às faixas de uso e ao tempo de reset;
- alertar sobre CPU, memória e disco elevados;
- usar métricas opcionais de GPU NVIDIA nas macros quando `nvidia-smi` estiver disponível;
- sentir frio, calor e reagir à chuva;
- dormir após inatividade e acordar quando o usuário retorna;
- vigiar coleta desatualizada, com erro ou telemetria indisponível;
- falar ao serem clicados;
- trabalhar em grupos de um a três companheiros sem repetir a mesma fala.

No estúdio visual é possível escolher personagem principal, quantidade,
tamanho, velocidade e intervalo de fala. Falas, deslocamento, movimento livre e
reações contextuais podem ser ativados ou desativados separadamente.

Esta entrega não adiciona novos assets bitmap. Os estados `idle`, `walk`,
`inspect`, `point`, `talk`, `happy`, `worried`, `critical`, `hot`, `cold`,
`sleep`, `wake`, `confused` e `celebrate` reutilizam os personagens atuais com
animações e efeitos CSS em passos, preservando o pixel art.

## Comportamentos declarativos

As regras ficam fora de `app.js` e podem ser revisadas sem alterar a coleta ou
o dashboard:

- `web/config/sprite-behaviors.json`: macros, cards, comportamento padrão,
  frases, gatilhos, prioridades e cooldowns;
- `web/config/sprite-behaviors.schema.json`: contrato JSON Schema usado para
  validar a configuração;
- `web/sprite-reaction-engine.js`: normalização, interpretação dos operadores,
  fila de eventos, escolha de personagem, movimento, estado e fala.

As macros `{{hora}}`, `{{data}}`, `{{tempo_sem_interacao}}`, `{{temperatura}}`,
`{{clima}}`, `{{cpu}}`, `{{ram}}`, `{{disco}}`, `{{gpu}}`,
`{{gpu_memoria}}`, `{{codex_5h_percentual}}`, `{{codex_5h_reset}}`,
`{{codex_semanal_percentual}}`, `{{codex_semanal_reset}}`,
`{{coleta_status}}` e `{{ultima_atualizacao}}` têm origem, tipo, unidade e
fallback definidos no próprio arquivo. Há também macros booleanas específicas
para os limites de 5 horas e semanal atingidos.

Os gatilhos aceitam comparações `>`, `>=`, `<`, `<=`, `==` e `between`, grupos
`all`/`any`, faixas de horário, mudanças de valor e eventos de clique, arraste,
inatividade, retorno, erro, recuperação e atualização desatualizada. Se o JSON
não puder ser carregado ou validado, o motor mantém a configuração válida
anterior; sem uma anterior, usa o conjunto legado seguro e informa o fallback
no diagnóstico do painel.

As macros de GPU são preenchidas automaticamente em máquinas NVIDIA com
`nvidia-smi` disponível. Em outros equipamentos, permanecem com o fallback
configurado, sem interromper o painel.

A inatividade do painel é a fonte prioritária para reações de sono e retorno.
O tempo ocioso do Windows continua disponível em campo separado na telemetria,
sem encurtar silenciosamente o tempo medido no painel.

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
- `scripts/package_source.ps1`: gera ZIP seguro somente com arquivos versionados.

## Segurança

Nunca compartilhe ou versione `runtime/`, pois o perfil isolado pode conter a
sessão do navegador. A porta CDP deve permanecer limitada a `127.0.0.1`. O
painel permanece em loopback por padrão.

Não compacte a raiz do projeto com `Compress-Archive`, pois isso pode incluir
`.git`, cookies, histórico e dados operacionais. Após o commit, gere a entrega
somente com arquivos versionados:

```powershell
.\scripts\package_source.ps1
```
