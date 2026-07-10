$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

Write-Host "Codex Usage Monitor - preparação sem VENV" -ForegroundColor Cyan
Write-Host "Este script não instala pacotes e não altera o Python da máquina."
Write-Host ""

& "$ScriptDir\validate_environment.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "Validação do ambiente falhou."
}

& "$ScriptDir\test.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "Validações do projeto falharam."
}

Write-Host ""
Write-Host "Preparação concluída com o Python e as bibliotecas já instaladas na máquina." -ForegroundColor Green
Write-Host "Próximo passo: .\scripts\start_cdp_edge.ps1"
