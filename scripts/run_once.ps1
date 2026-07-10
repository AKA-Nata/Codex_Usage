. "$PSScriptRoot\_common.ps1"
& $VenvPython ".\rpa_codex_usage_edge.py"
if ($LASTEXITCODE -ne 0) { throw "Coleta falhou com código $LASTEXITCODE." }
