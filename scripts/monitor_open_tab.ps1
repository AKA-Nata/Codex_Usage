. "$PSScriptRoot\_common.ps1"

$PythonArguments = @("-m", "codex_usage.cdp_monitor", "--watch") + @($args)
Invoke-SystemPython -Arguments $PythonArguments

if ($script:LastPythonExitCode -ne 0) {
    throw "Monitor CDP encerrou com código $script:LastPythonExitCode."
}
