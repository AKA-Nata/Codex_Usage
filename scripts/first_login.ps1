. "$PSScriptRoot\_common.ps1"
& $VenvPython ".\rpa_codex_usage_edge.py" --login
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
