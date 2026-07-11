# Arquitetura

## Componentes

### Coletor CDP

`codex_usage/cdp_monitor.py` conecta-se somente à aba de Analytics do Edge
isolado. O resultado válido é gravado atomicamente em `data/codex-usage.json`.

### Dashboard local

`dashboard_server.py` serve os arquivos de `web/` e expõe APIs locais em
loopback. O servidor também agrega telemetria leve por meio de
`codex_usage/telemetry.py`.

### Telemetria

`codex_usage/telemetry.py` fornece:

- relógio no fuso configurado;
- CPU, memória, disco e bateria via `psutil`;
- tempo ocioso do Windows por `GetLastInputInfo`;
- temperatura atual por serviço meteorológico configurado, com cache.

A interface usa `GET /api/telemetry` e atualiza os dados sem executar uma coleta
nova do Codex.

### Interface

`web/app.js` controla cards, personalização, cronômetros e telemetria e entrega
snapshots brutos ao motor. `web/sprite-reaction-engine.js` centraliza toda a
lógica dos companheiros pixel art; `web/sprite-engine.js` é apenas um reexport
de compatibilidade.

O motor de sprites:

1. normaliza uso, resets, saúde, telemetria, clima, horário e inatividade;
2. detecta mudanças relevantes e mantém uma fila com prioridades e cooldowns;
3. cria de um a três personagens e evita falas duplicadas;
4. mantém coordenadas, destino e estado de cada personagem;
5. usa `requestAnimationFrame` para movimentação e animações de estado;
6. localiza cards por `data-sprite-anchor` e evita áreas protegidas;
7. separa personagens, limita o viewport e recalcula posições em resize/scroll;
8. permite drag por Pointer Events;
9. respeita `prefers-reduced-motion` sem ocultar os personagens.

## Fluxo de dados

```text
Edge Analytics -> CDP monitor -> uso/health JSON -> /api/status -> app.js
Máquina/clima -> telemetry.py -> /api/telemetry -> app.js
Snapshots do app.js -> sprite-reaction-engine -> fila -> estado/movimento/fala
```

## Persistência

- Uso e saúde: arquivos JSON locais.
- Personalização dos sprites e tema: `localStorage` do navegador.
- Clima: cache em memória do processo do dashboard.
