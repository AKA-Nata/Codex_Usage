# AI usage providers

`/api/providers` lists configured providers and `/api/providers/usage` returns their isolated status and dynamic windows. Individual status and refresh routes are `/api/providers/{provider}/status` and `/api/providers/{provider}/refresh`.

Provider states are `ok`, `stale`, `error`, `unavailable`, `unsupported`, and `disabled`. A provider failure preserves its last valid usage file and never affects the other provider. The dashboard creates a card per returned window; legacy Codex card identifiers remain available to existing sprite rules.
