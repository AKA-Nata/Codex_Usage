$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_common.ps1"

$Config = Get-Content ".\config.json" -Raw | ConvertFrom-Json
$Cdp = $Config.cdp_monitor
$Port = if ($Cdp.port) { [int]$Cdp.port } else { 9222 }
$ProfileRelative = if ($Cdp.profile_dir) { $Cdp.profile_dir } else { "runtime\edge-cdp-profile" }
$Profile = Join-Path $ProjectRoot $ProfileRelative
$Url = $Config.codex_usage_url

$Candidates = @(
    @(
        (Get-Command msedge.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }
)
if (-not $Candidates) { throw "Microsoft Edge nao foi encontrado." }

New-Item -ItemType Directory -Force -Path $Profile | Out-Null
$Arguments = @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=http://127.0.0.1:$Port",
    "--user-data-dir=$Profile",
    "--no-first-run",
    $Url
)
Start-Process -FilePath $Candidates[0] -ArgumentList $Arguments
Write-Host "Edge CDP aberto em http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "Faca login nessa janela e conclua qualquer verificacao humana. Depois mantenha a aba de Analytics aberta."
