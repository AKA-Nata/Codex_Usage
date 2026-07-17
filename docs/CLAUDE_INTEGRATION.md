# Claude integration

Claude is isolated from Codex. Its dedicated Edge profile uses loopback CDP on `127.0.0.1:9223`; start it with `scripts/start_cdp_claude_edge.ps1`, sign in interactively, and keep the Usage page open.

The collector first observes structured network responses and only then falls back to visible DOM text. It never stores cookies, tokens, authentication headers, or conversation content. Any internal Claude endpoint is an observed contract, not a stable public API.

`claude auth status --json` is used only to detect the installed CLI, version, and safe authentication metadata. The CLI currently does not provide machine-readable usage windows, so CLI-only mode is `unsupported`, never `0%`.
