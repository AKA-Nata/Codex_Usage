@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_once.ps1"
exit /b %ERRORLEVEL%
