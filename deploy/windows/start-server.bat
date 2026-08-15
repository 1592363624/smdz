@echo off
chcp 65001 >nul
REM =============================================
REM 使魔大战3 网页版 - Windows 后端启动脚本
REM 使用 PM2 守护进程运行，崩溃自动重启
REM 首次使用需先安装: npm i -g pm2
REM =============================================

echo [1/3] 切换到后端目录...
cd /d "%~dp0..\..\server"

echo [2/3] 同步数据库 schema（固定配置表已 JSON 化，删除遗留旧表）...
npx prisma db push --skip-generate --accept-data-loss

echo [3/3] 通过 PM2 启动服务...
pm2 start ecosystem.config.js
pm2 save

echo.
echo ✅ 启动完成！访问: http://localhost:3333/api/docs
echo    如需停止服务: pm2 stop smdz-server
pause
