$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

function Resolve-SystemPython {
    $Candidates = @()

    if ($env:CODEX_USAGE_PYTHON) {
        $Candidates += [PSCustomObject]@{
            Executable = $env:CODEX_USAGE_PYTHON
            PrefixArgs = @()
            Label = "CODEX_USAGE_PYTHON"
        }
    }

    $PyCommand = Get-Command "py.exe" -ErrorAction SilentlyContinue
    if (-not $PyCommand) {
        $PyCommand = Get-Command "py" -ErrorAction SilentlyContinue
    }
    if ($PyCommand) {
        $Candidates += [PSCustomObject]@{
            Executable = $PyCommand.Source
            PrefixArgs = @("-3")
            Label = "Python Launcher (py -3)"
        }
    }

    $PythonCommand = Get-Command "python.exe" -ErrorAction SilentlyContinue
    if (-not $PythonCommand) {
        $PythonCommand = Get-Command "python" -ErrorAction SilentlyContinue
    }
    if ($PythonCommand) {
        $Candidates += [PSCustomObject]@{
            Executable = $PythonCommand.Source
            PrefixArgs = @()
            Label = "python"
        }
    }

    $Python3Command = Get-Command "python3.exe" -ErrorAction SilentlyContinue
    if (-not $Python3Command) {
        $Python3Command = Get-Command "python3" -ErrorAction SilentlyContinue
    }
    if ($Python3Command) {
        $Candidates += [PSCustomObject]@{
            Executable = $Python3Command.Source
            PrefixArgs = @()
            Label = "python3"
        }
    }

    foreach ($Candidate in $Candidates) {
        try {
            $Probe = & $Candidate.Executable @($Candidate.PrefixArgs) -c `
                "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 4)" 2>$null

            if ($LASTEXITCODE -eq 0) {
                return $Candidate
            }
        }
        catch {
            # Tenta o próximo runtime disponível.
        }
    }

    throw @"
Python 3.11 ou superior não foi localizado.

O projeto não cria VENV e não instala Python.
Instale/configure o Python corporativo da máquina ou defina:

  `$env:CODEX_USAGE_PYTHON = "C:\Caminho\python.exe"

Depois execute novamente o script.
"@
}

$SystemPythonRuntime = Resolve-SystemPython
$SystemPythonExe = $SystemPythonRuntime.Executable
$SystemPythonPrefixArgs = @($SystemPythonRuntime.PrefixArgs)
$SystemPythonLabel = $SystemPythonRuntime.Label
$script:LastPythonExitCode = 0

function ConvertTo-SystemPythonCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Code
    )

    # O Windows PowerShell 5.1 remove aspas internas de argumentos enviados a
    # executaveis nativos. Codificar o codigo evita que `python -c` receba um
    # programa alterado pelo parser de argumentos do PowerShell.
    $EncodedCode = [Convert]::ToBase64String(
        [System.Text.Encoding]::UTF8.GetBytes($Code)
    )
    return "import base64; exec(base64.b64decode('$EncodedCode'))"
}

function Invoke-SystemPython {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $false)]
        [string[]] $Arguments = @()
    )

    $EffectiveArguments = @($Arguments)
    if ($EffectiveArguments.Count -ge 2 -and $EffectiveArguments[0] -eq "-c") {
        $EncodedCommand = ConvertTo-SystemPythonCommand -Code $EffectiveArguments[1]
        $TrailingArguments = @()
        if ($EffectiveArguments.Count -gt 2) {
            $TrailingArguments = @($EffectiveArguments[2..($EffectiveArguments.Count - 1)])
        }
        $EffectiveArguments = @("-c", $EncodedCommand) + $TrailingArguments
    }

    & $SystemPythonExe @SystemPythonPrefixArgs @EffectiveArguments
    $script:LastPythonExitCode = $LASTEXITCODE
}

function Get-SystemPythonDescription {
    $DescriptionCommand = ConvertTo-SystemPythonCommand -Code `
        "import sys; print(f'{sys.executable} | Python {sys.version.split()[0]}')"
    $Description = & $SystemPythonExe @SystemPythonPrefixArgs -c $DescriptionCommand

    if ($LASTEXITCODE -ne 0) {
        throw "Não foi possível consultar o Python selecionado."
    }

    return ($Description | Out-String).Trim()
}

function Assert-SystemPythonDependencies {
    $DependencyProbe = @'
import importlib.util
import sys

required = {
    "websocket": "websocket-client",
    "psutil": "psutil",
    "tzdata": "tzdata",
}

missing = [
    package_name
    for module_name, package_name in required.items()
    if importlib.util.find_spec(module_name) is None
]

if missing:
    print("Bibliotecas ausentes no Python da máquina: " + ", ".join(missing))
    sys.exit(5)
'@

    $EncodedProbe = ConvertTo-SystemPythonCommand -Code $DependencyProbe
    $ProbeOutput = & $SystemPythonExe @SystemPythonPrefixArgs -c $EncodedProbe 2>&1
    $ProbeExitCode = $LASTEXITCODE

    if ($ProbeExitCode -ne 0) {
        $Details = ($ProbeOutput | Out-String).Trim()
        throw @"
O Python foi encontrado, mas não possui todas as bibliotecas exigidas.

$Details

Este projeto não cria ambiente virtual e não executa pip.
As bibliotecas devem estar previamente instaladas no mesmo Python selecionado.
Use CODEX_USAGE_PYTHON para apontar para outro Python já preparado.
"@
    }
}

Assert-SystemPythonDependencies
