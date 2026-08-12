@echo off
chcp 65001 >nul
title Shimo3 Launcher

set "ROOT_DIR=%~dp0"

echo ============================================
echo   Shimo3 Web - Starting Servers
echo ============================================
echo.

echo [1/2] Starting backend server...
start "Shimo3-Backend" cmd /k "cd /d "%ROOT_DIR%server" && npm run dev"

timeout /t 3 /nobreak >nul

echo [2/2] Starting frontend server...
start "Shimo3-Frontend" cmd /k "cd /d "%ROOT_DIR%web" && npm run dev"

echo.
echo Done!
echo Backend:  http://localhost:3000/api/docs
echo Frontend: http://localhost:5173/chat
echo.
echo Press any key to close this window...
pause >nul