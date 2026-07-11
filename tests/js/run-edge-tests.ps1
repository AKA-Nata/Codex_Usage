[CmdletBinding()]
param(
    [int] $Port = 0,
    [string] $EdgePath = ""
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TempRoot = [IO.Path]::GetFullPath($env:TEMP)
$Token = [guid]::NewGuid().ToString("N")
$ProfilePath = Join-Path $TempRoot "codex-usage-edge-tests-$Token"
$DomPath = Join-Path $TempRoot "codex-usage-edge-tests-$Token.html"
$EdgeLogPath = Join-Path $TempRoot "codex-usage-edge-tests-$Token.log"
$ServerOutPath = Join-Path $TempRoot "codex-usage-edge-server-$Token.out.log"
$ServerErrPath = Join-Path $TempRoot "codex-usage-edge-server-$Token.err.log"
$ServerProcess = $null

function Resolve-TestPython {
    if ($env:CODEX_USAGE_PYTHON) {
        return [PSCustomObject]@{ Executable = $env:CODEX_USAGE_PYTHON; PrefixArgs = @() }
    }

    $Py = Get-Command "py.exe" -ErrorAction SilentlyContinue
    if (-not $Py) { $Py = Get-Command "py" -ErrorAction SilentlyContinue }
    if ($Py) {
        return [PSCustomObject]@{ Executable = $Py.Source; PrefixArgs = @("-3") }
    }

    $Python = Get-Command "python.exe" -ErrorAction SilentlyContinue
    if (-not $Python) { $Python = Get-Command "python" -ErrorAction SilentlyContinue }
    if ($Python) {
        return [PSCustomObject]@{ Executable = $Python.Source; PrefixArgs = @() }
    }

    throw "Python 3 não encontrado para servir o runner HTML no loopback."
}

function Resolve-TestEdge {
    if ($EdgePath) {
        if (-not (Test-Path -LiteralPath $EdgePath -PathType Leaf)) {
            throw "Microsoft Edge não encontrado em $EdgePath."
        }
        return (Resolve-Path -LiteralPath $EdgePath).Path
    }

    $Candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
    )
    $Resolved = $Candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $Resolved) {
        throw "Microsoft Edge não encontrado para executar os testes JavaScript."
    }
    return $Resolved
}

function Resolve-FreePort {
    if ($Port -gt 0) { return $Port }
    $Listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $Listener.Start()
        return ([Net.IPEndPoint] $Listener.LocalEndpoint).Port
    }
    finally {
        $Listener.Stop()
    }
}

function Remove-TemporaryProfile {
    if (-not (Test-Path -LiteralPath $ProfilePath)) { return }
    $ResolvedProfile = [IO.Path]::GetFullPath($ProfilePath)
    $TempPrefix = $TempRoot.TrimEnd("\") + "\"
    $SafeName = (Split-Path -Leaf $ResolvedProfile) -like "codex-usage-edge-tests-*"
    if (-not $SafeName -or -not $ResolvedProfile.StartsWith($TempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Recusa ao remover perfil temporário fora do diretório esperado: $ResolvedProfile"
    }
    Remove-Item -LiteralPath $ResolvedProfile -Recurse -Force -ErrorAction SilentlyContinue
}

try {
    $Runtime = Resolve-TestPython
    $ResolvedEdge = Resolve-TestEdge
    $ResolvedPort = Resolve-FreePort
    $RunnerUrl = "http://127.0.0.1:$ResolvedPort/tests/js/sprite-reaction-engine.browser.html"
    $ServerArguments = @($Runtime.PrefixArgs) + @(
        "-m", "http.server", "$ResolvedPort", "--bind", "127.0.0.1"
    )

    $ServerProcess = Start-Process `
        -FilePath $Runtime.Executable `
        -ArgumentList $ServerArguments `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $ServerOutPath `
        -RedirectStandardError $ServerErrPath

    $Ready = $false
    for ($Attempt = 0; $Attempt -lt 50; $Attempt += 1) {
        if ($ServerProcess.HasExited) {
            throw "Servidor HTTP dos testes encerrou antes de ficar disponível."
        }
        try {
            $Response = Invoke-WebRequest -UseBasicParsing -Uri $RunnerUrl -TimeoutSec 1
            if ($Response.StatusCode -eq 200) {
                $Ready = $true
                break
            }
        }
        catch {
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $Ready) {
        throw "Servidor HTTP dos testes não respondeu em $RunnerUrl."
    }

    $EdgeArguments = @(
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--user-data-dir=`"$ProfilePath`"",
        "--virtual-time-budget=5000",
        "--dump-dom",
        $RunnerUrl
    )
    $EdgeProcess = Start-Process `
        -FilePath $ResolvedEdge `
        -ArgumentList $EdgeArguments `
        -WindowStyle Hidden `
        -Wait `
        -PassThru `
        -RedirectStandardOutput $DomPath `
        -RedirectStandardError $EdgeLogPath

    if ($EdgeProcess.ExitCode -ne 0) {
        throw "Edge encerrou com código $($EdgeProcess.ExitCode)."
    }

    $Dom = Get-Content -Raw -LiteralPath $DomPath
    $Result = [regex]::Match($Dom, '<body[^>]*\sdata-result="([^"]+)"').Groups[1].Value
    $Total = [regex]::Match($Dom, 'data-total="([^"]+)"').Groups[1].Value
    $Failures = [regex]::Match($Dom, 'data-failures="([^"]+)"').Groups[1].Value
    if ($Result -ne "passed") {
        $DetailsMatch = [regex]::Match($Dom, '<pre id="result">([\s\S]*?)</pre>')
        $Details = [Net.WebUtility]::HtmlDecode(($DetailsMatch.Groups[1].Value -replace '<[^>]+>', ''))
        throw "Testes JavaScript no Edge falharam ($Failures/$Total).`n$Details"
    }

    Write-Host "Testes JavaScript no Edge: $Total/$Total passaram." -ForegroundColor Green
}
finally {
    if ($ServerProcess -and -not $ServerProcess.HasExited) {
        Stop-Process -Id $ServerProcess.Id -Force -ErrorAction SilentlyContinue
    }
    @($DomPath, $EdgeLogPath, $ServerOutPath, $ServerErrPath) | ForEach-Object {
        Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue
    }
    Remove-TemporaryProfile
}
