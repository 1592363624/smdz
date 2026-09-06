# 背包图鉴弹层 — 端到端验证脚本

真实浏览器（puppeteer-core + 系统 Edge）验证 `RichSystemCard.vue` 富卡片的图鉴弹层交互。

## 运行前提

1. 后端已启动（`server/` → `node dist/main.js`，监听 3333）
2. dev server 已启动（`web/` → vite，监听 5173）
3. puppeteer-core 可用：
   - 系统 npm：`npm i -g puppeteer-core` 后脚本同级放一份，或
   - 本项目惯例：装在 `%TEMP%\pup\`（`cd %TEMP%\pup && npm i puppeteer-core`），脚本复制到该目录运行

> 项目里 workbuddy 自带 node 的 `node_modules/npm/` 曾因误操作丢失，重建方法：
> PowerShell `Copy-Item -Recurse` 从系统 node（`D:\nodejs\node_modules\npm`）复制到
> `C:\Users\15923\.workbuddy\binaries\node\versions\22.22.2-2\node_modules\npm`，
> 并手写 `.bin\npm.cmd`（调 `..\npm\bin\npm-cli.js`）。git bash 的 `cp -r` 会静默截断，勿用。

## 运行

```bash
cd %TEMP%\pup   # 或脚本所在目录（需能 require puppeteer-core）
node e2e_handbook.js   # 基础：悬浮「纵横C」→ 弹层显示「纵横（能量武器）」（品质码回退）
node e2e_delay.js      # GM 配置延迟：改 1500ms → hover 800ms 弹层不出现 → 内容弹出 → 恢复
node e2e_switch.js     # 切换残留：A→B 直接移动，弹层即时切换不残留旧内容
node e2e_regression.js # 综合回归：文字版/分类/回退/缓存秒出/多物品切换全查
```

## 各脚本断言要点

| 脚本 | 验证 |
|---|---|
| e2e_handbook | `.rc-handbook` 可见 + `.rc-hb-content` 含「纵横（能量武器）」（两段式回退 纵横C→纵横） |
| e2e_delay | 设 GM 延迟 1500 → hover 后 800ms `.rc-handbook` 不存在（延迟生效）→ 内容就位 → 恢复 1000 |
| e2e_switch | A(纵横C) 读完后直接 hover B(矢量D)：切换时弹层立即收起（无 A 残留、不提前弹 B），~1s 后 B 详情就位；切回 A（缓存命中）同样等延迟 ~1s |
| e2e_regression | ①无 `.rc-raw` ②格子分类（装备 13 / 资源 8 带 rc-cell-use）③首次悬浮耗时≈延迟+查询 ④缓存二次悬浮 ≥800ms（按延迟，非秒出）⑤矢量D 正确回退 |

## 已踩过的坑（写脚本时注意）

- **中文 JSON 别走 shell**：`execSync curl -d '{"username":"路人甲"}'` 引号会被剥坏 → 400。
  用 Node 原生 `http` 模块发请求（各脚本的 `httpReq` 函数即模板）。
- **puppeteer `page.hover` 前必须** `scrollIntoView({block:'center'})` + ~250ms 稳定等待。
- **移开鼠标要 hover 到网格外**（如 `page.mouse.move(30, 300)`）；hover 卡片标题 `.rc-title` 在 rc-bag
  内部，不触发 mouseleave，弹层不关闭，后续断言会读到上一个物品的缓存内容（假失败）。
- **断言弹层内容**要等「非 loading 且非旧内容」：轮询 `.rc-handbook` 文本，命中目标即止，
  别只 `waitForSelector('.rc-hb-content')`——旧内容残留时它也在。
- **后端启动命令别加 `| head -N` 管道**：head 读完即关 stdout，node 写管道报错整个进程退出。

## 登录态注入

路由守卫只查 `localStorage.token`，因此直接：
`POST /api/auth/dev/login {username:'路人甲'}`（或 admin）→ 把 `access_token` 与 `user` JSON
塞进 localStorage → `goto /chat`，比走 QQ 互联 UI 登录可靠得多。
