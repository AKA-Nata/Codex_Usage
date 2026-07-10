$TaskName = "Codex Usage Reset RPA"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Agendamento removido: $TaskName" -ForegroundColor Green
} else {
    Write-Host "Agendamento não encontrado: $TaskName"
}
