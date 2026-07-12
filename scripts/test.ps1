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
    $JavaScriptFiles = @(
        "web/app.js",
        "web/behavior-studio-model.js",
        "web/behavior-studio.js",
        "web/sprite-engine.js",
        "web/sprite-reaction-engine.js"
    )

    foreach ($JavaScriptFile in $JavaScriptFiles) {
        & node --check $JavaScriptFile
        if ($LASTEXITCODE -ne 0) {
            throw "Falha de sintaxe em $JavaScriptFile."
        }
    }

    & node --test tests/js/sprite-reaction-engine.node.test.mjs
    if ($LASTEXITCODE -ne 0) {
        throw "Testes JavaScript do motor de reações falharam."
    }
}
else {
    Write-Host "Node.js não encontrado; executando a mesma suíte no Edge." -ForegroundColor Yellow
    & (Join-Path $ProjectRoot "tests\js\run-edge-tests.ps1")
}

Write-Host "Validações concluídas sem criar VENV ou instalar dependências." -ForegroundColor Green
