# Validação do pacote

Validações executadas antes da geração do ZIP:

- `python -m compileall -q codex_usage rpa_codex_usage_edge.py dashboard_server.py`: OK
- `python -m unittest discover -s tests -v`: 5 testes OK
- Parser validado contra as respostas `/backend-api/wham/usage` presentes no HAR fornecido: OK
- Percentual de 5 horas derivado: 14% restante
- Percentual semanal derivado: 0% restante
- Reset de 5 horas convertido para `2026-07-09T18:31:10-03:00`: OK
- Reset semanal convertido para `2026-07-13T15:11:31-03:00`: OK
- `rpa_codex_usage_edge.py --help`: OK
- `dashboard_server.py --help`: OK
- `GET /api/status` do dashboard local: OK
- Entrega do `web/index.html`: OK
- Sintaxe JavaScript do painel com `node --check`: OK
- Varredura por e-mail, `user_id`, tokens e Authorization hardcoded: sem credenciais encontradas

Limitação da validação deste ambiente: o login real e a execução headless autenticada no Microsoft Edge precisam ser testados na máquina Windows do usuário, pois o perfil e a sessão não são transferíveis.
