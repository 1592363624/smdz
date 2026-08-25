@echo off
REM ============================================================
REM 使魔大战3 网页版 · 本地一键启动（双击入口）
REM 等价于在 PowerShell 中执行 .\start-all.ps1
REM 首次运行或重建数据库，把下面 switch 改为 -InitDb 即可。
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"
pause