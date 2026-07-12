param(
    [string] $OutputPath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git não encontrado no PATH."
}

$InsideRepository = (& git rev-parse --is-inside-work-tree 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $InsideRepository -ne "true") {
    throw "A pasta atual não é um repositório Git válido."
}

$Pending = (& git status --porcelain)
if ($LASTEXITCODE -ne 0) {
    throw "Não foi possível consultar o status do Git."
}
if ($Pending) {
    throw "O worktree possui alterações pendentes. Faça commit antes de gerar o pacote seguro."
}

if (-not $OutputPath) {
    $OutputPath = Join-Path (Split-Path -Parent $ProjectRoot) "Codex_Usage-source.zip"
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$OutputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

if (Test-Path $OutputPath) {
    Remove-Item -Force $OutputPath
}

& git archive --format=zip --output=$OutputPath HEAD
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $OutputPath)) {
    throw "Falha ao gerar o pacote pelo git archive."
}

Write-Host "Pacote seguro criado:" -ForegroundColor Green
Write-Host $OutputPath
Write-Host "Somente arquivos versionados no commit atual foram incluídos."
