. "$PSScriptRoot\_common.ps1"
& $VenvPython ".\tools\create_browser_bridge_token.py" @args
if ($LASTEXITCODE -ne 0) { throw "Nao foi possivel criar o token da extensao." }
