. "$PSScriptRoot\_common.ps1"
& $VenvPython ".\rpa_codex_usage_edge.py" --headed --force-dom --verbose
if ($LASTEXITCODE -ne 0) { throw "Teste do fallback DOM falhou com código $LASTEXITCODE." }
