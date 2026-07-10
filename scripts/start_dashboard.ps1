. "$PSScriptRoot\_common.ps1"

Invoke-SystemPython -Arguments @(".\dashboard_server.py", "--open")

if ($script:LastPythonExitCode -ne 0) {
    throw "Dashboard encerrou com código $script:LastPythonExitCode."
}
