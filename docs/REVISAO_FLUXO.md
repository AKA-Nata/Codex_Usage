# Revisão do fluxo

## Pontos identificados na versão anterior

1. O endpoint interno era consultado diretamente, mas a chamada real da página não era observada.
2. A identificação alternativa das janelas podia inverter 5 horas e semanal quando a estrutura do JSON mudasse.
3. Falhas podiam substituir o estado útil exibido pelo painel.
4. Não havia separação entre dado válido e saúde da última tentativa.
5. Execuções manuais e agendadas podiam ocorrer simultaneamente.
6. Screenshots e textos de debug podiam crescer indefinidamente.
7. O fallback visual dependia principalmente de expressão regular sobre o `body` inteiro.
8. A sessão expirada não possuía estado específico.
9. O painel era estático e não permitia solicitar atualização.
10. Não havia contagem regressiva em tempo real ou sinalização de dado antigo.
11. O agendamento não declarava explicitamente uma política contra múltiplas instâncias.
12. O fluxo PowerShell de início rápido poderia ser interrompido por scripts que usavam `exit` internamente.
13. Não havia testes automatizados do contrato observado no HAR.

## Correções aplicadas

- Observação de `response` durante a navegação.
- Fetch autenticado somente como segundo nível.
- Fallback visual por `article` e texto do card.
- Ordenação defensiva por `limit_window_seconds`.
- JSON de dados e JSON de health separados.
- Escrita atômica.
- Preservação do último resultado válido.
- Lock com expiração.
- Log rotativo e retenção de debug.
- Estado `auth_required`.
- Dashboard HTTP local com APIs e atualização manual.
- Countdown e verificação de staleness.
- Tarefa agendada com `IgnoreNew` e sessão interativa.
- Testes unitários com payload sanitizado derivado do contrato observado.
- Revisão dos scripts PowerShell para composição correta no `quick_start.ps1`.
