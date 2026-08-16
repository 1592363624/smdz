# 使魔大战3 · 网页版

现代化的 Web 多人公屏群聊架构。

## 功能特性

- **多人公屏群聊**：所有玩家在同一频道(世界频道)实时交流、发指令、看结果
- **用户注册/登录**：JWT 认证，支持绑定 QQ 号
- **配置化指令引擎**：指令注册表存数据库，新增/修改指令无需改代码重编译
- **AstrBot 机器人对接**：QQ 机器人发指令 → 网页指令引擎执行 → 结果回传 QQ
- **实时通信**：Socket.IO 实现公屏消息实时广播
- **OpenAPI 文档**：内置 Swagger，可直接导入 Apifox 调试

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | NestJS (Node.js + TypeScript) |
| 前端 | Vue 3 + Vite |
| 实时通信 | Socket.IO |
| 数据库 | SQLite (Prisma ORM) |
| 认证 | JWT + Passport |
| 部署 | PM2 / Docker / GitHub Actions |

## 目录结构

```
├── server/          # NestJS 后端
│   ├── prisma/      # 数据库模型与种子数据
│   └── src/
│       ├── modules/
│       │   ├── auth/     # 认证
│       │   ├── users/    # 用户
│       │   ├── chat/     # 公屏群聊
│       │   ├── command/  # 指令引擎
│       │   └── bot/      # AstrBot 对接
│       └── config/       # 全局配置
├── web/             # Vue3 前端
└── .github/         # GitHub Actions 自动部署
```

## 本地开发

### 1. 后端 (端口 3333)

```bash
cd server
npm install
npx prisma migrate dev   # 创建数据库
npx prisma db seed       # 写入初始指令
npm run dev              # 开发模式(热更新)
```

### 2. 前端 (端口 5173)

```bash
cd web
npm install
npm run dev              # Vite 热更新
```

浏览器访问 http://localhost:5173

## AstrBot 对接

AstrBot 插件通过 HTTP 调用后端指令接口：

```http
POST http://<服务器>/api/bot/command
Header: x-bot-token: <BOT_ACCESS_TOKEN>
Body: {
  "botIdentity": "123456789",  // 玩家QQ号
  "message": "info"             // 指令内容
}
```

返回结果（机器人可原样回复给 QQ 群）：

```json
{
  "success": true,
  "data": {
    "success": true,
    "content": "👤 测试玩家\n等级：Lv.1\n...",
    "broadcast": false,
    "durationMs": 4
  }
}
```

## 部署到 Windows 服务器

1. 安装 Node.js 20+ 和 PM2: `npm i -g pm2`
2. 配置 `server/.env`(JWT密钥、BOT令牌等)
3. 执行 `deploy/windows/start-server.bat`
4. 前端 `web/dist` 部署到 Nginx/IIS 并反向代理 `/api`、`/ws` 到后端

## 生产配置项 (.env)

| 配置 | 说明 | 默认 |
|------|------|------|
| PORT | 服务端口 | 3333 |
| DATABASE_URL | SQLite 路径 | file:../prisma/dev.db |
| JWT_SECRET | JWT密钥(务必修改) | dev_secret_change_me |
| JWT_EXPIRES_IN | token有效期(秒) | 86400 |
| CORS_ORIGINS | 允许的前端来源 | localhost:5173,... |
| BOT_ACCESS_TOKEN | AstrBot访问令牌 | astrbot_web_secret |
