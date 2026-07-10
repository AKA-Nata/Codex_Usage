$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

function Invoke-BootstrapPython {
    param([string[]]$Arguments)
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3 @Arguments
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        & python @Arguments
    } else {
        throw "Python 3 nao encontrado no PATH. Instale Python 3.11 ou superior."
    }
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar Python." }
}

Invoke-BootstrapPython -Arguments @("-c", "import sys; assert sys.version_info >= (3, 11), 'Python 3.11+ obrigatorio'; print(sys.version)")

if (-not (Test-Path ".venv")) {
    Invoke-BootstrapPython -Arguments @("-m", "venv", ".venv")
}

$Python = ".\.venv\Scripts\python.exe"
& $Python -m pip install --upgrade pip
& $Python -m pip install -r requirements.txt
& $Python -m unittest discover -s tests -v
if ($LASTEXITCODE -ne 0) { throw "Testes falharam." }

Write-Host ""
Write-Host "Instalacao concluida." -ForegroundColor Green
Write-Host "Proximo passo: .\scripts\start_cdp_edge.ps1"
