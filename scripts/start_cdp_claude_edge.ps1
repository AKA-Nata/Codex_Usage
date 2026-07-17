$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_common.ps1"

$Config = Get-Content ".\config.json" -Raw | ConvertFrom-Json
$Claude = $Config.providers.claude
$Cdp = $Claude.cdp
$Port = if ($Cdp.port) { [int]$Cdp.port } else { 9223 }
$ProfileRelative = if ($Cdp.profile_dir) { $Cdp.profile_dir } else { "runtime\claude-cdp-profile" }
$Profile = Join-Path $ProjectRoot $ProfileRelative
$Url = if ($Cdp.usage_url) { $Cdp.usage_url } else { "https://claude.ai/settings/usage" }
$Candidates = @((Get-Command msedge.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue), "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { $_ -and (Test-Path $_) }
if (-not $Candidates) { throw "Microsoft Edge nao foi encontrado." }
New-Item -ItemType Directory -Force -Path $Profile | Out-Null
$Arguments = @("--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$Port", "--remote-allow-origins=http://127.0.0.1:$Port", "--user-data-dir=$Profile", "--no-first-run", $Url)
Start-Process -FilePath $Candidates[0] -ArgumentList $Arguments
Write-Host "Edge CDP do Claude aberto em http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "Faça login nessa janela dedicada. A coleta observa apenas dados de uso; contratos internos observados não são API pública estável."
