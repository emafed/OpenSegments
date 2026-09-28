@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Creazione ambiente virtuale...
  py -3 -m venv .venv
  if errorlevel 1 goto :error
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  if errorlevel 1 goto :error
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto :error
)

".venv\Scripts\python.exe" -c "import garminconnect" >nul 2>&1
if errorlevel 1 (
  echo Installazione delle dipendenze per Garmin Connect...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto :error
)

start "" http://127.0.0.1:8000
echo.
echo OpenSegments in avvio su http://127.0.0.1:8000
echo Per fermare il server premi CTRL+C in questa finestra.
echo.
".venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
echo.
echo Il server e' stato fermato.
goto :end

:error
echo.
echo ERRORE durante la preparazione dell'ambiente. Controlla i messaggi sopra.

:end
echo.
echo Premi un tasto per chiudere questa finestra...
pause >nul
endlocal
