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
| `ENV_FILE` | `PORT=3333\nDATABASE_URL=...` | **server/.env 完整内容**。`.env` 不进 git,所以通过 Secret 注入。GitHub Actions 会把内容以临时文件形式 SCP 上传到部署目录,部署脚本会把它写入 `server/.env`,然后删除临时文件。可换行后粘贴多行内容(会自动归一化为 LF)。 |

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

```nginx
server {
    listen 80;
    server_name _;

    # 前端静态文件(web/dist 上传的位置)
    root C:/wwwroot/smdz/web/dist;
    index index.html;

    # 单页应用路由
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 后端 API 反向代理
    location /api/ {
        proxy_pass http://127.0.0.1:3333;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket 公屏代理(必须配 Upgrade)
    location /ws/ {
        proxy_pass http://127.0.0.1:3333;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

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

## 八、`WIN_PATH` 配置细则（最容易踩坑）

`WIN_PATH` 必须按服务器 sshd 的路径风格填写，对应关系如下：

| sshd 类型 | 对应 Windows 路径 | `WIN_PATH` 应填 |
|-----------|------------------|------------------|
| OpenSSH on Windows（默认） | `C:\wwwroot\smdz` | **`/c/wwwroot/smdz`** |
| Cygwin / MSYS 类型 sshd | `C:\wwwroot\smdz` | `/cygdrive/c/wwwroot/smdz` |
| 用户填反斜杠 (`C:\wwwroot\smdz`) | — | ❌ 工作流会直接报错退出，**不允许** |
| 用户填混合 (`C:/wwwroot/smdz`) | — | ⚠️ 部分版本可工作，强烈不建议 |

> 自检命令：在本地 cmd 里执行 `ssh 用户名@服务器 "cd /c/wwwroot/smdz && ls"`，能正常列出目录就说明 OpenSSH 路径风格可用。
