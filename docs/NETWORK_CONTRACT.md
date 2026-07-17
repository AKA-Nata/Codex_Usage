# Contratos observados multi-provider

## Claude

Claude é coletado somente pela sessão local dedicada via CDP; endpoints internos
eventualmente observados não são API pública estável. DOM é fallback. A CLI só
informa disponibilidade/autenticação: ela não fornece telemetria de consumo e
nenhum percentual é inferido.

## Codex

A pagina de Analytics atualmente solicita um endpoint interno de uso, como:

```text
GET /backend-api/wham/usage
```

O monitor usa apenas percentuais, duracao da janela e horario de reset. As
janelas sao classificadas por duracao: `18000` segundos para 5 horas e `604800`
segundos para o limite semanal.

Esse endpoint nao e uma API publica estavel. Se ele mudar, o monitor tenta ler
os cards visiveis da pagina antes de registrar a falha.
