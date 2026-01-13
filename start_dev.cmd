@echo off
setlocal
set ROOT=%~dp0
set EXTRA=
echo %* | findstr /I /C:"-StartLlama" >nul
if errorlevel 1 set EXTRA=-StartLlama
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\run_dev.ps1" %EXTRA% %*
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo.
  echo start_dev failed with exit code %CODE%
  echo.
  pause
)
endlocal
exit /b %CODE%
