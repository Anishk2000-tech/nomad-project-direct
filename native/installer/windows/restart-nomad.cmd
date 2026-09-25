@echo off
rem Restart the Project NOMAD Windows service (asks for administrator rights).
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo Restarting Project NOMAD...
"%~dp0service\ProjectNOMAD.exe" restart
echo Waiting for the dashboard to come back...
"%~dp0runtime\node\node.exe" "%~dp0native\launcher\nomadctl.mjs" wait --install-dir "%~dp0." --timeout 240
if not errorlevel 1 start "" http://localhost:8080
pause
