$procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match '-m\s+uvicorn\s+app\.main:app' }
if ($procs) {
    foreach ($p in $procs) {
        Write-Host "Termino il server OpenSegments (PID $($p.ProcessId))..."
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Server fermato."
} else {
    Write-Host "Nessun server OpenSegments in esecuzione."
}
