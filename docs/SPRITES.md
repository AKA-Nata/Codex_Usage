# Motor de reações dos companheiros

O motor mantém as regras, a fila de eventos, a seleção de personagem, o
deslocamento, a animação e a fala fora de `app.js`. A interface apenas entrega
o contexto bruto do painel e as preferências salvas no navegador.

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
balão conforme o espaço seguro no viewport. Durante `state-walk`, o personagem
fica atrás de `.app`, mas continua com Pointer Events nas áreas em que permanece
visível; quando há sobreposição, o conteúdo do painel, que está acima, recebe a
interação. `dragging` sempre fica acima do painel.

Estados desconhecidos ou dados visuais incompletos devem cair em `idle`, sem
remover o personagem nem interromper o arraste.

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
| Codex 5h | abaixo de 10% ou `limit_reached` | `critical`, informar reset e permanecer no card |
| Codex semanal | abaixo de 10%; `limit_reached` global só quando o percentual de 5h estiver ausente | `critical`, informar reset e permanecer no card |
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

O tempo de inatividade normalizado é o menor valor válido entre a atividade no
painel e a atividade geral do sistema. Temperatura indisponível ou clima
desativado não geram reação de frio/calor. Horário válido pode gerar saudações
de manhã, tarde, noite ou madrugada, sempre em baixa prioridade.

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

## Âncoras e áreas protegidas

Destinos são localizados por `data-sprite-anchor`:

- `hero`: movimento livre e mensagens gerais;
- `status`: coleta desatualizada, falha ou telemetria inválida;
- `clock`: hora e período do dia;
- `idle`: inatividade, sono e retorno;
- `weather`: temperatura e condição climática;
- `machine`: CPU, RAM e disco;
- `codex-5h`: limite e reset de 5 horas;
- `codex-weekly`: limite e reset semanal.

Elementos com `data-sprite-protected` são obstáculos. O motor mede o corpo dos
sprites, pontua a interseção com essas áreas, considera a distância entre
companheiros e escolhe uma doca externa ou um canto decorativo livre do card.
As posições são recalculadas em resize ou scroll. O tamanho do balão ainda não
participa explicitamente da pontuação; nas bordas do viewport, `bubble-left`,
`bubble-right` e `bubble-below` orientam o balão para a região visível. Se não
houver espaço seguro, o personagem passa temporariamente para trás do conteúdo
e recolhe o balão. Durante a caminhada, o sprite também passa atrás de `.app`,
mas conserva Pointer Events onde estiver visível.

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
