/**
 * PM2 进程守护配置 (Windows/Linux 通用)
 * 用于生产环境保持后端服务常驻运行、崩溃自动重启。
 *
 * 启动方式：pm2 start ecosystem.config.js
 */
module.exports = {
  apps: [
    {
      name: 'smdz-server', // 进程名(需与 GitHub Secret WIN_APP_NAME 保持一致)
      script: 'dist/main.js', // 后端入口
      cwd: __dirname,
      instances: 1, // 单实例(共享内存中的Socket.IO房间状态，避免多实例数据竞争；数据库为MySQL)
      exec_mode: 'fork',
      autorestart: true, // 崩溃自动重启
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      // 日志
      out_file: './logs/out.log',
      error_file: './logs/error.log',
    },
  ],
};
