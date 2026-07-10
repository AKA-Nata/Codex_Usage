$ErrorActionPreference = "Stop"
& "$PSScriptRoot\install.ps1"
& "$PSScriptRoot\first_login.ps1"
& "$PSScriptRoot\run_once.ps1"
Write-Host ""
Write-Host "Coleta inicial concluída. Abrindo o painel..." -ForegroundColor Green
& "$PSScriptRoot\start_dashboard.ps1"
