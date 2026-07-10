# Segurança

## Dados sensíveis

O perfil em `runtime/edge-profile` pode conter cookies e dados de sessão. Ele deve permanecer somente na máquina do usuário.

Nunca versionar ou compartilhar:

- `runtime/`
- arquivos HAR
- cookies
- headers de autorização
- screenshots de debug sem revisão

## Uso da sessão

O login é realizado manualmente uma vez no perfil exclusivo do RPA. As execuções seguintes usam esse perfil em headless.

A chamada interna é executada dentro da página autenticada. O processo Python recebe apenas o JSON de resposta necessário para percentuais e resets; os campos de conta e créditos não são persistidos.

## Painel local

O servidor escuta em `127.0.0.1` por padrão. O endpoint de atualização manual valida a origem da requisição.

Não altere `dashboard.allow_remote` para `true` sem autenticação adicional, firewall e necessidade explícita.

## Extensão de monitoramento

A extensão em `browser_extension/` usa a aba que o usuário já autenticou. Ela
não lê nem exporta cookies, tokens de sessão ou headers de autorização. O
script em contexto principal reduz a resposta a percentuais, resets e flags
antes de entregá-la ao restante da extensão.

`POST /api/ingest` exige o token local criado por
`scripts/create_browser_bridge_token.ps1`. Não exponha o painel ou esse token
na rede; a ponte continua em `127.0.0.1`.

## Edge CDP local

O modo sem extensao requer um Edge aberto por `scripts/start_cdp_edge.ps1`. A
porta de depuracao e acessivel somente em `127.0.0.1`, mas concede controle da
janela e da sessao daquele perfil a processos locais. Use exclusivamente o
perfil isolado `runtime/edge-cdp-profile`, mantenha a porta fora da rede e feche
o Edge quando nao precisar do monitor.

## Debug

Por padrão, artefatos de debug são salvos somente em falhas e possuem retenção limitada. O texto é parcialmente redigido para remover e-mail e identificadores no formato `user-*`.

Screenshots podem conter informações visuais da conta. Revise antes de compartilhar.
