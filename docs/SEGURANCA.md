# Seguranca

O perfil `runtime/edge-cdp-profile` pode conter cookies e sessao. Ele fica fora
do Git e nao deve ser compartilhado.

O Edge e iniciado com a depuracao vinculada a `127.0.0.1`. Mesmo assim, qualquer
processo local que alcance essa porta pode controlar a aba autenticada. Feche o
Edge dedicado quando nao estiver usando o monitor.

O painel tambem escuta somente no loopback por padrao. Nao habilite acesso remoto
sem autenticacao, firewall e uma necessidade explicita.
