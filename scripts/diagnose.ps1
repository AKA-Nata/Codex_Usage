. "$PSScriptRoot\_common.ps1"

Write-Host "Projeto: $ProjectRoot"
Write-Host "Origem do Python: $SystemPythonLabel"
Write-Host "Python: $(Get-SystemPythonDescription)"

Write-Host ""
Write-Host "Bibliotecas instaladas:"
$DependencyReport = @'
import importlib.metadata as metadata

for name in ("websocket-client", "psutil", "tzdata"):
    try:
        print(f"{name}: {metadata.version(name)}")
    except metadata.PackageNotFoundError:
        print(f"{name}: AUSENTE")
'@
Invoke-SystemPython -Arguments @("-c", $DependencyReport)

$Edge = @(
    (Get-Command "msedge.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($Edge) {
    Write-Host "Edge: $Edge"
}
else {
    Write-Host "Edge não localizado." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Saúde da coleta:"
if (Test-Path ".\data\collector-health.json") {
    Get-Content ".\data\collector-health.json"
}
else {
    Write-Host "Arquivo ainda não criado."
}

Write-Host ""
Write-Host "Últimos logs:"
if (Test-Path ".\logs\collector.log") {
    Get-Content ".\logs\collector.log" -Tail 25
}
else {
    Write-Host "Nenhum log disponível."
}
