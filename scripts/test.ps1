. "$PSScriptRoot\_common.ps1"
& $VenvPython -m compileall -q codex_usage dashboard_server.py
if ($LASTEXITCODE -ne 0) { throw "Falha no compileall." }
& $VenvPython -m unittest discover -s tests -v
if ($LASTEXITCODE -ne 0) { throw "Testes falharam." }
