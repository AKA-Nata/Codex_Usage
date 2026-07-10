. "$PSScriptRoot\_common.ps1"

$Description = Get-SystemPythonDescription

Write-Host "Runtime Python da máquina:" -ForegroundColor Cyan
Write-Host "  Origem: $SystemPythonLabel"
Write-Host "  Executável: $Description"

Write-Host ""
Write-Host "Bibliotecas obrigatórias:" -ForegroundColor Cyan

$DependencyReport = @'
import importlib.metadata as metadata
import importlib.util

items = [
    ("websocket", "websocket-client"),
    ("psutil", "psutil"),
    ("tzdata", "tzdata"),
]

for module_name, distribution_name in items:
    spec = importlib.util.find_spec(module_name)
    if spec is None:
        print(f"  [FALHA] {distribution_name}")
        continue

    try:
        version = metadata.version(distribution_name)
    except metadata.PackageNotFoundError:
        version = "versão não identificada"

    print(f"  [OK] {distribution_name} {version}")
'@

Invoke-SystemPython -Arguments @("-c", $DependencyReport)
if ($script:LastPythonExitCode -ne 0) {
    throw "Falha ao validar as bibliotecas instaladas na máquina."
}

Write-Host ""
Write-Host "Ambiente global/sistêmico validado. Nenhuma VENV foi criada." -ForegroundColor Green
