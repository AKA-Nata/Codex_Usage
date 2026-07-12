# Seguranca

O perfil `runtime/edge-cdp-profile` pode conter cookies e sessao. Ele fica fora
do Git e nao deve ser compartilhado.

O Edge e iniciado com a depuracao vinculada a `127.0.0.1`. Mesmo assim, qualquer
processo local que alcance essa porta pode controlar a aba autenticada. Feche o
Edge dedicado quando nao estiver usando o monitor.

O painel tambem escuta somente no loopback por padrao. Nao habilite acesso remoto
sem autenticacao, firewall e uma necessidade explicita.

## Empacotamento seguro

Não use `Compress-Archive` sobre a raiz inteira do projeto. Esse procedimento pode
incluir `.git`, perfis do Edge, cookies, histórico, logs e JSONs operacionais.

Depois de validar e criar o commit, gere o pacote com:

```powershell
.\scripts\package_source.ps1
```

O script exige worktree limpo e usa `git archive HEAD`, incluindo somente
arquivos versionados no commit atual.
