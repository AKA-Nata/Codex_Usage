
# Changelog

## 4.2.0

- Adicionado Studio Visual de Comportamentos em seis abas para editar,
  duplicar, ativar, testar e excluir gatilhos e falas sem alterar JSON
  manualmente.
- Editor de condições cobre métricas, eventos, horário exato, faixas horárias,
  `AND`/`OR`, personagem, animação, prioridade, cooldown, duração,
  persistência e repetição enquanto ativa.
- Dicionário de macros mostra origem, tipo, unidade, fallback, valor real e
  disponibilidade, com inserção direta nas falas e validação antecipada.
- Simulador isolado permite montar cenários completos e reproduzir uma reação
  temporária no painel sem substituir os dados reais.
- Backend local passou a validar o arquivo oficial contra o JSON Schema, usar
  revisão otimista, backup e gravação atômica, além de importar, exportar e
  restaurar a referência padrão.
- Histórico sanitizado em `runtime/behavior-studio` registra gatilho, valores,
  personagem, card, frase, tempos e resultado, sem dados de sessão.
- Contrato declarativo ampliado para nome amigável, personagem específico,
  falas por personagem, fallback, prevenção de repetição e repetição
  configurável.
- Cobertura ampliada para 35 testes Python, 37 casos JavaScript e 23
  verificações E2E no Microsoft Edge, preservando o modo sem VENV e sem npm.

## 4.1.1

- Corrigida a validação de `casualSpeech`, `features`, `coordination` e `motion`,
  permitindo que `sprite-behaviors.json` seja carregado em runtime.
- Removido o campo legado do hero no HTML, armazenamento e bindings do painel.
- Adicionada coleta opcional de GPU NVIDIA via `nvidia-smi`, sem nova
  dependência Python.
- Métricas de memória e disco agora rejeitam capacidades impossíveis e
  retornam estado parcial em vez de exibir valores incorretos.
- Adicionados testes de GPU e sanidade de capacidade; bateria atual com 15
  testes Python e 28 casos JavaScript.
- Adicionado `scripts/package_source.ps1` para gerar entregas seguras com
  `git archive`, sem perfil do Edge, `.git`, logs ou dados operacionais.
- Documentação de validação e segurança ajustada para não declarar smoke visual
  como executado antes da validação real no Windows/Edge.

## 4.1.0

- Adicionada configuração declarativa em `web/config/sprite-behaviors.json`,
  acompanhada de JSON Schema, para macros, frases, cards, prioridades,
  cooldowns e gatilhos dos companheiros.
- O motor passou a interpretar operadores, grupos lógicos, faixas de horário,
  mudanças de valores e eventos de clique, arraste, inatividade, retorno, erro
  e recuperação, com validação amigável e fallback seguro.
- Dashboard simplificado para quatro cards ambientais e dois cards do Codex,
  com status da coleta no cabeçalho e zonas reservadas para os sprites.
- Sprites mantidos sempre acima dos cards, com docas seguras, prevenção de
  colisões, suporte a resize e de um a três personagens.
- Corrigida a associação de limite atingido às janelas de 5 horas e semanal.
- A inatividade do painel passou a ser prioritária nas reações; a ociosidade do
  Windows permanece preservada separadamente na telemetria.
- Estados contextuais ampliados sem novos bitmaps: os assets pixel art atuais
  são reaproveitados com animações e efeitos CSS.
- Saúde da coleta passa a registrar falhas inesperadas imediatamente, sem
  descartar o último uso válido.
- Finais de linha passam a ser normalizados por `.gitattributes`, preservando
  arquivos binários e evitando diffs mistos entre Windows e runners locais.
- Cobertura ampliada para 28 casos JavaScript, 15 verificações E2E no Edge e
  12 testes Python, mantendo toda a execução sem VENV ou instalação automática.

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
