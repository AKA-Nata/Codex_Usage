. "$PSScriptRoot\_common.ps1"
& $VenvPython "-m" "codex_usage.cdp_monitor" @args
if ($LASTEXITCODE -ne 0) { throw "Coleta CDP falhou com codigo $LASTEXITCODE." }
