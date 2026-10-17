@echo off
setlocal EnableExtensions
title CardArts Stopper

echo ============================================
echo   CardArts stopper
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
set "RC=%errorlevel%"

echo.
if "%RC%"=="0" (
    echo [DONE] All CardArts services stopped.
) else (
    echo [WARN] Port 8000 / 5173 is still in use, please check manually.
)
ping -n 6 127.0.0.1 >nul
exit /b %RC%
