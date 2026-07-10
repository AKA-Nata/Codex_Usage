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

`web/app.js` controla cards, personalização, cronômetros e telemetria.
`web/sprite-engine.js` é um motor isolado para os companheiros pixel art.

O motor de sprites:

1. cria de um a três personagens;
2. mantém coordenadas, destino e estado de cada personagem;
3. usa `requestAnimationFrame` para movimentação;
4. localiza cards por `data-sprite-anchor`;
5. escolhe interações por prioridade e cooldown;
6. permite drag por Pointer Events;
7. respeita `prefers-reduced-motion`.

## Fluxo de dados

```text
Edge Analytics -> CDP monitor -> codex-usage.json -> /api/status -> interface
Máquina/clima -> telemetry.py -> /api/telemetry -> interface -> sprite engine
```

## Persistência

- Uso e saúde: arquivos JSON locais.
- Personalização dos sprites e tema: `localStorage` do navegador.
- Clima: cache em memória do processo do dashboard.
