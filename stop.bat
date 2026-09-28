@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-server.ps1"
echo.
echo Premi un tasto per chiudere questa finestra...
pause >nul
endlocal
