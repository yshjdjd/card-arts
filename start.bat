@echo off
setlocal EnableExtensions
title CardArts Launcher
cd /d "%~dp0"

set "BACKEND_PORT=8000"
set "FRONTEND_PORT=5173"
set "FRONTEND_URL=http://127.0.0.1:%FRONTEND_PORT%"
set "BACKEND_DOCS=http://127.0.0.1:%BACKEND_PORT%/docs"

echo ============================================
echo   CardArts launcher
echo ============================================
echo.

rem ---- prerequisites ----
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] python not found in PATH. Install Python 3 first.
    pause
    exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found in PATH. Install Node.js first.
    pause
    exit /b 1
)

python -c "import fastapi, uvicorn" >nul 2>nul
if errorlevel 1 (
    echo [DEPS] Installing backend dependencies...
    python -m pip install -r "backend\requirements.txt"
    if errorlevel 1 (
        echo [ERROR] Backend dependency install failed.
        pause
        exit /b 1
    )
)

if not exist "frontend\node_modules" (
    echo [DEPS] Installing frontend dependencies, this may take a while...
    call npm --prefix "frontend" install
    if errorlevel 1 (
        echo [ERROR] Frontend dependency install failed.
        pause
        exit /b 1
    )
)

rem ---- backend ----
call :check_port %BACKEND_PORT%
if %errorlevel%==0 (
    echo [SKIP] Backend already listening on port %BACKEND_PORT%.
) else (
    echo [START] Backend FastAPI on port %BACKEND_PORT% ...
    start "CardArts Backend" cmd /k "python -m uvicorn app.main:app --app-dir backend --reload --host 127.0.0.1 --port %BACKEND_PORT%"
)

rem ---- frontend ----
call :check_port %FRONTEND_PORT%
if %errorlevel%==0 (
    echo [SKIP] Frontend already listening on port %FRONTEND_PORT%.
) else (
    echo [START] Frontend Vite on port %FRONTEND_PORT% ...
    start "CardArts Frontend" cmd /k "npm --prefix frontend run dev -- --host 127.0.0.1 --port %FRONTEND_PORT%"
)

rem ---- wait for backend ----
set /a WAIT_N=0
:wait_backend
call :check_port %BACKEND_PORT%
if %errorlevel%==0 goto backend_ready
set /a WAIT_N+=1
if %WAIT_N% geq 30 goto backend_slow
ping -n 2 127.0.0.1 >nul
goto wait_backend
:backend_slow
echo [WARN] Backend is slow to start, check the "CardArts Backend" window.
:backend_ready

rem ---- wait for frontend ----
set /a WAIT_N=0
:wait_frontend
call :check_port %FRONTEND_PORT%
if %errorlevel%==0 goto frontend_ready
set /a WAIT_N+=1
if %WAIT_N% geq 30 goto frontend_slow
ping -n 2 127.0.0.1 >nul
goto wait_frontend
:frontend_slow
echo [WARN] Frontend is slow to start, check the "CardArts Frontend" window.
:frontend_ready

if /i "%CARDARTS_NO_BROWSER%"=="1" goto no_browser
start "" "%FRONTEND_URL%"
:no_browser

echo.
echo Ready:
echo   frontend  %FRONTEND_URL%
echo   backend   %BACKEND_DOCS%
echo.
echo To stop everything, double-click stop.bat.
ping -n 6 127.0.0.1 >nul
exit /b 0

rem ---- subroutine: port is in LISTENING state (errorlevel 0 = busy) ----
:check_port
netstat -ano | findstr /C:":%~1" | findstr /C:"LISTENING" >nul 2>nul
exit /b %errorlevel%
