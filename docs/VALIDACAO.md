# Validação

## Bateria automatizada

```powershell
.\scripts\test.ps1
```

A bateria deve validar:

- compilação dos módulos Python;
- parser de network e fallback DOM;
- escrita atômica de JSON;
- contrato de telemetria;
- mapeamento de condições meteorológicas;
- sintaxe JavaScript de `app.js` e `sprite-engine.js` quando Node.js estiver disponível.

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
11. Desativar movimento livre e confirmar que eles param de vagar.
12. Desativar interações inteligentes e confirmar que não iniciam novas falas automáticas.
13. Redimensionar a janela e confirmar que sprites permanecem dentro da tela.
14. Ativar `prefers-reduced-motion` e confirmar que a camada animada é ocultada.

## Critérios de aceite visual

- Sprites não ficam presos ao hero.
- Não bloqueiam permanentemente botões ou conteúdo.
- Balões permanecem legíveis em telas pequenas.
- Movimento não altera o layout e não provoca scroll horizontal.
- Interações críticas têm prioridade sobre comentários informativos.
- O último uso válido do Codex continua visível quando clima ou telemetria falham.
