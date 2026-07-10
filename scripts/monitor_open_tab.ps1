. "$PSScriptRoot\_common.ps1"
& $VenvPython "-m" "codex_usage.cdp_monitor" "--watch"
if ($LASTEXITCODE -ne 0) { throw "Monitor CDP encerrou com codigo $LASTEXITCODE." }
