
# Changelog

## 4.0.1

- Removida toda dependência operacional de `.venv`.
- Scripts passam a usar exclusivamente o Python já instalado na máquina.
- Seleção de runtime por `CODEX_USAGE_PYTHON`, `py -3`, `python` ou `python3`.
- `install.ps1` agora apenas valida o ambiente e executa testes; não chama `pip`.
- Validação explícita de Python 3.11+ e das bibliotecas `websocket-client`, `psutil` e `tzdata`.
- Adicionados `validate_environment.ps1` e `docs/RUNTIME_PYTHON.md`.
- Diagnóstico atualizado para exibir o executável e as versões das bibliotecas em uso.

## 4.0.0

- Sprites removidos da posição fixa do hero e movidos para uma camada livre.
- Movimento autônomo com animações de caminhada, alerta, repouso e fala.
- Suporte a um, dois ou três companheiros simultâneos.
- Arrastar, clicar e reposicionar companheiros manualmente.
- Interações contextuais com relógio, inatividade, clima, uso da máquina e limites do Codex.
- Novos cards de hora, tempo sem interação, temperatura e CPU/RAM/disco.
- Novo endpoint local `GET /api/telemetry`.
- Telemetria da máquina por `psutil`.
- Temperatura configurável com cache e fallback de erro.
- Sprites individuais recortados da folha original para melhorar escala, nitidez e movimentação.
- Configurações de quantidade, escala, velocidade, frequência de fala e comportamento no estúdio visual.
- Validação de latitude e longitude no `config.json`.

## 3.0

- Removidos a extensão do navegador, o RPA Playwright e a ponte local de ingestão.
- O monitor CDP passou a ser o único caminho de coleta.
- O painel atualiza os dados executando diretamente uma coleta CDP.
