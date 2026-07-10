. "$PSScriptRoot\_common.ps1"
& $VenvPython ".\dashboard_server.py" --open
if ($LASTEXITCODE -ne 0) { throw "Dashboard encerrou com código $LASTEXITCODE." }
