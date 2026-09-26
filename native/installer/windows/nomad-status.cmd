@echo off
rem Show the status of Project NOMAD and its apps (asks for administrator rights, because the
rem NOMAD configuration folder is readable by administrators only).
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
"%~dp0runtime\node\node.exe" "%~dp0native\launcher\nomadctl.mjs" status --install-dir "%~dp0."
echo.
pause
