# Codex Usage Monitor 5.0.0 — Python da máquina

Painel local para acompanhar os limites de uso de 5 horas e semanal do Codex,
com companheiros pixel art que circulam pela interface e reagem aos dados reais
de relógio, clima, máquina, inatividade e coleta.

Esta distribuição **não cria VENV, não instala pacotes e não executa pip**.
Todos os processos utilizam exclusivamente o Python e as bibliotecas já
instalados na máquina.

## Multi-provider e catálogo

O nome histórico foi preservado, mas o painel agora agrega Codex e Claude em
providers independentes, com cards dinâmicos por janela. A CLI Claude somente
confirma disponibilidade; sem fonte verificável, o dashboard mostra
`unavailable`/`unsupported`, nunca `0%`. O botão Abrir Claude Code é uma ação
local fixa e segura.

A biblioteca inclui nativos, bundled e instalados. Busca e filtros de origem,
tag, personalidade, instalação e estado podem ser combinados sem pré-carregar
sprite sheets; assets são carregados apenas para o personagem selecionado.

## O que o painel mostra

- Quatro cards ambientais: hora/data, interação, clima e máquina.
- Dois cards do Codex: limite de 5 horas e limite semanal, com percentual e
  reset.
- Estado do coletor e horário da última atualização, de forma discreta no
  cabeçalho.

O dashboard 4+2 elimina blocos decorativos redundantes e reserva zonas seguras
nos cards. Os sprites permanecem visualmente acima do painel, sem cobrir textos,
botões ou gráficos.

## Companheiros interativos

Os sprites são renderizados em uma camada livre e podem:

- andar pela tela;
- ser arrastados;
- visitar relógio, clima, máquina e cards do Codex;
- reagir por estado, movimento e fala às faixas de uso e ao tempo de reset;
- alertar sobre CPU, memória e disco elevados;
- usar métricas opcionais de GPU NVIDIA nas macros quando `nvidia-smi` estiver disponível;
- sentir frio, calor e reagir à chuva;
- dormir após inatividade e acordar quando o usuário retorna;
- vigiar coleta desatualizada, com erro ou telemetria indisponível;
- falar ao serem clicados;
- trabalhar em grupos de um a três companheiros sem repetir a mesma fala.

No estúdio visual é possível escolher personagem principal, quantidade,
tamanho, velocidade e intervalo de fala. Falas, deslocamento, movimento livre e
reações contextuais podem ser ativados ou desativados separadamente.

Os estados `idle`, `walk`, `inspect`, `point`, `talk`, `happy`, `worried`,
`critical`, `hot`, `cold`, `sleep`, `wake`, `confused` e `celebrate` usam
sprite sheets PNG reais, com FPS, loop, espelhamento e fallback declarados.

## Comportamentos declarativos

As regras ficam fora de `app.js` e podem ser revisadas sem alterar a coleta ou
o dashboard:

- `web/config/sprite-behaviors.json`: macros, cards, comportamento padrão,
  frases, gatilhos, prioridades e cooldowns;
- `web/config/sprite-behaviors.schema.json`: contrato JSON Schema usado para
  validar a configuração;
- `web/sprite-reaction-engine.js`: normalização, interpretação dos operadores,
  fila de eventos, escolha de personagem, movimento, estado e fala.

As macros `{{hora}}`, `{{data}}`, `{{tempo_sem_interacao}}`, `{{temperatura}}`,
`{{clima}}`, `{{cpu}}`, `{{ram}}`, `{{disco}}`, `{{gpu}}`,
`{{gpu_memoria}}`, `{{codex_5h_percentual}}`, `{{codex_5h_reset}}`,
`{{codex_semanal_percentual}}`, `{{codex_semanal_reset}}`,
`{{coleta_status}}` e `{{ultima_atualizacao}}` têm origem, tipo, unidade e
fallback definidos no próprio arquivo. Há também macros booleanas específicas
para os limites de 5 horas e semanal atingidos.

Os gatilhos aceitam comparações `>`, `>=`, `<`, `<=`, `==` e `between`, grupos
`all`/`any`, faixas de horário, mudanças de valor e eventos de clique, arraste,
inatividade, retorno, erro, recuperação e atualização desatualizada. Se o JSON
não puder ser carregado ou validado, o motor mantém a configuração válida
anterior; sem uma anterior, usa o conjunto legado seguro e informa o fallback
no diagnóstico do painel.

## Studio Visual de Comportamentos

O botão `✦` abre um overlay separado, mantendo o dashboard focado nos seis
cards. O Studio organiza a edição em:

- **Personagens**: biblioteca, preview animado, metadados, diagnóstico,
  importação, exportação, ativação, rollback e remoção de pacotes;
- **Comportamentos**: CRUD, ativação, busca, filtros, prioridade e editor visual
  de condições `AND`/`OR`;
- **Falas**: biblioteca reutilizável, macros clicáveis, validação e preview com
  os valores locais atuais;
- **Macros**: origem, tipo, unidade, fallback, valor e disponibilidade;
- **Simulador**: cenário isolado de máquina, clima, limites, resets, horário,
  inatividade e coleta, com reprodução temporária no painel;
- **Configuração padrão**: parâmetros globais de movimento, fala e coordenação;
- **Histórico**: diagnóstico sanitizado das reações executadas.

O salvamento ocorre somente pelo backend local. Antes de substituir
`web/config/sprite-behaviors.json`, o servidor valida o documento contra o
schema, confere macros e referências, verifica a revisão, cria backup e usa
gravação atômica. Importação, exportação e restauração usam o mesmo gate.

## Animações reais dos personagens

Os quatro personagens nativos agora usam sprite sheets PNG próprios para cada
estado em `web/assets/characters/<id>/`. O registry valida os manifests,
pré-carrega e compartilha o cache das imagens e mantém os PNGs antigos como
fallback. O motor de reações continua decidindo comportamento, card e fala; o
novo motor de animação cuida exclusivamente de frames, FPS, loop, espelhamento,
pause e reduced motion.

O editor de gatilhos mostra uma prévia animada com play/pause, ajuste temporário
de FPS e diagnóstico de asset/fallback. Configurações e preferências 4.2 usam os
mesmos IDs (`explorer`, `wizard`, `mechanic`, `orb`) e migram automaticamente
com backup quando a configuração oficial precisa ser atualizada.

## Plataforma de personagens 5.0

Personagens extensíveis são distribuídos como `.codex-character.zip`, contendo
somente `manifest.json`, PNGs, comportamentos, falas, preview e licença. O
backend valida SemVer, compatibilidade, checksums, MIME/assinatura PNG,
dimensões, frames e limites contra ZIP bomb; recusa traversal, links, scripts e
caminhos fora do registry. Instalação e atualização são atômicas, com versões
anteriores disponíveis para rollback.

Identidade visual e personalidade são contratos independentes. Os perfis
versionados `technical`, `humorous`, `objective`, `silent` e `critical` ficam em
`web/config/personalities/`. Gatilhos podem selecionar por ID, grupo, tag,
personalidade ou capacidade. Seletores legados 4.2/4.3 migram automaticamente.

O pacote oficial de exemplo está em
`examples/characters/sentinel.codex-character.zip`; sua fonte demonstra o
formato público e pode ser reconstruída de forma determinística com
`scripts/build_character_package.py`. Consulte `docs/CHARACTER_PACKAGES.md`.

As macros de GPU são preenchidas automaticamente em máquinas NVIDIA com
`nvidia-smi` disponível. Em outros equipamentos, permanecem com o fallback
configurado, sem interromper o painel.

A inatividade do painel é a fonte prioritária para reações de sono e retorno.
O tempo ocioso do Windows continua disponível em campo separado na telemetria,
sem encurtar silenciosamente o tempo medido no painel.

## Requisitos

- Windows 10 ou 11;
- Microsoft Edge;
- Python 3.11 ou superior já instalado;
- bibliotecas `websocket-client`, `psutil` e `tzdata` instaladas nesse Python;
- login ativo em ChatGPT/Codex;
- acesso à internet para a temperatura atual.

O `requirements.txt` é apenas informativo. O projeto não instala dependências.

## Seleção do Python

Os scripts procuram:

1. `CODEX_USAGE_PYTHON`;
2. `py -3`;
3. `python`;
4. `python3`.

Para fixar um Python específico:

```powershell
$env:CODEX_USAGE_PYTHON = "C:\Python311\python.exe"
```

Detalhes: `docs/RUNTIME_PYTHON.md`.

## Preparação

O script abaixo apenas valida o Python, as bibliotecas e os testes. Ele não
cria VENV e não altera a máquina:

```powershell
.\scripts\install.ps1
```

Também é possível validar apenas o runtime:

```powershell
.\scripts\validate_environment.ps1
```

## Inicialização

Abra o Edge dedicado:

```powershell
.\scripts\start_cdp_edge.ps1
```

Faça login nessa janela e mantenha aberta a página:

```text
https://chatgpt.com/codex/cloud/settings/analytics?locale=pt-BR
```

Em outro terminal, inicie o monitor:

```powershell
.\scripts\monitor_open_tab.ps1
```

Em outro terminal, inicie o painel:

```powershell
.\scripts\start_dashboard.ps1
```

Painel:

```text
http://127.0.0.1:8088
```

## Temperatura

A localização fica em `config.json`:

```json
"weather": {
  "enabled": true,
  "location_label": "Blumenau",
  "latitude": -26.9194,
  "longitude": -49.0661,
  "cache_seconds": 600,
  "timeout_seconds": 5
}
```

Para desativar, altere `enabled` para `false`.

## API local

- `GET /api/status`: uso do Codex, saúde do coletor e configurações.
- `GET /api/usage`: último uso válido.
- `GET /api/health`: saúde da última coleta.
- `GET /api/telemetry`: relógio, máquina e temperatura.
- `POST /api/refresh`: executa coleta CDP sob demanda.
- `GET /api/studio/config`: configuração oficial, revisão e diagnóstico.
- `POST /api/studio/config/validate`: valida um rascunho sem persistir.
- `PUT /api/studio/config`: salva configuração válida com backup.
- `GET /api/studio/schema`: schema oficial.
- `GET /api/studio/config/export`: exporta o JSON oficial.
- `POST /api/studio/config/import`: importa e salva após validação.
- `POST /api/studio/config/restore-default`: restaura a referência padrão.
- `GET /api/studio/macros`: catálogo atual sanitizado.
- `GET`, `POST` e `DELETE /api/studio/history`: consulta, registro e limpeza do
  histórico local.
- `GET /api/characters/v1/catalog`: catálogo nativo e instalado.
- `GET /api/characters/v1/assets/{id}/{version}/{path}`: asset validado do registry.
- `GET /api/behaviors/v1/effective`: configuração oficial composta com pacotes ativos.
- `GET /api/behaviors/v1/effective/diagnostics`: pacotes compostos, revisão e rejeições.
- `GET /api/studio/characters/v1`: biblioteca e revisões do registry.
- `POST /api/studio/characters/v1/validate`: valida pacote sem instalar.
- `POST /api/studio/characters/v1/install`: instala um novo pacote validado.
- `POST /api/studio/characters/v1/{id}/update`: instala uma versão SemVer superior.
- `POST /api/studio/characters/v1/{id}/enable|disable|activate|rollback`: ciclo de vida.
- `GET /api/studio/characters/v1/{id}/export`: exporta o pacote original.
- `DELETE /api/studio/characters/v1/{id}`: remove após verificar referências.
- `POST /api/studio/characters/v1/restore-natives`: restaura os quatro nativos.

O catálogo e a biblioteca retornam `ETag`. Toda mutação de personagens exige
o mesmo valor em `If-Match`, impedindo que uma aba antiga sobrescreva outra.

## Scripts

- `scripts/install.ps1`: valida o ambiente e os testes; não instala nada.
- `scripts/validate_environment.ps1`: mostra Python e bibliotecas selecionados.
- `scripts/start_cdp_edge.ps1`: abre o Edge dedicado.
- `scripts/monitor_open_tab.ps1`: monitor contínuo.
- `scripts/monitor_open_tab_once.ps1`: coleta única.
- `scripts/start_dashboard.ps1`: inicia o painel.
- `scripts/diagnose.ps1`: diagnóstico do runtime, Edge e coleta.
- `scripts/test.ps1`: compilação e testes.
- `scripts/build_character_package.py`: gera pacote reproduzível.
- `scripts/build_native_character_packages.py`: reconstrói os pacotes nativos.
- `scripts/package_source.ps1`: gera ZIP seguro somente com arquivos versionados.

## Segurança

Nunca compartilhe ou versione `runtime/`, pois o perfil isolado pode conter a
sessão do navegador. A porta CDP deve permanecer limitada a `127.0.0.1`. O
painel permanece em loopback por padrão.

Backups e histórico do Studio ficam sob `runtime/behavior-studio/`, fora de
`web/` e do Git. A referência restaurável é o arquivo versionado
`web/config/sprite-behaviors.default.json`. Os endpoints aceitam apenas
Host/Origin de loopback, corpos JSON limitados e campos sanitizados; não leem
nem retornam cookies, tokens ou o perfil do Edge.

Não compacte a raiz do projeto com `Compress-Archive`, pois isso pode incluir
`.git`, cookies, histórico e dados operacionais. Após o commit, gere a entrega
somente com arquivos versionados:

```powershell
.\scripts\package_source.ps1
```
