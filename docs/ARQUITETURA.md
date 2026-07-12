# Arquitetura

## Componentes

### Coletor CDP

`codex_usage/cdp_monitor.py` conecta-se somente à aba de Analytics do Edge
isolado. O resultado válido é gravado atomicamente em `data/codex-usage.json`.

### Dashboard local

`dashboard_server.py` serve os arquivos de `web/` e expõe APIs locais em
loopback. O servidor também agrega telemetria leve por meio de
`codex_usage/telemetry.py`.

`codex_usage/behavior_studio.py` é a autoridade de persistência do Studio. O
módulo lê o schema oficial sem resolver referências externas, valida seu
subconjunto Draft 2020-12, aplica verificações semânticas, controla revisão e
lock, cria backups e grava o JSON oficial atomicamente. O histórico e os backups
ficam em `runtime/behavior-studio`; a referência padrão restaurável é versionada
em `web/config/sprite-behaviors.default.json`.

A interface foi reduzida ao conteúdo operacional: quatro cards ambientais
(`hora`, `interação`, `clima` e `máquina`) e dois cards de consumo (`Codex 5h`
e `Codex semanal`). A saúde da coleta e a última atualização ficam no
cabeçalho. Cada card reserva uma `data-sprite-safe-zone`, permitindo que os
personagens permaneçam acima da interface sem ocultar conteúdo útil.

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

`web/behavior-studio.js` controla o overlay de seis abas;
`web/behavior-studio-model.js` concentra CRUD, composição de condições,
validação de fala e simulação como funções puras testáveis. O simulador avalia
uma cópia do contexto e só chama `playTemporary` quando o usuário escolhe
reproduzir a reação no painel.

`web/character-registry.js` centraliza catálogo, manifests, preload, cache e
fallback dos personagens. `web/sprite-animation-engine.js` mantém um único loop
de frames para painel e previews. O reaction engine continua responsável por
condições, fila, movimento e despacho, delegando somente a renderização do
estado. `web/behavior-studio-animation-preview.js` isola a prévia do Studio.

As regras editáveis estão em `web/config/sprite-behaviors.json`. O arquivo
`web/config/sprite-behaviors.schema.json` descreve seu contrato e permite
diagnósticos amigáveis antes da compilação. A configuração contém:

- metadados e versão do formato;
- dicionário central de macros, incluindo origem, caminho, tipo, unidade e
  fallback;
- seletores dos cards e zonas de destino permitidas;
- comportamento padrão de caminhada, descanso, fala e colisão;
- frases curtas reutilizáveis;
- gatilhos com condição, prioridade, cooldown, estado, destino e persistência.

O carregamento é resiliente: uma configuração inválida não interrompe a
interface. O motor conserva a última configuração válida; se ainda não houver
uma, ativa as regras legadas seguras e expõe o motivo do fallback para
diagnóstico.

O motor de sprites:

1. normaliza uso, resets, saúde, telemetria, clima, horário e inatividade;
2. resolve macros e interpreta `>`, `>=`, `<`, `<=`, `==`, `between`,
   `all`/`any`, faixas de horário e eventos;
3. detecta mudanças relevantes e mantém uma fila com prioridades e cooldowns;
4. cria de um a três personagens e evita falas duplicadas;
5. mantém coordenadas, destino e estado de cada personagem;
6. usa `requestAnimationFrame` para movimentação e animações de estado;
7. localiza cards pelos seletores configurados e ocupa suas zonas seguras;
8. separa personagens, limita o viewport e recalcula posições em resize/scroll;
9. permite drag por Pointer Events;
10. respeita `prefers-reduced-motion` sem ocultar os personagens.

O tempo sem interação no painel (`idleSeconds`) governa sono, tédio e retorno.
A ociosidade global do Windows (`systemIdleSeconds`) é normalizada e mantida em
campo independente para telemetria; ela não substitui nem reduz a medição do
painel.

## Fluxo de dados

```text
Edge Analytics -> CDP monitor -> uso/health JSON -> /api/status -> app.js
Máquina/clima -> telemetry.py -> /api/telemetry -> app.js
sprite-behaviors.json + schema -> validação/compilação -> motor
Snapshots do app.js -> normalização/macros/gatilhos -> fila -> estado/movimento/fala
Studio -> API local -> validação/revisão/backup -> sprite-behaviors.json
Motor -> callback sanitizado -> /api/studio/history -> runtime/behavior-studio
```

## Persistência

- Uso e saúde: arquivos JSON locais.
- Personalização dos sprites e tema: `localStorage` do navegador.
- Clima: cache em memória do processo do dashboard.
- Configuração oficial de reações: `web/config/sprite-behaviors.json`, com
  referência restaurável em `web/config/sprite-behaviors.default.json` e
  backups sob `runtime/behavior-studio`.
- Histórico de reações: JSONL sanitizado sob `runtime/behavior-studio`.

## Runtime e isolamento

O servidor, a coleta, os testes e os runners do Edge usam somente o Python já
instalado e selecionado pelos scripts. Nenhum fluxo cria VENV, executa `pip` ou
exporta cookies, perfil do Edge ou credenciais. Dashboard e CDP permanecem
limitados a loopback por padrão.

O dashboard pressupõe uma única instância local por checkout. A revisão SHA-256
e o lock do serviço coordenam abas e requisições concorrentes dentro dessa
instância; dois processos não devem apontar para a mesma pasta de configuração.
