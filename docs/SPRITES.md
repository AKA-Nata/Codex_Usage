# Motor de companheiros

## Estados

- `idle`: parado aguardando ação.
- `walking`: deslocamento com bobbing e sombra animada.
- `talking`: balão contextual visível.
- `alert`: destaque para limite baixo ou máquina sobrecarregada.
- `sleeping`: reação para longos períodos sem interação.
- `dragging`: controle manual pelo usuário.

## Âncoras disponíveis

Os destinos são elementos HTML com `data-sprite-anchor`:

- `hero`
- `clock`
- `idle`
- `weather`
- `machine`
- `codex-5h`
- `codex-weekly`

## Prioridades

1. Limite de 5 horas baixo.
2. Limite semanal baixo.
3. CPU ou memória elevadas.
4. Longo período sem interação.
5. Clima e hora.
6. Estado normal da máquina e do Codex.

Cada assunto possui cooldown para reduzir repetição.
