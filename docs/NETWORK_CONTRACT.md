# Contrato observado

A pagina de Analytics atualmente solicita um endpoint interno de uso, como:

```text
GET /backend-api/wham/usage
```

O monitor usa apenas percentuais, duracao da janela e horario de reset. As
janelas sao classificadas por duracao: `18000` segundos para 5 horas e `604800`
segundos para o limite semanal.

Esse endpoint nao e uma API publica estavel. Se ele mudar, o monitor tenta ler
os cards visiveis da pagina antes de registrar a falha.
