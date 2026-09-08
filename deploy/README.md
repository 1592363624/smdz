# 部署指南 · 使魔大战3 网页版

本文档说明如何把项目自动部署到你自己的 **Windows 服务器**。

## 一、整体流程

```
你推代码到 GitHub main 分支
      ↓
GitHub Actions 打包源码(server/ + web/ 仅源码,不含 node_modules)
      ↓
SCP 把源码包上传到 Windows 服务器 WIN_PATH 目录
      ↓
SSH 远程执行 deploy.ps1:
  解压源码 → 装依赖(npm ci) → 编译前后端 → 数据库迁移 → 重启 PM2
      ↓
部署完成,玩家访问 http://你的服务器IP
```

> 前端(web/dist)需配合 Nginx/IIS 托管，并把 `/api`、`/ws` 反向代理到后端 3333 端口。

## 二、首次部署：Windows 服务器端初始化（只需做一次）

在你拿到一台新的 Windows 服务器时，先手动完成以下初始化，之后才能被 GitHub Actions 自动管理。

### 1. 安装 Node.js
- 去 https://nodejs.org 下载 **Node.js 20 LTS** 安装（一路 Next）
- 装完打开 CMD 验证：`node -v` 应显示 v20.x

### 2. 安装 PM2（进程守护，让服务常驻/崩了自动重启）
```bat
npm i -g pm2
```

### 3. 开启 OpenSSH 服务器（GitHub 才能远程登录部署）
- 打开 **设置 → 应用 → 可选功能 → 添加功能 → OpenSSH 服务器**
- 安装后，以管理员打开 PowerShell 启动服务并设为自启：
```powershell
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```
- 验证：本机 `ssh 用户名@localhost` 能登录即成功

### 4. 创建部署目标目录
```bat
mkdir C:\wwwroot\smdz
```
> 目录路径可自定义，但要和 GitHub Secret `WIN_PATH` 保持一致。

> 本项目服务器实测：地址 `52shell.ltd`，用户 `Administrator`，SSH Key 认证（已连通）。

## 三、GitHub 仓库配置 Secrets（告诉 GitHub 推哪里）

进入你的 GitHub 仓库 **`1592363624/smdz`**，点击 **Settings → Secrets and variables → Actions → New repository secret**，依次添加：

| Secret 名 | 示例值 | 说明 |
|-----------|--------|------|
| `WIN_HOST` | `52shell.ltd` | 服务器公网 IP 或域名 |
| `WIN_USER` | `Administrator` | Windows 登录用户名 |
| `WIN_SSH_KEY` | `-----BEGIN OPENSSH PRIVATE KEY-----...` | SSH 私钥(整段含 BEGIN/END，服务器用密钥认证) |
| `WIN_PATH` | `/c/wwwroot/smdz` | 部署目标目录(**POSIX 格式**，OpenSSH 路径风格，例如 `C:\wwwroot\smdz` 对应 `/c/wwwroot/smdz`)。**必须以 POSIX 形式填写**，不要写 `C:\...` 或反斜杠 |
| `ENV_FILE` | `PORT=3333\nDATABASE_URL=...` | **server/.env 完整内容**。`.env` 不进 git,所以通过 Secret 注入。GitHub Actions 会把内容以临时文件形式 SCP 上传到部署目录,部署脚本会把它写入 `server/.env`,然后删除临时文件。可换行后粘贴多行内容(会自动归一化为 LF)。**注意：`DATABASE_URL` 无需你手动写绝对路径，deploy.ps1 会在部署时强制改写为 `file:<部署根目录>/smdz.db`（即 `server/` 之外），保证数据库文件在重复部署时不被删除。** |

可选（不配用默认值）：
| `WIN_APP_NAME` | `smdz-server` | PM2 进程名，默认即可。**必须与 `server/ecosystem.config.js` 中的 `name` 保持一致**，否则 deploy.ps1 的 `pm2 delete/start` 会名称对不上 |

> ⚠️ `WIN_SSH_KEY` 是私钥，**不要**把它写进任何代码文件或公开文档，只通过 GitHub Secret 保存。格式是把私钥的完整内容（含 `-----BEGIN OPENSSH PRIVATE KEY-----` 到 `-----END OPENSSH PRIVATE KEY-----`）作为值粘贴。

## 四、首次部署完成后，服务器端手动建数据库并启动（首次必须做）

首次 push 后文件会传到 `C:\wwwroot\smdz`，但 PM2 服务还没启动过。**首次需要在服务器上手动跑一次**（之后每次 push 就全自动了）：

```bat
cd /d C:\wwwroot\smdz\server
npm ci --omit=dev
npx prisma migrate deploy
pm2 start ecosystem.config.js
pm2 save
```

## 五、配置前端托管 + 反向代理

后端监听 3333 端口，前端 `web/dist` 是静态文件。推荐用 **Nginx**（Windows 版）托管：

> ⚠️ 下面的配置已包含**维护模式拦截**（部署期间玩家看到「系统维护中」页面而不是刷新死循环）。
> 依赖两个前提：① 前端构建产物中有 `dist/maintenance.html`（随 `web/public/maintenance.html` 自动发布，0.6.x 起）；
> ② flag 路径与实际部署根目录一致（下方按 `C:\wwwroot\smdz` 示例，自行替换）。
> **首次启用前请先手动把 `web/public/maintenance.html` 复制一份到服务器当前的 `web\dist\` 里**（下下次部署起构建会自动带上）。

```nginx
server {
    listen 80;
    server_name _;

    # 前端静态文件(web/dist 上传的位置)
    root C:/wwwroot/smdz/web/dist;
    index index.html;

    # ===== 维护模式开关 =====
    # deploy.ps1 部署开始时创建 server/maintenance.flag，部署成功后删除。
    # flag 存在 → 所有页面请求改写为静态维护页 maintenance.html（nginx 层拦截，
    # 页面请求根本不进 Node，所以必须在这里拦，而不是依赖后端中间件）。
    set $maintenance 0;
    if (-f C:/wwwroot/smdz/server/maintenance.flag) {
        set $maintenance 1;
    }

    # 单页应用路由（维护激活时改写为维护页）
    location / {
        if ($maintenance = 1) {
            rewrite ^ /maintenance.html break;
        }
        try_files $uri $uri/ /index.html;
    }

    # 后端 API 反向代理
    # 维护期间无需 nginx 处理：Node 端维护中间件(maintenance.middleware.ts)会
    # 对 /api/* 返回 503 {code:"MAINTENANCE"}，前端遮罩据此原地轮询等待恢复
    location /api/ {
        proxy_pass http://127.0.0.1:3333;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket 公屏代理(必须配 Upgrade)
    # 注意：Socket.IO 的引擎路径默认是 /socket.io/，前端 config.js 里的 '/ws'
    # 只是 namespace；代理 location 必须按 /socket.io/ 配，配成 /ws/ 会导致连接不通
    # 维护期间建议直接拒绝新连接（已建立的连接不受影响，玩家反正卡在维护页）
    location /socket.io/ {
        if ($maintenance = 1) {
            return 503;
        }
        proxy_pass http://127.0.0.1:3333;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

> 生产环境的完整实际配置（宝塔 + SSL 版）留档在 `deploy/nginx/smdz.52shell.ltd.conf.example`。

> 若用 IIS：把 web/dist 设为网站根目录，URL 重写 `/{R:0}` 到 `index.html`，并配置 `/api`、`/ws` 反向代理（需安装 Application Request Routing）。

## 六、之后每次开发

只需本地 `git push` 到 main 分支，GitHub Actions 会自动：
1. 构建前后端
2. 上传到 `C:\wwwroot\smdz`
3. 装依赖、建库、重启 PM2

全程无需登录服务器。

## 七、常见问题

| 问题 | 解决 |
|------|------|
| workflow 报"秘密未配置" | 检查 Section 三的 Secrets 是否都添加了 |
| SCP 上传失败 / "Error: Process completed with exit code 1" | 90% 是 `WIN_PATH` 配置问题。务必用 POSIX 形式 `/c/wwwroot/smdz`，不要写 `C:\wwwroot\smdz` 或 `C:/wwwroot/smdz` |
| 远端 sshd 用的是 Cygwin/MSYS 风格（非 OpenSSH on Windows） | `WIN_PATH` 改填 `/cygdrive/c/wwwroot/smdz` |
| `pm2` 命令找不到 | 确认已全局安装 pm2 且 PATH 已刷新(重开 CMD) |
| 数据库没建好 | 首次需手动执行 Section 四的命令 |
| 前端访问 404 | 确认 Nginx/IIS 已配好 `try_files`/重写规则 |
| 部署期间页面在两个路由间无限刷新 / 看不到维护页 | nginx 缺维护模式拦截（Section 五 + Section 十）。确认 `location /` 里有 `if ($maintenance = 1)` 一段，且 `web\dist\maintenance.html` 存在、flag 路径正确 |

## 八、`WIN_PATH` 配置细则（最容易踩坑）

`WIN_PATH` 必须按服务器 sshd 的路径风格填写，对应关系如下：

| sshd 类型 | 对应 Windows 路径 | `WIN_PATH` 应填 |
|-----------|------------------|------------------|
| OpenSSH on Windows（默认） | `C:\wwwroot\smdz` | **`/c/wwwroot/smdz`** |
| Cygwin / MSYS 类型 sshd | `C:\wwwroot\smdz` | `/cygdrive/c/wwwroot/smdz` |
| 用户填反斜杠 (`C:\wwwroot\smdz`) | — | ❌ 工作流会直接报错退出，**不允许** |
| 用户填混合 (`C:/wwwroot/smdz`) | — | ⚠️ 部分版本可工作，强烈不建议 |

> 自检命令：在本地 cmd 里执行 `ssh 用户名@服务器 "cd /c/wwwroot/smdz && ls"`，能正常列出目录就说明 OpenSSH 路径风格可用。

## 九、版本更新检测机制（部署完成自动提示刷新）

GitHub Actions 在每次部署打包前会生成 `server/version.json`（含本次 commit SHA、部署时间与最近 10 条提交日志），随源码包一起部署到服务器。该文件已加入 `server/.gitignore`，由 CI 每次生成，无需手工维护。

后端提供公开接口 `GET /api/system/version` 读取该文件（本地开发没有此文件时返回默认值，前端据此不弹更新窗）。前端游戏主界面按配置间隔轮询该接口：

- 发现 commit SHA 变化（即判定"部署已完成"）→ 弹出「✨ 游戏更新完成」弹窗展示更新日志（最近提交列表）→ 倒计时后自动刷新页面；玩家也可点击「立即刷新」或「稍后」
- 相关配置项在管理后台「系统配置」的 `update` 分组中在线调整（改后立即生效，无需重启）：
  - `update.check.enabled`：是否开启部署更新检测
  - `update.check.interval`：轮询间隔(秒)
  - `update.autoReloadSeconds`：弹窗后自动刷新倒计时(秒)，`0`=不自动刷新
  - `update.promptCooldown`：点击「稍后」后的重复提醒冷却(秒)

## 十、维护模式（部署期间玩家看到「系统维护中」页面）

### 1. 背景与原理

部署全程玩家不应看到报错或白屏，而是看到维护页；部署完成后自动回到游戏。该效果由**四层防线**配合实现（缺一不可，尤其是第 1 层——页面请求由 nginx 静态托管，根本到不了 Node）：

| 层 | 实现位置 | 职责 |
|----|---------|------|
| ① nginx 页面拦截 | nginx `location /` 检测 `server/maintenance.flag` | 维护期间**所有页面请求**返回静态维护页 `dist/maintenance.html`（第一道，也是最关键的一道） |
| ② Node API 中间件 | `server/src/maintenance/maintenance.middleware.ts` | 维护期间 `/api/*` 返回 `503 {code:"MAINTENANCE"}`（QQ bot/Shell 等据此识别）；`/api/docs` 放行供健康检查 |
| ③ 前端遮罩守卫 | `web/src/utils/maintenanceGuard.js`（axios 拦截器触发） | 已打开的旧游戏页签收到 503/断线时，**原地**盖全屏维护遮罩（绝不整页跳转），并自行轮询 `/api/system/version` |
| ④ 自动恢复 | 维护页轮询脚本 + 前端遮罩轮询 | 轮询到 `/api/system/version` 返回 200（flag 已删）→ `location.reload()` 整页刷新进新版本 |

> ⚠️ 历史事故（2026-09-08）：旧版前端拦截器在收到 503 时执行 `window.location.href = '/'`，
> 但生产环境 `/` 由 nginx 静态返回 SPA（维护中间件拦不到页面请求），路由又把 `/` 弹回 `/chat`，
> 造成「/chat ↔ / 无限刷新乒乓」，维护页从未生效。修复后前端**禁止**整页跳转，只原地遮罩。

### 2. 依赖清单（启用前逐项确认）

- [ ] nginx 配置含维护模式拦截（见 Section 五的配置，`if (-f ...maintenance.flag)` 一段）
- [ ] `dist/maintenance.html` 存在于服务器 `web\dist\`（0.6.x 起随构建自动发布；旧部署可先手动复制 `web/public/maintenance.html` 过去）
- [ ] flag 路径与实际部署根目录一致（配置里写的是 `C:/wwwroot/smdz/server/maintenance.flag`，按需替换）

### 3. 手动开关维护模式（服务器 PowerShell）

```powershell
# 开启维护(玩家立即看到维护页,API 返回 503)
Set-Content -LiteralPath C:\wwwroot\smdz\server\maintenance.flag -Value (Get-Date -Format o)

# 关闭维护(所有维护页/遮罩在 5 秒内轮询到恢复并自动刷新进游戏)
Remove-Item -LiteralPath C:\wwwroot\smdz\server\maintenance.flag -Force
```

> 开关均即时生效（Node 端有 2 秒检测结果缓存；nginx 的 `-f` 检查每个请求实时执行）。
> 正常情况下无需手动操作——`deploy.ps1` 在部署开始时自动开启、健康检查通过后自动关闭。

### 4. 验证方法

```bash
# 维护开启时：
curl -i https://你的域名/                  # 应返回 200 + 「系统维护中」HTML（而非 SPA 的 index.html）
curl -i https://你的域名/api/system/version # 应返回 503 JSON {"code":"MAINTENANCE",...}

# 维护关闭时：
curl -i https://你的域名/                  # 应返回 SPA index.html
curl -i https://你的域名/api/system/version # 应返回 200 版本信息 JSON
```

游戏内验证：开启维护后，停留在游戏页签应立即被全屏「系统维护中」遮罩盖住（不再出现路由来回刷新）；关闭维护后 ≤5 秒自动刷新回到游戏。
