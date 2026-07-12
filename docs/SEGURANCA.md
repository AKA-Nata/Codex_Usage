# Seguranca

O perfil `runtime/edge-cdp-profile` pode conter cookies e sessao. Ele fica fora
do Git e nao deve ser compartilhado.

O Edge e iniciado com a depuracao vinculada a `127.0.0.1`. Mesmo assim, qualquer
processo local que alcance essa porta pode controlar a aba autenticada. Feche o
Edge dedicado quando nao estiver usando o monitor.

O painel tambem escuta somente no loopback por padrao. Nao habilite acesso remoto
sem autenticacao, firewall e uma necessidade explicita.

## Studio de comportamentos

As mutações do Studio são aceitas somente pelas rotas `/api/studio/*` e usam:

- caminhos fixos para configuração e schema, sem caminho fornecido pelo
  cliente;
- `Host` de loopback e `Origin` correspondente quando presente;
- `Content-Type: application/json` e limite de 1 MB;
- validação do JSON Schema e das referências de macros/falas antes da escrita;
- revisão SHA-256 para impedir sobrescrita silenciosa entre duas abas;
- backup anterior e substituição atômica do arquivo oficial.

Backups e histórico ficam em `runtime/behavior-studio`, que é ignorado pelo Git
e não é servido pelo dashboard. A referência padrão restaurável é o arquivo
versionado `web/config/sprite-behaviors.default.json`. O histórico aplica uma
lista explícita de campos e limites de tamanho. Contexto bruto, cookies,
headers, tokens, URLs CDP e caminhos do perfil Edge não são aceitos nem
retornados.

## Empacotamento seguro

Não use `Compress-Archive` sobre a raiz inteira do projeto. Esse procedimento pode
incluir `.git`, perfis do Edge, cookies, histórico, logs e JSONs operacionais.

Depois de validar e criar o commit, gere o pacote com:

```powershell
.\scripts\package_source.ps1
```

O script exige worktree limpo e usa `git archive HEAD`, incluindo somente
arquivos versionados no commit atual.
