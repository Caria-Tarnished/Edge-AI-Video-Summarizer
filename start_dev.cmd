@echo off
setlocal
set ROOT=%~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\run_dev.ps1" %*
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo.
  echo start_dev failed with exit code %CODE%
  echo.
  pause
)
endlocal
exit /b %CODE%
