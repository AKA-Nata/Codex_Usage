# Contrato de rede observado

Endpoint atualmente utilizado pela tela:

```text
GET /backend-api/wham/usage
```

Campos consumidos:

```json
{
  "rate_limit": {
    "allowed": false,
    "limit_reached": true,
    "primary_window": {
      "used_percent": 86,
      "limit_window_seconds": 18000,
      "reset_after_seconds": 14289,
      "reset_at": 1783632670
    },
    "secondary_window": {
      "used_percent": 100,
      "limit_window_seconds": 604800,
      "reset_after_seconds": 347910,
      "reset_at": 1783966291
    }
  }
}
```

O coletor ignora deliberadamente campos de e-mail, identificadores de conta, créditos e controle de gastos.

Este é um endpoint interno da aplicação web e não constitui API pública estável. A implementação trata mudanças de contrato com:

1. aliases de nomes de propriedades;
2. busca recursiva por janelas compatíveis;
3. classificação por `limit_window_seconds`;
4. fallback visual.
