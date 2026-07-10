. "$PSScriptRoot\_common.ps1"

Write-Host "Projeto: $ProjectRoot"
Write-Host "Python: $VenvPython"
& $VenvPython --version

$Edge = @(
    (Get-Command "msedge.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($Edge) {
    Write-Host "Edge: $Edge"
} else {
    Write-Host "Edge nao localizado." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Saude da coleta:"
if (Test-Path ".\data\collector-health.json") {
    Get-Content ".\data\collector-health.json"
} else {
    Write-Host "Arquivo ainda nao criado."
}

Write-Host ""
Write-Host "Ultimos logs:"
if (Test-Path ".\logs\collector.log") {
    Get-Content ".\logs\collector.log" -Tail 25
} else {
    Write-Host "Nenhum log disponivel."
}
