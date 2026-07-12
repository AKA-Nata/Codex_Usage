# Motor de reações dos companheiros

O motor mantém as regras, a fila de eventos, a seleção de personagem, o
deslocamento, a animação e a fala fora de `app.js`. A interface apenas entrega
o contexto bruto do painel e as preferências salvas no navegador.

As decisões são declaradas em `web/config/sprite-behaviors.json` e verificadas
pelo contrato `web/config/sprite-behaviors.schema.json`. O motor carrega,
valida, compila e interpreta essa configuração; `app.js` não contém thresholds
nem frases de reação.

## Personagens e assets

| Personagem | Asset-base | Canvas atual |
| --- | --- | --- |
| Explorador | `web/assets/sprites/explorer.png` | 445 × 445 px |
| Mago | `web/assets/sprites/wizard.png` | 470 × 470 px |
| Mecânico | `web/assets/sprites/mechanic.png` | 439 × 439 px |
| Orbital | `web/assets/sprites/orb.png` | 430 × 430 px |

Os quatro arquivos têm fundo transparente e são renderizados com
`image-rendering: pixelated`. Nesta versão, cada personagem possui um único
frame-base. As diferenças de estado são produzidas por transformações em
passos, filtros e pelo elemento `.sprite-effect`; não há interpolação entre
bitmaps. `web/assets/sprite-sheet.png` é uma composição legada dos quatro
personagens e não é usada pelo motor.

Nenhum asset bitmap foi criado na versão 4.1.0. Todos os novos estados e sinais
visuais reaproveitam os quatro frames-base existentes por meio de CSS, mantendo
pixels nítidos, paleta, proporção, transparência e identidade dos personagens.

Se forem adicionados frames no futuro, eles devem permanecer em
`web/assets/sprites/<personagem>/<estado>.png`, com canvas, baseline, escala e
origem idênticos dentro de cada personagem. O frame-base atual continua sendo
o fallback obrigatório.

## Estados e mapeamento visual

As taxas abaixo representam passos visuais de CSS por segundo, não novos
frames de bitmap. Cada estado continua usando exatamente um frame-base por
personagem.

| Estado/classe | Frames | Keyframe e FPS visual aproximado | Loop | Saída/fallback |
| --- | ---: | --- | --- | --- |
| `idle` / `.state-idle` | 1 | `spriteIdle`, 0,6 FPS | contínuo e discreto | frame-base parado |
| `walk` / `.state-walk` | 1 | `spriteWalk`, 4,2 FPS | enquanto houver destino | `idle` no destino |
| `inspect` / `.state-inspect` | 1 | `spriteInspect`, 3 FPS | enquanto inspeciona | `point` ou apresentação da reação |
| `point` / `.state-point` | 1 | `spritePoint`, 4,2 FPS | enquanto aponta | estado próprio da reação |
| `talk` / `.state-talk` | 1 | `spriteTalk`, 4,8 FPS | durante a fala | `idle` |
| `happy` / `.state-happy` | 1 | `spriteHappy`, 4,9 FPS | 2 ciclos | `idle` |
| `worried` / `.state-worried` | 1 | `spriteWorried`, 5,7 FPS | durante o alerta | `inspect` |
| `critical` / `.state-critical` | 1 | `spriteCritical`, 10 FPS | durante a condição crítica | permanece fixado enquanto a condição existir; depois `idle` |
| `hot` / `.state-hot` | 1 | `spriteHot`, 3,3 FPS | durante calor/carga alta | `idle` |
| `cold` / `.state-cold` | 1 | `spriteCold`, 6,1 FPS | durante o frio | `idle` |
| `sleep` / `.state-sleep` | 1 | `spriteSleep`, 0,8 FPS | enquanto o usuário estiver inativo | `wake` no retorno ou `idle` ao liberar a condição |
| `wake` / `.state-wake` | 1 | `spriteWake`, 5,1 FPS | 1 ciclo | `idle` |
| `confused` / `.state-confused` | 1 | `spriteConfused`, 3,8 FPS | durante erro ou dúvida | permanece fixado em erros persistentes; caso contrário, `idle` |
| `celebrate` / `.state-celebrate` | 1 | `spriteCelebrate`, 5,6 FPS | 3 ciclos | `idle` |
| `dragging` / `.dragging` | 1 | sem keyframe, 0 FPS | somente durante o arraste | estado persistente fixado ou `idle` |

`facing-left` espelha o frame e o efeito. `talking` controla a visibilidade do
balão. `bubble-left`, `bubble-right` e `bubble-below` escolhem a orientação do
balão conforme o espaço seguro no viewport. A camada dos personagens permanece
sempre acima dos cards, inclusive durante `walk` e `dragging`. Para preservar a
leitura e os controles, os destinos usam zonas reservadas e a geometria do
motor evita áreas protegidas e colisões.

Estados desconhecidos ou dados visuais incompletos devem cair em `idle`, sem
remover o personagem nem interromper o arraste.

## Configuração declarativa

O JSON é dividido em cinco blocos funcionais:

- `metadata`: identidade, locale e versões do arquivo e do schema;
- `macros`: dicionário de valores disponíveis para condições e frases;
- `cards`: nomes lógicos e seletores dos destinos do painel;
- `defaultBehavior`: velocidade, duração, descanso, movimento livre, destinos,
  fala casual e prevenção de colisões;
- `phrases` e `triggers`: textos reutilizáveis e regras priorizadas.

Cada macro informa `token`, `origin`, `sourcePath`, `type`, `unit`, `fallback`
e descrição. O conjunto inclui hora, data, tempo sem interação, temperatura,
clima, CPU, RAM, disco, GPU opcional, memória de GPU opcional, percentuais e
resets do Codex de 5 horas e semanal, flags de limite atingido, status da
coleta e última atualização. Uma macro ausente ou inválida usa seu fallback e
nunca injeta `undefined`, `NaN` ou uma exceção no balão.

Condições aceitam os operadores `>`, `>=`, `<`, `<=`, `==` e `between`, além de
composição por `all` e `any`. Também podem observar faixas de horário que cruzam
a meia-noite, mudança de valor, clique em card ou sprite, fim de arraste,
inatividade/retorno, erro ou recuperação da coleta, reset próximo e intervalo
casual. A ação de cada gatilho define prioridade, cooldown, estado, destino,
frase e se a reação deve permanecer enquanto a condição existir. O contrato
2.0 também permite nome amigável, personagem automático ou específico, falas
por personagem, fallback, prevenção de repetição e repetição configurável
enquanto a condição permanece ativa.

O Studio Visual edita esse contrato sem expor o JSON ao usuário. A configuração
só é aplicada ao motor após validação pelo backend, backup e escrita atômica;
o hot reload conserva a última versão válida. O simulador usa avaliação pura e
`playTemporary`, portanto não substitui o contexto real nem consome o cooldown
do gatilho oficial.

Se o arquivo não existir ou violar o schema, a interface continua operando. O
motor conserva a última configuração válida; na primeira carga, usa um conjunto
legado seguro. O status da configuração registra o fallback e mensagens de
validação compreensíveis, sem expor dados operacionais.

## Normalização e thresholds

Antes de criar eventos, o motor converte números somente quando são finitos,
limita percentuais a 0–100 e valida datas. `null`, string vazia, `NaN`, data
inválida e telemetria indisponível permanecem indisponíveis; nunca viram zero.

Os thresholds são configuráveis. Os padrões funcionais são:

| Dado normalizado | Faixa | Reação principal |
| --- | --- | --- |
| Codex 5h ou semanal | acima de 60% | comportamento normal e comentário discreto |
| Codex 5h ou semanal | acima de 30% até 60% | visitar o card, `inspect`/`point` e fala curta |
| Codex 5h ou semanal | de 10% até 30%, inclusive | `worried` e alerta moderado; 30% pertence a esta faixa |
| Codex 5h | abaixo de 10% ou flag de 5h atingido | `critical`, informar reset e permanecer no card |
| Codex semanal | abaixo de 10% ou flag semanal atingido | `critical`, informar reset e permanecer no card |
| Reset Codex válido | acima de zero e até 30 minutos | expectativa com `celebrate`; não substitui uma reação crítica |
| CPU ou RAM | acima de 75% | `hot`/`worried` junto ao card da máquina |
| CPU ou RAM | acima de 90% | `critical` junto ao card da máquina |
| Disco | acima de 85% | inspeção e aviso moderado |
| Disco | acima de 95% | alerta crítico |
| Temperatura | até 12 °C | `cold` |
| Temperatura | a partir de 30 °C | `hot` |
| Condição meteorológica | chuva, garoa ou tempestade | reação contextual no card de clima |
| Inatividade normalizada | a partir de 5 minutos | entediado/inspeção no card de inatividade |
| Inatividade normalizada | a partir de 15 minutos | `sleep` |
| Retorno após inatividade | transição para atividade | `wake`, saudação única e retorno ao fluxo livre |
| Coleta desatualizada | prazo de `stale_after_minutes` excedido | `confused` no status |
| Erro de coleta ou telemetria | imediatamente | `confused` próximo ao status ou ao card da máquina |

O tempo de inatividade do painel é prioritário para as reações. O tempo ocioso
geral do Windows continua normalizado como `systemIdleSeconds`, em campo
separado, sem encurtar nem substituir `idleSeconds`. Temperatura indisponível
ou clima desativado não geram reação de frio/calor. Horário válido pode gerar
saudações de manhã, tarde, noite ou madrugada, sempre em baixa prioridade.

Os estados de limite atingido são calculados por janela. Quando uma fonte
legada fornece somente uma flag global, a normalização a associa à janela
compatível com os percentuais disponíveis, sem marcar simultaneamente os dois
cards por engano.

## Fila, prioridades e cooldowns

A fila é ordenada por prioridade decrescente e, em empate, pela chave do
evento. O cooldown só começa quando um evento é realmente entregue a um
personagem. Uma assinatura de condição impede que o mesmo polling replique o
evento; mudança de faixa, erro novo, retorno do usuário ou fim do cooldown
liberam uma nova reação.

| Evento | Prioridade padrão | Cooldown padrão |
| --- | ---: | ---: |
| erro de coleta | 120 | 60 s |
| retorno do usuário (`wake`) | 118 | 30 s e somente após transição de inatividade |
| dados de coleta desatualizados | 115 | 120 s |
| aguardando primeira coleta válida | 112 | 120 s |
| Codex 5h crítico/limite atingido | 110 | 90 s |
| Codex semanal crítico | 108 | 90 s |
| erro geral de telemetria | 107 | 120 s |
| reset de 5h próximo | 105 | 120 s |
| CPU, RAM ou disco críticos | 104 | 120 s |
| reset semanal próximo | 103 | 120 s |
| Codex 5h de 10% a 30% | 90 | 180 s |
| Codex semanal de 10% a 30% | 88 | 180 s |
| CPU/RAM acima de 75% ou disco acima de 85% | 80 | 120 s |
| inatividade em `sleep` | 78 | 240 s |
| métricas da máquina indisponíveis | 72 | 120 s |
| chuva | 67 | 240 s |
| Codex 5h acima de 30% até 60% | 65 | 240 s |
| frio ou calor | 64 | 240 s |
| Codex semanal acima de 30% até 60% | 63 | 240 s |
| inatividade entediada | 55 | 240 s |
| hora/saudação informativa | 30 | 300 s |
| limites em faixa normal | 20 | 600 s |

Um evento só pode pertencer a um personagem por vez. Personagens arrastados,
em reação ou fixados por uma condição persistente não recebem outro evento. O
motor só despacha nova reação automática quando não há outra reação ou balão
em apresentação. Chave e assinatura evitam repetição por polling; a seleção
prioriza não reutilizar imediatamente o último personagem e o último assunto.

## Cards, zonas seguras e áreas protegidas

Os nomes lógicos são resolvidos pelos seletores declarados em `cards`:

- `status`: coleta desatualizada, falha ou recuperação;
- `hora`: hora e período do dia;
- `interacao`: inatividade, sono e retorno;
- `temperatura`: temperatura e condição climática;
- `maquina`: CPU, RAM, disco e telemetria;
- `codex_5h`: limite e reset de 5 horas;
- `codex_semanal`: limite e reset semanal.

Os quatro cards ambientais e os dois cards do Codex possuem
`data-sprite-safe-zone`. Essas áreas decorativas são docas preferenciais, ficam
livres de texto e controles e permitem apontar para o dado sem cobri-lo.
Elementos com `data-sprite-protected` continuam sendo obstáculos.

O motor mede o corpo dos sprites, pontua interseções, considera a distância
entre companheiros e escolhe a zona ou doca segura de menor custo. As posições
são recalculadas em resize e scroll e permanecem limitadas ao viewport. Nas
bordas, `bubble-left`, `bubble-right` e `bubble-below` orientam o balão para a
região visível. Se uma posição deixar de ser segura, o sprite é redocado; a
camada visual não é rebaixada para ocultá-lo.

## Personalização e acessibilidade

As preferências são independentes e persistidas no navegador:

- `spriteEnabled`: exibe ou oculta os companheiros;
- `spriteSpeech`: permite balões e falas contextuais;
- `spriteMovement`: permite deslocamento reativo e livre;
- `spriteRoam`: permite caminhada livre quando não há reação pendente;
- `spriteSmart`: habilita reações aos dados e alertas;
- `spriteCount`: seleciona de um a três personagens;
- `spriteScale`, `spriteSpeed` e `spriteTalkInterval`: controlam apresentação.

Desativar `spriteMovement` não desativa reação nem fala: o personagem reage na
posição atual. `spriteRoam` só tem efeito quando movimento está permitido.
Desativar `spriteSpeech` não remove os sinais visuais. Não há áudio automático.

Com `prefers-reduced-motion: reduce`, o mundo permanece visível, mas animações e
transições são removidas. Estados continuam distinguíveis por filtros, efeitos
estáticos e falas, e drag/clique permanecem disponíveis.
