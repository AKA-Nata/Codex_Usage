. "$PSScriptRoot\_common.ps1"

$PythonArguments = @("-m", "codex_usage.cdp_monitor") + @($args)
Invoke-SystemPython -Arguments $PythonArguments

if ($script:LastPythonExitCode -ne 0) {
    throw "Coleta CDP falhou com código $script:LastPythonExitCode."
}
