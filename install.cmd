@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo Installation failed. Review the error above.
  pause
  exit /b 1
)
echo Installation complete. Start a new Codex session.
pause
