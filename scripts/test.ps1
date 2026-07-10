. "$PSScriptRoot\_common.ps1"

Write-Host "Python: $(Get-SystemPythonDescription)" -ForegroundColor Cyan

Invoke-SystemPython -Arguments @("-m", "compileall", "-q", "codex_usage", "dashboard_server.py")
if ($script:LastPythonExitCode -ne 0) {
    throw "Falha no compileall."
}

Invoke-SystemPython -Arguments @("-m", "unittest", "discover", "-s", "tests", "-v")
if ($script:LastPythonExitCode -ne 0) {
    throw "Testes Python falharam."
}

if (Get-Command node -ErrorAction SilentlyContinue) {
    & node --check web/app.js
    if ($LASTEXITCODE -ne 0) {
        throw "Falha de sintaxe em web/app.js."
    }

    & node --check web/sprite-engine.js
    if ($LASTEXITCODE -ne 0) {
        throw "Falha de sintaxe em web/sprite-engine.js."
    }
}
else {
    Write-Host "Node.js não encontrado; validação sintática JavaScript ignorada." -ForegroundColor Yellow
}

Write-Host "Validações concluídas usando exclusivamente o Python da máquina." -ForegroundColor Green
