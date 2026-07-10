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
        throw "Python 3 não encontrado no PATH. Instale Python 3.11 ou superior."
    }
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar Python." }
}

Invoke-BootstrapPython -Arguments @("-c", "import sys; assert sys.version_info >= (3, 11), 'Python 3.11+ obrigatório'; print(sys.version)")

if (-not (Test-Path ".venv")) {
    Invoke-BootstrapPython -Arguments @("-m", "venv", ".venv")
}

$Python = ".\.venv\Scripts\python.exe"
& $Python -m pip install --upgrade pip
& $Python -m pip install -r requirements.txt

# Edge instalado é a opção principal; Chromium é instalado apenas como fallback.
& $Python -m playwright install chromium

& $Python -m unittest discover -s tests -v

Write-Host ""
Write-Host "Instalação concluída." -ForegroundColor Green
Write-Host "Próximo passo: .\scripts\first_login.ps1"
