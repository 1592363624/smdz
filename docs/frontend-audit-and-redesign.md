# 使魔大战3 · 前端审计与改造方案

> 范围：``web/`` 网页版前端（Vue 3 + Vite，公屏群聊文字游戏界面）
> 目标：响应式设计 + 良好用户交互体验
> 结论先行：**当前前端已有较成熟的响应式骨架，但存在「组件巨型化 / 无状态管理 / 交互反馈分散 / 长会话性能」四类可优化空间**；本报告给出优化空间分级、目标架构与视觉方向，并列出本轮已落地的改进。

---

## 一、现状概览（已实现，值得肯定）

| 维度 | 现状 | 评价 |
| --- | --- | --- |
| 响应式断点 | 1500 / 1024 / 768 / 480 四档，桌面三栏→双栏→移动单栏+抽屉 | ✅ 成熟 |
| 移动端 | 汉堡抽屉菜单、底部浮动操作栏、安全区域适配（`env(safe-area-inset-*)`）、`--vh` 视口修正、键盘弹出处理 | ✅ 到位 |
| 视觉风格 | 暗黑二次元能量配色 + CSS 变量设计令牌（`:root` 一套 token） | ✅ 统一 |
| 性能妥协 | 移动端主动关闭 `backdrop-filter`、关闭动态背景动画 | ✅ 有意识 |
| 交互细节 | 指令点击发送、右键填入、@ 提及、自动补全、回到底部 | ✅ 较好 |

**一句话：这不是从零开始的前端，而是在一个可用基础上做「工程化与体验升级」。**

---

## 二、优化空间（按严重程度分级）

### 🔴 P0 — 可维护性与稳定性风险

1. **上帝组件（God Component）**
   - `ChatView.vue` **3972 行**、`AdminView.vue` **1799 行**、`styles.css` **3400+ 行全局样式**。
   - 风险：单文件改动影响面大、合并冲突频繁、逻辑与视图强耦合、难以做单元测试。
   - 建议：按「指令域 / 面板」拆子组件 + 抽 composables（`useChatSocket`、`usePlayerStatus`、`useCommandList`）。

2. **无集中状态管理**
   - 登录态（`localStorage`）、连接状态、玩家信息、指令列表散落在 `ChatView` 的 `ref` 里，Admin 页重复拉取同样数据。
   - 建议：引入 **Pinia**，建立 `auth / connection / player / command / ui` store（本轮已落地 `ui` store 作为地基）。

### 🟠 P1 — 交互与性能体验

3. **长会话消息无虚拟化**
   - 公屏消息累积到上千条时，DOM 节点过多导致滚动卡顿（尤其低端机）。
   - 建议：消息列表虚拟滚动（如 `@vueuse/core` 的 `useVirtualList` 或 `vue-virtual-scroller`），仅渲染可视区。

4. **反馈机制不统一**
   - 成功/失败提示多为页面内联 `.error`，无统一 toast；复制成功、发送失败等无轻提示。
   - 建议：全局 Toast 系统（**本轮已落地** `ToastHost` + `useUiStore.pushToast`）。

5. **指令触达效率**
   - 当前靠侧栏「指令」Tab 列表或输入框自动补全；指令多达数百条时查找成本高。
   - 建议：全局命令面板 `Cmd/Ctrl+K`（**本轮已落地** `CommandPalette`，支持搜索/方向键/回车直发）。

### 🟡 P2 — 体验细节与可访问性

6. **头部按钮此前无统一样式**（`.header-action-btn` 裸 button），本轮已补齐。
7. **键盘可达性**：此前无 `:focus-visible` 焦点描边，键盘/无障碍用户难定位。
8. **`prefers-reduced-motion` 未全局降级**（仅 `GameHighlight` 局部支持）。
9. **小屏头部拥挤**：≤480px 时「重生之凡人修仙」外链与 BUG 反馈占位过宽（本轮已隐藏非核心外链文字）。
10. **加载/空态骨架屏缺失**：首屏消息与玩家面板仅文字占位，无骨架动画。

---

## 三、目标架构与视觉方向（打算改成什么样子）

### 架构目标
```
web/
├─ src/
│  ├─ stores/         # Pinia：auth / connection / player / command / ui
│  ├─ composables/    # useChatSocket / usePlayerStatus / useCommandList / useViewport
│  ├─ components/
│  │  ├─ chat/        # MessageList(virtual) / MessageItem / InputBar / Autocomplete
│  │  ├─ panels/      # PlayerStatus / CommandList / MapPanel / QuickActions
│  │  ├─ command/     # CommandPalette（已落地）
│  │  ├─ feedback/    # ToastHost（已落地）/ Skeleton / EmptyState
│  │  └─ common/      # AppButton / AppModal / AppTabs（设计系统原子组件）
│  ├─ views/          # ChatView / AdminView / LoginView（仅做编排，逻辑下沉）
│  └─ styles/         # tokens.css + base.css（按层拆分，替代单文件）
```

### 视觉方向（保持现有暗黑二次元风格，做「精致化」）
- **设计系统原子化**：按钮/弹窗/Tab/输入框收敛为 `App*` 组件，三处样式合并为一处，杜绝裸 button。
- **统一反馈层**：所有成功/错误/警告走 Toast；加载走 Skeleton；空数据走 EmptyState 插画。
- **移动优先的导航**：桌面三栏 + 移动底部 Tab 导航（消息 / 指令 / 我的 / 地图），替代当前底部浮动操作栏，拇指热区更合理。
- **命令面板**：桌面 `Cmd/Ctrl+K` 唤起，移动端由头部「⌨️ 指令」按钮唤起，成为指令触达主入口。
- **性能基线**：消息虚拟滚动 + 移动端持续关闭 `backdrop-filter`，确保中低端安卓流畅。

---

## 四、本轮已落地（可运行，已通过 `vite build`）

| 阶段 | 改动 | 文件 | 说明 |
| --- | --- | --- | --- |
| ① 状态集中 | Pinia 地基 | `package.json` / `main.js` / `src/stores/ui.js` | 注册 Pinia + `useUiStore`（toast 队列 + 命令面板开关） |
| ① 状态集中 | 指令 store | `src/stores/command.js` | `commands` 列表下沉到 store，含 `loadCommands()` 动作与 `byName` getter（参数校验/点击发送复用） |
| ① 状态集中 | 连接 store | `src/stores/connection.js` | `connected` + `stats(总人数/在线)` 下沉到 store，供 ChatView / AdminView 共享 |
| ① 状态集中 | 玩家 store | `src/stores/player.js` | `playerInfo` 下沉到 store，REST 加载与 socket `player:update` 共同写入 |
| ① 状态集中 | ChatView 接管 | `src/views/ChatView.vue` | 原 4 个本地 `ref`（commands/connected/serverStats/playerInfo）改为指向 store 的 `computed`，赋值走 store action；`commandApi.list` 改用 `commandStore.loadCommands()` |
| ② 交互反馈 | 全局 Toast | `src/components/ToastHost.vue` + `App.vue` | 成功/错误/警告/信息四类统一轻提示，移动端贴顶、支持 `aria-live` |
| ② 交互反馈 | 命令面板 | `src/components/CommandPalette.vue` + `ChatView.vue` | `Cmd/Ctrl+K` 唤起，关键词搜索、↑↓ 导航、回车直发/填入；移动端全屏；接入 store 的 `commands` |
| ③ 样式 | 头部按钮样式 | `styles.css` | 补齐 `.header-action-btn` 统一样式 + 未读红点 + 「指令」按钮青色强调 |
| ③ 样式 | 可访问性/响应式 | `styles.css` | 全局 `:focus-visible` 焦点描边；`prefers-reduced-motion` 全局降级；≤480px 头部精简 |

> **进度**：P0 的「状态集中」已完成（① ✅）；「拆组件 / socket composable」进行中（见第五节）。

**使用方式**
- 桌面：按 `Cmd/Ctrl+K` 或点头部「⌨️ 指令」→ 输入关键词 → `↑/↓` 选择 → `Enter` 发送（无参指令直发，有参指令填入输入框）。
- 移动端：点头部「⌨️ 指令」打开全屏面板，交互一致。
- 复制 OpenID、发送指令等成功/失败场景将弹出右上角（移动端顶部）Toast。

> 注：静态构建已通过；完整运行时交互需在后端（NestJS + Socket.IO）启动后联调验证。

---

## 五、后续路线（建议优先级）

1. **P0 拆组件（进行中）→ 已完成状态集中**：下一步把 `ChatView` 拆为 `chat/` 子组件（`MessageList` / `InputBar` / `Autocomplete`）+ `composables/useChatSocket.js`（持有 Socket.IO 实例与事件注册），视图只做编排。
2. ~~**P0 状态集中**~~ ✅ 已完成：`connection / player / command` 三 store 接管 `ChatView` 散落状态（AdminView 可随后复用同一 store，消除重复拉取）。
3. **P1 消息虚拟化**：引入虚拟滚动（`@vueuse/core` `useVirtualList`），解决长会话卡顿。
4. **P2 设计系统**：`App*` 原子组件 + `styles/` 分层 + Skeleton/EmptyState。
5. **P2 移动导航**：底部 Tab 导航替代浮动操作栏。
6. **P2 TS 化**（可选）：当前为 JS，后端为 TS，长期可逐步迁移到 `<script setup lang="ts">` 提升类型安全。

> ⚠️ 拆组件 / socket composable 涉及 `ChatView` 约 4000 行逻辑，建议后端（NestJS + Socket.IO）启动、用 dev server 联调验证后再大步推进，避免一次性重构引入回归。
