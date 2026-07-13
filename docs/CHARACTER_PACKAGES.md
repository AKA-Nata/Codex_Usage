# Pacotes de personagens

## Formato público

Um personagem instalável é um ZIP inerte com extensão
`.codex-character.zip`. A raiz contém somente:

```text
manifest.json
behaviors.json
phrases.json
preview.png
LICENSE.txt
assets/*.png
```

Scripts, HTML, SVG, executáveis, links e arquivos não declarados são recusados.
O ID do manifesto é imutável; versões usam SemVer. `visualIdentity` descreve a
aparência, enquanto `personality` referencia um perfil de tom e falas.

O manifesto declara autor, compatibilidade, estados, assets, personalidade,
tags, capacidades, fallback, licença e checksums SHA-256. Cada estado informa
asset, tamanho e quantidade de frames, FPS e loop. O exemplo completo está em
`examples/characters/sentinel/manifest.json`.

## Construção reproduzível

```powershell
py -3 .\scripts\build_character_package.py `
  .\examples\characters\sentinel `
  .\examples\characters\sentinel.codex-character.zip
```

O builder ordena os arquivos, fixa timestamps e permissões, recalcula
checksums e grava o ZIP atomicamente. As entradas são armazenadas sem nova
compressão — PNG já é comprimido — para evitar variação entre versões do zlib.
Duas construções da mesma fonte produzem os mesmos bytes, inclusive entre as
versões de Python suportadas. Os quatro pacotes nativos podem ser reconstruídos com:

```powershell
py -3 .\scripts\build_native_character_packages.py
```

## Validação e segurança

Antes de extrair ou instalar, o backend limita ZIP, arquivos, total
descompactado, razão de compressão, caminhos, dimensões PNG, estados, frames e
FPS. Também verifica:

- assinatura ZIP e CRC;
- traversal, caminhos absolutos, ADS, barras invertidas e nomes reservados;
- colisões por caixa/Unicode, symlink, reparse point e arquivos especiais;
- JSON UTF-8 sem chaves duplicadas ou valores não finitos;
- MIME, assinatura, chunks e CRC de PNG;
- rejeição explícita de APNG; animações usam somente sprite sheet horizontal;
- dimensões da sheet em relação aos frames;
- contrato completo de gatilhos, eventos, condições, falas e macros;
- compatibilidade com o dashboard e checksums de todos os arquivos, inclusive
  licença, conferidos também ao servir um asset.

O conteúdo nunca é importado nem executado. A extração ocorre em staging dentro
do registry e a ativação usa troca atômica. Os endpoints são locais, exigem
Host/Origin de loopback e não retornam cookies, tokens, perfil Edge ou dados de
coleta.

IDs nativos são reservados e seus artefatos são comparados com os pacotes
oficiais. O catálogo fornece `ETag`; instalar, atualizar, ativar, desativar,
fazer rollback, restaurar ou remover exige a revisão atual em `If-Match`.

## Ciclo de vida

A aba Personagens permite validar, instalar, ativar, desativar, exportar,
atualizar, fazer rollback e remover. A remoção é recusada quando o ID aparece em
gatilhos ativos, falas por personagem ou grupos alcançados por esses gatilhos;
grupos declarados mas não utilizados não bloqueiam a operação. Na inicialização,
os nativos são apenas verificados/reparados, preservando versão ativa e estado
habilitado. A ação explícita `Restaurar nativos` também retorna os quatro ao
estado oficial. Reparos usam quarentena e rollback para não deixar registry e
arquivos divergentes.

Comportamentos e falas de pacotes ativos são compostos em memória pela API
`/api/behaviors/v1/effective`. IDs recebem namespace `pkg_<personagem>_`; o
arquivo oficial `web/config/sprite-behaviors.json` não é regravado.
`/api/behaviors/v1/effective/diagnostics` expõe revisão, pacotes aceitos e
eventuais rejeições sem alterar o contrato consumido pelo motor.

## Migração 4.2/4.3

Os IDs nativos permanecem `explorer`, `wizard`, `mechanic` e `orb`. Seletores
legados string são aceitos na importação e convertidos para:

```json
{ "kind": "id", "value": "explorer" }
```

O formato 5.0 também aceita `auto`, `group`, `tag`, `personality` e
`capability`. Assets PNG legados continuam como último fallback quando um
manifesto ou estado não pode ser carregado.
