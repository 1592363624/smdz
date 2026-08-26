@echo off
chcp 65001 >nul
title Shimo3 Launcher

set "ROOT_DIR=%~dp0"

echo ============================================
echo   Shimo3 Web - Starting Servers
echo ============================================
echo.

echo [0/2] Checking ports 3333 / 5173 ...
call :kill_port 3333
call :kill_port 5173
echo.

echo [1/2] Starting backend server...
start "Shimo3-Backend" cmd /k "cd /d "%ROOT_DIR%server" && npm run dev"

timeout /t 3 /nobreak >nul

echo [2/2] Starting frontend server...
start "Shimo3-Frontend" cmd /k "cd /d "%ROOT_DIR%web" && npm run dev"

echo.
echo Done!
echo Backend:  http://localhost:3333/api/docs
echo Frontend: http://localhost:5173/chat
echo.
echo Press any key to close this window...
pause >nul
exit /b 0

rem ---------- Subroutine: kill processes listening on the given port ----------
rem Only matches LISTENING state, unrelated short-lived connections are untouched.
:kill_port
set "KILL_REPORTED="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%1 .*LISTENING"') do (
    if not defined KILL_REPORTED (
        echo     Port %1 is in use, killing related process...
        set "KILL_REPORTED=1"
    )
    taskkill /F /PID %%p >nul 2>&1
)
if defined KILL_REPORTED timeout /t 1 /nobreak >nul
goto :eof
