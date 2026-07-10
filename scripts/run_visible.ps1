. "$PSScriptRoot\_common.ps1"
& $VenvPython ".\rpa_codex_usage_edge.py" --headed --verbose
if ($LASTEXITCODE -ne 0) { throw "Coleta visível falhou com código $LASTEXITCODE." }
