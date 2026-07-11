# Validação

## Bateria automatizada

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\test.ps1
```

A bateria deve validar:

- compilação dos módulos Python;
- parser de network e fallback DOM;
- escrita atômica de JSON;
- contrato de telemetria;
- mapeamento de condições meteorológicas;
- sintaxe JavaScript de `app.js`, `sprite-engine.js` e
  `sprite-reaction-engine.js` quando Node.js estiver disponível;
- thresholds, prioridade, cooldown, inatividade e seleção de personagens do
  motor de reações, sem dependências npm.

Quando Node.js estiver disponível, a suíte JavaScript também pode ser executada
isoladamente:

```powershell
node --check web/app.js
node --check web/sprite-engine.js
node --check web/sprite-reaction-engine.js
node --test tests/js/sprite-reaction-engine.node.test.mjs
```

## Testes JavaScript no Edge, sem Node.js

O mesmo conjunto de casos possui um runner HTML nativo. O wrapper PowerShell
inicia um servidor temporário somente em loopback, abre um perfil isolado do
Edge, valida o resultado gravado no DOM e remove os artefatos temporários:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\tests\js\run-edge-tests.ps1
```

O runner utiliza apenas o Python já instalado para servir arquivos estáticos;
não cria VENV, não executa `pip` e não acessa o perfil normal do navegador.

Os casos compartilhados entre Node.js e Edge cobrem:

- Codex em 61%, 60%, 30%, 29%, 10%, 9% e 0%;
- limite atingido, janela semanal e reset próximo;
- CPU e RAM em 75%, acima de 75%, 90% e acima de 90%;
- disco alto e crítico;
- frio, calor e chuva;
- prioridade, cooldown e mudança relevante de condição;
- inatividade, sono e retorno do usuário;
- dados inválidos e valores nulos;
- seleção com um, dois e três sprites sem repetir o último personagem.

## Smoke E2E do dashboard no Edge

O smoke abaixo inicia o dashboard em uma porta livre de loopback, abre o Edge
headless com perfil temporário isolado e controla a página pelo CDP local usando
apenas `ClientWebSocket` do .NET:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\tests\js\run-dashboard-smoke.ps1
```

O script não usa Node.js, não cria VENV e remove com validação de caminho o
perfil e os logs temporários. Ele percorre os viewports `1440x900`, `760x900` e
`390x844`, validando:

- quantidades de um, dois e três sprites dentro do viewport;
- ausência estacionária de sobreposição com `[data-sprite-protected]`;
- ausência de colisão entre sprites e de scroll horizontal;
- no máximo um balão visível;
- toggles independentes de fala, movimento e reações;
- resize, movimento livre e arraste por ponteiro quando houver destino seguro;
- `prefers-reduced-motion` com mundo visível, sprites estáticos e animações CSS
  desativadas.

## Smoke manual recomendado

1. Iniciar o Edge CDP e autenticar.
2. Executar uma coleta única.
3. Iniciar o dashboard.
4. Confirmar `/api/status` e `/api/telemetry` com HTTP 200.
5. Confirmar atualização dos cards de CPU e RAM.
6. Confirmar temperatura ou mensagem clara de indisponibilidade.
7. Arrastar um sprite e soltá-lo em outra área.
8. Clicar no sprite e verificar a fala contextual.
9. Reduzir o intervalo de fala no estúdio e observar visitas aos cards.
10. Alterar quantidade de companheiros entre um e três.
11. Desativar apenas movimento e confirmar que os sprites permanecem estáticos,
    enquanto fala e reações continuam habilitadas; depois reativar.
12. Desativar apenas falas e confirmar ausência de balões sem interromper
    movimento/reações; depois reativar falas, desativar apenas reações e
    confirmar que não surgem novos eventos automáticos.
13. Redimensionar a janela e confirmar que sprites permanecem dentro da tela.
14. Ativar `prefers-reduced-motion` e confirmar que os sprites continuam
    visíveis, porém estáticos e sem deslocamentos ou animações automáticas.

## Critérios de aceite visual

- Sprites não ficam presos ao hero.
- Não bloqueiam permanentemente botões ou conteúdo.
- Balões permanecem legíveis em telas pequenas.
- Movimento não altera o layout e não provoca scroll horizontal.
- Interações críticas têm prioridade sobre comentários informativos.
- O último uso válido do Codex continua visível quando clima ou telemetria falham.
