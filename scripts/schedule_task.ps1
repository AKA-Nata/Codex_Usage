param(
    [ValidateRange(5, 1440)]
    [int]$Minutes = 15
)

. "$PSScriptRoot\_common.ps1"

$TaskName = "Codex Usage Reset RPA"
$Collector = Join-Path $ProjectRoot "rpa_codex_usage_edge.py"
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$Action = New-ScheduledTaskAction `
    -Execute $VenvPython `
    -Argument "`"$Collector`"" `
    -WorkingDirectory $ProjectRoot

$RepeatTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $Minutes)

$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
    -MultipleInstances IgnoreNew

$Principal = New-ScheduledTaskPrincipal `
    -UserId $CurrentUser `
    -LogonType Interactive `
    -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger @($RepeatTrigger, $LogonTrigger) `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Atualiza os resets de uso do Codex sem expor cookies ou tokens." | Out-Null

Write-Host "Agendamento criado: $TaskName" -ForegroundColor Green
Write-Host "Intervalo: $Minutes minutos"
Write-Host "Execução: somente na sessão interativa do usuário $CurrentUser"
