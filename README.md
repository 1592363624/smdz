# 使魔大战3 · 网页版

将易语言 QQ 机器人文字游戏「使魔大战3」迁移为现代化 Web 多人公屏群聊架构。

### 项目体验地址: [使魔大战3 网页版](https://smdz.52shell.ltd)
### bug反馈/新增功能玩法: [提交建议/bug](https://github.com/1592363624/smdz/issues)
### 项目机器人体验群: [使魔大战3 机器人体验群](https://qm.qq.com/q/4ZCzMh5I0U)

## 功能特性

- **多人公屏群聊**：所有玩家在同一频道(世界频道)实时交流、发指令、看结果
- **用户注册/登录**：JWT 认证，支持账号密码登录与 QQ 快捷登录
- **配置化指令引擎**：指令注册表存数据库，新增/修改指令无需改代码重编译
- **AstrBot 机器人对接**：QQ 机器人发指令 → 网页指令引擎执行 → 结果回传 QQ
- **完整复刻战斗引擎**：以易语言源码逐行复刻核心伤害模型、使魔被动特效、怪物抗性、升级经验公式等
- **实时通信**：Socket.IO 实现公屏消息实时广播
- **OpenAPI 文档**：内置 Swagger，可直接导入 Apifox 调试
- **管理后台**：`/admin` 后台在线管理用户、系统配置、指令等

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | NestJS 10 (Node.js + TypeScript) |
| 前端 | Vue 3 + Vite 6 |
| 实时通信 | Socket.IO 4 |
| 数据库 | MySQL 8.0 (Prisma ORM) |
| 认证 | JWT + Passport |
| 部署 | PM2 / Nginx / GitHub Actions |

## 数据分层设计

> 遵循「配置项抽取」原则：一切可能在业务中变化、需调整而无需改代码的常量都抽为配置。

| 层级 | 内容 | 存储位置 |
|------|------|----------|
| 固定配置 | 指令/地图/物品/装备/使魔/怪物/buff/配方/任务/称号/建筑/NPC/载具部件/蓝图/增益/商店/资源/特效/攻击文本/套装/风味文本/更新日志 | `server/prisma/data/*.json`（22 个文件，进版本控制），由 `StaticDataService` 懒加载读取 |
| 动态数据 | 用户/玩家/地图/载具/商店/频道/聊天消息/指令/指令日志 | MySQL 数据库表 |
| 系统配置中心 | 指令前缀、开关、阈值等可调参数 | `SystemConfig` 表，管理员后台在线修改 |

### 种子数据策略

种子数据「以代码为准」：`seed-data.ts` 对所有固定配置表执行 `upsert`（`update: data`），并在末尾 `syncDeleted` 同步删除代码中已移除的记录，实现**新增/修改/删除/重命名**全部以代码为准同步到数据库。`SystemConfig` 除外（保留管理员在线修改的生效结果，不被覆盖）。

## 目录结构

```
├── server/                     # NestJS 后端
│   ├── prisma/
│   │   ├── data/*.json         # 22 个固定配置 JSON 文件
│   │   ├── schema.prisma       # MySQL 数据库模型
│   │   └── seed-data.ts        # 种子数据脚本（以代码为准）
│   └── src/
│       ├── modules/
│       │   ├── auth/           # 认证（JWT + QQ 登录）
│       │   ├── users/          # 用户
│       │   ├── game/           # 游戏引擎（战斗/地图/载具/商店）
│       │   ├── chat/           # 公屏群聊 + 私聊
│       │   ├── command/        # 指令引擎
│       │   ├── bot/            # AstrBot 对接
│       │   ├── feedback/       # 反馈工单
│       │   └── admin/          # 管理后台
│       └── config/             # 全局配置
├── web/                        # Vue3 前端
├── deploy/
│   └── windows/                # Windows 生产部署脚本（PM2）
└── .github/                    # GitHub Actions 自动部署
```

## 本地开发

### 前置要求

- Node.js 20+
- MySQL 8.0（可本地，或使用 `server/.env` 中的 `DATABASE_URL` 指向远程库）

### 1. 后端 (端口 3333)

```bash
cd server
npm install
# 配置 server/.env（DATABASE_URL 指向 MySQL 8.0）
npx prisma generate            # 生成 Prisma Client
npx prisma db push             # 同步数据库结构
npx prisma db seed             # 写入种子数据（指令/固定配置）
npm run dev                    # 开发模式(热更新)
```

### 2. 前端 (端口 5173)

```bash
cd web
npm install
npm run dev                    # Vite 热更新
```

浏览器访问 http://localhost:5173，Swagger 文档见 http://localhost:3333/api/docs

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

生产形态：**PM2 进程管理 + Nginx 反向代理 + GitHub Actions 自动部署**。

1. 安装 Node.js 20+ 与 PM2: `npm i -g pm2`
2. 配置 `server/.env`（数据库连接、JWT 密钥、BOT 令牌等）
3. 执行 `deploy/windows/deploy.ps1`（自动完成：`prisma generate` → `prisma db push` → `prisma db seed` → `nest build` → PM2 启动，进程名 `smdz-server`）
4. 前端 `web/dist` 静态托管到 Nginx，并反向代理 `/api/` 与 `/socket.io/` 到后端（如 `127.0.0.1:3333`）

> 生产环境注意：
> - 服务器端口固定为 **3333**（避免与 AstrBot 等占用 3000/3001 的服务冲突）
> - GitHub 仓库 Secret `ENV_FILE` 中的 `PORT` 必须为 `3333`，否则部署后会覆盖 `server/.env` 打错端口
> - 数据库同步用 `prisma db push --accept-data-loss`（早期手工库无迁移历史，`migrate deploy` 会报 P3005）

## 生产配置项

### 环境变量 (.env)

| 配置 | 说明 | 默认 |
|------|------|------|
| PORT | 服务端口 | 3333 |
| DATABASE_URL | MySQL 8.0 连接串 | `mysql://用户:密码@主机:3306/库名` |
| JWT_SECRET | JWT密钥(务必修改) | dev_secret_change_me |
| JWT_EXPIRES_IN | token有效期(秒) | 86400 |
| CORS_ORIGINS | 允许的前端来源 | localhost:5173,... |
| BOT_ACCESS_TOKEN | AstrBot访问令牌 | astrbot_web_secret |
| QQ_APP_ID | QQ 登录应用 ID | - |
| QQ_APP_KEY | QQ 登录应用密钥 | - |
| QQ_CALLBACK_URL | QQ 登录回调地址 | `https://域名/api/auth/qq/callback` |

### 系统配置中心 (SystemConfig 表)

指令前缀、开关、阈值等业务可调参数统一收敛到 `SystemConfig` 表，管理员可在 `/admin` 后台「系统配置」界面在线修改，无需改代码重编译。当前指令前缀/强制前缀即通过 `command.prefixes` / `command.requirePrefix` 两个 key 管理。
