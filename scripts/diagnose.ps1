. "$PSScriptRoot\_common.ps1"

Write-Host "Projeto: $ProjectRoot"
Write-Host "Python: $VenvPython"
& $VenvPython --version

$Edge = Get-Command "msedge.exe" -ErrorAction SilentlyContinue
if ($Edge) {
    Write-Host "Edge: $($Edge.Source)"
} else {
    Write-Host "Edge não localizado no PATH; o Playwright ainda pode localizar o canal msedge." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Saúde da coleta:"
if (Test-Path ".\data\collector-health.json") {
    Get-Content ".\data\collector-health.json"
} else {
    Write-Host "Arquivo ainda não criado."
}

Write-Host ""
Write-Host "Últimos logs:"
if (Test-Path ".\logs\collector.log") {
    Get-Content ".\logs\collector.log" -Tail 25
} else {
    Write-Host "Nenhum log disponível."
}

Write-Host ""
$Task = Get-ScheduledTask -TaskName "Codex Usage Reset RPA" -ErrorAction SilentlyContinue
if ($Task) {
    Write-Host "Tarefa agendada: $($Task.State)"
} else {
    Write-Host "Tarefa agendada: não instalada"
}
