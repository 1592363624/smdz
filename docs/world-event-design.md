# 全服世界事件 · 设计文档

> 状态：设计稿 **v3**（在 v2 基础上**逐条核对代码事实后修订**，可直接开工），待评审
> 日期：2026-09-17（v1）/ 2026-09-17（v2：day/week/month 周期 + 随机任务池 + 实时进度 UI）/ 2026-09-18（**v3：代码核查修订**）
>
> **v3 核查修订要点**（实现前务必按此写，否则出静默 bug）：
> 1. **奖励条目字段是 `quantity` 不是 `count`**——`CheckinRewardEntry`（`checkin-config.defaults.ts:17-22`）只认 `quantity`，`grantRewards` 对非正 `quantity` 直接 `continue`；照 v2 的 `count` 写会让每条奖励**静默丢失**（§5.4/§8.1 已全量改为 `quantity`）
> 2. **`combat-system.service.ts` G9 基线 = 12573 = 零余量**，且 `wc -l` 口径注释也算行 → 该文件绝对不可加行（Phase 1 本就不碰它）；G1 `game.service` 基线 1789（现 1783，仅 6 行余量）、G6 243、G5 2041
> 3. **`vitalityRegen` 生效点更正**：非 `time-settle:61-73`（那是时间基准），真实在 `time-settle.service.ts:168-206`，公式单一源 `vitality.service.ts:61 recover()`，系数加在调用处、勿改 recover 内部；`cargoPods` 现为 `schedule.service.ts:820` 硬编码 `for i<3`，需改读配置
> 4. **buff 必须同步读取**：`WorldEventService.getActiveBuffValues()` 内存缓存（cron tick 刷新 + 启动预热），4 个生效点全部同步取值——反向 `CheckinRewardService→WorldEventService` 注入会成环且 async 传染
> 5. **`WorldEventService` 须进 `game.module` providers + exports**（`ScheduleService` 在 `GameTasksModule` 要注入它）；`CheckinRewardService` 不在 exports，故 `WorldEventService` 必须与它同声明于 GameModule
> 6. **seed 的 `upsert` 会用代码覆盖 DB**（与 SystemConfig 相反）→ 新指令**必须重跑 seed**；`sortOrder 999` 与 `管理` 冲突改用 1000；别名精确匹配按 DB 行序取首个，**别名须全局唯一**（`sj` 这类 2 字别名会吞无空格输入）；`世界事件`/`领取世界奖励`/`世界事件管理` 与现有 284 条 name/alias 实测**无前缀冲突**
> 7. **世界点数可被 `setWorldLevel`（`管理 世界等级`）下调**，不止 `replacePoints`；进度自愈须覆盖两条路径
> 8. **配置默认值新版惯例放 `src/config/world-event.config.ts`**（照 `red-packet.config.ts`，非 `game/*-config.defaults.ts`）；cron 由 `@nestjs/schedule` 全局 discovery 扫描，`WorldEventService` 直接进 GameModule providers 即生效，**无需**在 `game-tasks.module` 重复 provide（重复会得到两实例两份运行锁）
> 9. **前端无统一 socket 封装**（各视图各自 `io()`），`RedPacketMinePanel` 是**居中弹窗非全屏抽屉**，进度条先例取 `PendingActionBar.vue` 的 `.pa-track/.pa-fill`
> 背景：单机内容深度不足、玩家黏性低。核心诊断之一是**世界等级机制把正反馈做成了惩罚**——
> 玩家越肝，全服怪物越强，净体感是「原地踏步」。本设计把同一个数值翻转成**全服共同推进的进度条**，
> 用最低的改造成本引入「他人」这个内容源，为后续 PVP / 多人玩法铺路。
> 定位：**第一期 · 合作型多人玩法**（零对抗、零挫败、不依赖同时在线）。
>
> **v2 相对 v1 的增量**（只增不改战斗链路）：
> 1. `worldEvent.period` = `day` | `week` | `month`，周期边界按所选粒度对齐（日=自然日 0 点，周=周一 0 点，月=1 日 0 点）
> 2. `worldEvent.taskPool` 任务池 + `worldEvent.randomPick` 开启时**每周期随机抽 1 条**任务（可固定某条）
> 3. 进度 UI 三件套：Chat 顶部细进度条 → 点击展开完整面板 → Socket `worldEvent:progress` 实时刷新

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 衡量方式 |
| --- | --- | --- |
| G1 | 把「越肝怪越强」翻转为「我们一起推线」 | 事件周期内公屏讨论量、指令调用量 |
| G2 | 让每一次击杀具备**社交意义**（不只是个人收益） | 里程碑达成时公屏播报触达率 |
| G3 | 为终局玩家提供**周期性新目标** | 周活跃留存 |
| G4 | 零侵入战斗主链路，不触碰 G9 行数冻结 | `architecture-guard.spec.ts` 全绿 |

### 1.2 非目标（本期不做）

- ❌ 个人贡献排行 / 个人贡献奖励（Phase 2，见 §11.3）
- ❌ 世界 Boss 共享血条（独立玩法，另开设计文档）
- ❌ 任何形式的玩家对抗（第二期再做）
- ❌ 全服掉落/经验倍率类 buff（需改 `combat-system.service.ts`，受 G9 冻结，见 §8.4）

---

## 2. 现状链路（代码定位）

| 环节 | 位置 | 现状 |
| --- | --- | --- |
| ① 世界熟练度累加 | `combat-system.service.ts:2936-2937`、`:3792-3793`、`:5745-5749`（v3 实测校准，v2 行号已漂移） | **任意一方被击杀** → `世界熟练度` +1（另有物种熟练度 +1） |
| ② 内存权威存储 | `global-proficiency.service.ts:87` `points: Map` | 内存权威 + 10s 定时脏写回 + 关闭时 flush |
| ③ 落库位置 | `SystemConfig` 键 `game.globalMarkers`（type=json） | `Record<"<名称>熟练度", number>` |
| ④ 等级换算 | `global-proficiency.service.ts:57` `proficiencyLevelFromPoints` | `floor(√点数) + 1` |
| ⑤ 怪物等级 | `map.service.ts:1354` / `global-proficiency.service.ts:258` | `物种熟练度等级 + 世界熟练度等级` |

**关键洞察**：`世界熟练度` 是一个**只增不减的全服计数器**，且其增量 ≈ 全服战斗事件总数。
这意味着**无需新增任何计数代码**，用「周期起始点数 vs 当前点数」的差值就能得到全服进度。

> ⚠️ 口径提示：`combat-system` 中有 3 处 `addProficiency(WORLD_PROFICIENCY_NAME, 1)`，
> 分别覆盖「怪物击倒目标」「怪物击杀目标」「击杀结算（抢占奖励后）」三条路径，
> 一次击杀可能触发多于 1 次累加。**差值口径不受此影响**（倍数关系恒定），
> 但**目标数值必须实测校准**，见 §5.3。

---

## 3. 设计总览

### 3.1 一句话（v2）

> 按 **每天 / 每周 / 每月** 开一个全服目标（可从任务池**随机**抽取，也可固定），进度条在聊天页**实时可见**，
> 达成 25/50/75/100% 逐级解锁全服增益，达成后开启奖励领取窗口，人人可领一次。
> 未达成则世界等级照常上涨（保留原压力）。

### 3.1b 周期与随机任务（v2 新增）

| 维度 | 可选值 | 对齐规则 | 适用节奏 |
| --- | --- | --- | --- |
| 周期 `period` | `day` / `week` / `month` | day=当地 00:00；week=周一 00:00；month=1 日 00:00 | 日常回归 / 周常活动 / 月常大型 |
| 任务来源 | `fixed`（固定单条）/ `pool`（任务池随机） | 每周期开启时抽取一次并写入 `WorldEventCycle.taskKey` | 运营换口味、防刷腻 |
| 随机种子 | `cycleId` 派生 | 同一周期多次 tick 结果稳定 | 避免重启/重入导致任务漂移 |

**任务池示例**（`worldEvent.taskPool`，json，每条含 `key/title/metric/goalHint/weight`）：

```json
{
  "tasks": [
    { "key": "kill_wave",   "title": "清扫裂隙",   "metric": "kill",    "goalHint": 20000, "weight": 3, "desc": "全服击杀累计" },
    { "key": "kill_boss",   "title": "讨伐潮汐",   "metric": "kill",    "goalHint": 8000,  "weight": 2, "desc": "全服击杀累计（精英向）" },
    { "key": "gather_ore",  "title": "矿脉动员",   "metric": "gather",  "goalHint": 5000,  "weight": 1, "desc": "全服采集次数累计（Phase 2 埋点）" },
    { "key": "craft_gear",  "title": "工坊赶工",   "metric": "craft",   "goalHint": 3000,  "weight": 1, "desc": "全服制造次数累计（Phase 2 埋点）" }
  ]
}
```

> **Phase 1 只保证 `metric=kill` 可跑**（复用世界熟练度差值，零新计数）；
> `gather`/`craft` 条目进池时若埋点未就绪则**开周期时自动过滤**，回退到 kill 池，避免空转。

### 3.2 三层反馈结构

```
   玩家击杀 ──→ 世界熟练度 +1 ──→ 进度条 +1（公屏可见、指令可查）
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ↓                             ↓                             ↓
   即时反馈                      中期反馈                        终局反馈
 进度条实时跳动              里程碑解锁全服增益              领取世界奖励
 （面板/公屏播报）        （活力/签到/货舱等加成）        （限领一次，防重复）
```

### 3.3 为什么这样设计

1. **零新增计数**：复用现有 `世界熟练度`，不动 `combat-system`（躲开 G9 冻结）
2. **零同时在线依赖**：异步累积，DAU=10 也能推进
3. **零挫败**：只有达成奖励，没有失败惩罚；未达成只是「没拿到额外奖励」
4. **可运营**：周期、目标、里程碑、奖励表全部 `SystemConfig` 在线可调，改完立即生效

---

## 4. 数据模型

### 4.1 新增表（Prisma）

```prisma
// ========== 全服世界事件 ==========

/// 世界事件周期：一个周期 = 一次全服共同目标。
/// 进度不单独计数，取自「世界熟练度」点数差值（见 global-proficiency.service.ts）。
model WorldEventCycle {
  id           Int       @id @default(autoincrement())
  /// 周期标识：
  ///  day   → 2026-09-17
  ///  week  → 2026-W38
  ///  month → 2026-09
  /// 人工开启时可带后缀（如 2026-W38-1）
  cycleId      String    @unique
  /// 周期粒度：day / week / month（快照开周期时的 worldEvent.period，历史行不受后续改配置影响）
  period       String    @default("week")
  /// 任务池 key（如 kill_wave）；fixed 模式可写 "fixed"；便于复盘「这期抽到了什么」
  taskKey      String    @default("kill_wave")
  /// 开周期时抽到的任务标题快照（运营改池后历史仍可读）
  taskTitle    String    @default("")
  /// 进度指标：kill=击杀（Phase 1 唯一）；预留 gather / craft / challenge
  metric       String    @default("kill")
  /// 周期开始时「世界熟练度」点数快照（差值计数的基准）
  startPoints  Float     @default(0)
  /// 本周期目标增量（管理员可按上周实际值校准；random 模式下可取 task.goalHint）
  goalPoints   Float     @default(0)
  startAt      DateTime
  endAt        DateTime
  /// ACTIVE=进行中；SETTLED=已结算（奖励领取窗口仍开放至 graceEndAt）
  status       String    @default("ACTIVE")
  /// 已解锁的里程碑：{ "25": "2026-09-18T10:00:00.000Z", "50": ... }（键=百分比，值=达成时刻）
  reached      Json?
  /// 结算时点数快照（用于复盘与下周期目标校准）
  finalPoints  Float?
  /// 领取窗口截止（结算后仍可领 N 小时，默认 24h；过期未领视为放弃）
  graceEndAt   DateTime?
  settledAt    DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  claims       WorldEventClaim[]

  @@index([status, endAt])
}

/// 世界事件奖励领取记录：同一玩家同一周期同一档位只能领一次（幂等）
model WorldEventClaim {
  id        Int      @id @default(autoincrement())
  cycleId   Int
  cycle     WorldEventCycle @relation(fields: [cycleId], references: [id], onDelete: Cascade)
  userId    Int
  /// 领取的里程碑档位：25 / 50 / 75 / 100
  percent   Int
  createdAt DateTime @default(now())

  @@unique([cycleId, userId, percent])
  @@index([userId, createdAt])
}
```

**设计取舍说明**：

- **为什么只有 2 张表**：里程碑没有独立状态（只有「是否达成 + 达成时刻」），
  存进 `WorldEventCycle.reached` 的 JSON 足够，不值得单独建表；
  领取记录必须独立建表（唯一约束做幂等，与 `RedPacketClaim` 同构）。
- **为什么不存进度数值**：进度 = `当前世界熟练度 - startPoints`，是**派生值**。
  存一份会与真相源打架（世界熟练度是内存权威 + 10s flush，无法反向同步）。

### 4.2 复用表（不新增）

| 用途 | 复用 | 说明 |
| --- | --- | --- |
| 进度数据源 | `SystemConfig.game.globalMarkers` | 读 `世界熟练度` 点数，经 `GlobalProficiencyService.getPoints('世界')` |
| 规则/奖励/开关 | `SystemConfig` 表 | 全部走 `worldEvent.*` 配置键，见 §5 |
| 广播留档 | `ChatMessage`（`type='system'`） | 经 `chatService.broadcastSystem('世界频道', ...)`，自动落库 |
| 定时结算 | `DelayedTask` 表 | 可选，用于「周期结束 N 小时后关闭领取窗口」的跨重启延时 |
| 指令埋点 | `CommandLog` | `command.service.ts:642` 自动记录，无需额外代码 |

### 4.3 玩家侧状态

**不新增 `Player` 字段**。领取资格完全由 `WorldEventClaim` 表判定
（`@@unique([cycleId, userId, percent])`）。
这与项目「跨天状态放 `Player.markers`」的惯例不同，原因：领取记录需要**跨周期保留 + 可审计**，
放 markers 会随玩家存档整包读写放大；独立表 + 唯一约束是 `RedPacketClaim` 已验证的做法。

---

## 5. 配置项清单

> 全部加在 `server/src/modules/system-config/system-config.service.ts` 的 `DEFAULT_CONFIGS`（L121-306 之间）。
> 按项目铁律：**任何可能变化的阈值/开关/周期/奖励都必须可在线调整，不得硬编码**。
> `onModuleInit` 的 `ensureDefaultConfigs()`（L323-386）会自动补行且不覆盖管理员改动，**无需重跑 seed**。

### 5.1 开关与周期（v2）

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `worldEvent.enabled` | boolean | `true` | 总开关。关闭后不再自动开新周期，已激活周期照常结算 |
| `worldEvent.period` | string | `week` | **周期粒度**：`day` / `week` / `month`。改配置后**下一周期**生效（当前周期仍按开周期时快照的 `period` 走完） |
| `worldEvent.cycleDays` | number | `7` | 兼容旧配置：当 `period` 未配置时回退用天数；`period` 有值时优先 |
| `worldEvent.autoStart` | boolean | `true` | 是否由 cron 自动开启新周期；false 时只能管理员指令开 |
| `worldEvent.graceHours` | number | `24` | 结算后奖励领取窗口时长（小时） |

**周期边界计算**（`world-event.service.ts`，统一用服务器本地日，与项目「北京时间」惯例一致）：

```
day:   endAt = 当日 00:00 的次日 00:00
week:  endAt = 本周一 00:00 的下周一 00:00
month: endAt = 本月 1 日 00:00 的下月 1 日 00:00
cycleId 格式化见 WorldEventCycle.period 注释
```

### 5.1b 随机任务池（v2 新增）

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `worldEvent.taskSource` | string | `pool` | `fixed`=固定用 `worldEvent.metric`+`baseGoal`；`pool`=从任务池按权重随机抽 |
| `worldEvent.taskPool` | json | 见 §3.1b | 任务池；抽样时过滤掉「埋点未就绪」的 metric |
| `worldEvent.randomPick` | boolean | `true` | 每开新周期是否重新随机；false=始终抽权重最高的一条（近似固定） |
| `worldEvent.panelTitleOverride` | string | `""` | 非空时覆盖面板标题（优先于抽到的任务 title，留给运营换皮） |

### 5.2 目标与里程碑

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `worldEvent.metric` | string | `kill` | 进度指标（本期仅 `kill`） |
| `worldEvent.baseGoal` | number | `20000` | 目标增量基准（**必须按实测校准**，见 §5.3） |
| `worldEvent.goalAutoAdjust` | boolean | `true` | 按上周期实际完成度自动缩放下周期目标 |
| `worldEvent.goalAdjustMin` | number | `0.6` | 自动缩放下限系数（上周期完成 40% → 下周期目标 ×0.6 兜底） |
| `worldEvent.goalAdjustMax` | number | `1.5` | 自动缩放上限系数（上周期超额 200% → 至多 ×1.5，防通胀） |
| `worldEvent.milestones` | json | `[25,50,75,100]` | 里程碑百分比档位数组 |
| `worldEvent.startPointsFallback` | number | `0` | 取不到世界熟练度时的起始点数兜底（不应发生，仅防炸） |

### 5.3 目标数值校准（重要）

`世界熟练度` 每次击杀的累加次数取决于 `combat-system` 的 3 个调用点是否在同一轮触发，
实测**单次怪物击杀的世界增量为 1~2**（同一次 `weaponAttackInner` 内，反伤致死 `:2937`
与主目标死亡结算 `:5749` 会同时命中 → +2；`:3793` 属地图战斗循环的独立事件）。
因此 `baseGoal` 不能拍脑袋定：

1. 上线前先**只读观测一个周期**（`worldEvent.enabled=true` 但 `rewards` 留空），
   记录 `WorldEventCycle.finalPoints - startPoints` 的实际值 `A`；
2. 按期望完成度设定 `baseGoal`：想让玩家「努力一下才达成」，取 `A × 1.1 ~ 1.3`；
3. 之后交给 `goalAutoAdjust` 自动浮动。

> 建议先做**一个周期的暗桩观测**再正式开启奖励，避免目标定得离谱（要么秒达，要么永远达不成）。

### 5.4 奖励表

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `worldEvent.rewards` | json | 见下 | 里程碑奖励表（**直接复用签到奖励的条目结构**） |
| `worldEvent.buffs` | json | 见下 | 里程碑达成的全服增益表 |

**`worldEvent.rewards` 结构**（条目字段 `{ type, name, quantity }`，与 `CheckinRewardEntry` 逐字一致——**数量键必须是 `quantity`**，`grantRewards` 只读它，写 `count` 会被静默跳过）：

```json
{
  "milestones": [
    { "percent": 25, "rewards": [{ "type": "item", "name": "强化券", "quantity": 5 }] },
    {
      "percent": 50,
      "rewards": [
        { "type": "item", "name": "强化券", "quantity": 10 },
        { "type": "exp", "name": "", "quantity": 5000 }
      ]
    },
    {
      "percent": 75,
      "rewards": [
        { "type": "item", "name": "史诗强化券", "quantity": 5 },
        { "type": "vitality", "name": "", "quantity": 20 }
      ]
    },
    {
      "percent": 100,
      "rewards": [
        { "type": "item", "name": "传说强化券", "quantity": 5 },
        { "type": "item", "name": "觉醒丹", "quantity": 1 },
        { "type": "vitality", "name": "", "quantity": 50 }
      ]
    }
  ]
}
```

> `type` 仅 `'item' | 'exp' | 'vitality'`；`vitality` 条目要求 `grantRewards` 的 `ctx.player` 已填充。

**`worldEvent.buffs` 结构**（全服增益，达成即生效，持续到本周期结束）：

```json
{
  "buffs": [
    { "percent": 25, "type": "cargoPods", "value": 1, "label": "每小时额外货舱 +1" },
    { "percent": 50, "type": "checkinExp", "value": 20, "label": "每日签到经验 +20%" },
    { "percent": 75, "type": "vitalityRegen", "value": 25, "label": "活力恢复速度 +25%" },
    { "percent": 100, "type": "challengeBox", "value": 1, "label": "挑战层每日奖励箱 +1" }
  ]
}
```

**为什么 buff 只选这四类**：它们全部落在**非 G9 冻结文件**里（见 §8.4），
本期不需要动 `combat-system.service.ts` 一个字。

> ⚠️ **读取方式统一约束**：4 个生效点**一律同步调用** `WorldEventService.getActiveBuffValues()`
> （返回 `{ cargoPods, checkinExpPct, vitalityRegenPct, challengeBox }`，内存缓存、cron tick 刷新、启动从 SystemConfig 预热）。
> **不得**让 `CheckinRewardService / ScheduleService / TimeSettleService` 反向 async 依赖 WorldEventService 的具体查询——
> 反向注入会与 `WorldEventService→CheckinRewardService` 成环（`CheckinRewardService` 不在 game.module exports）。
> 同步读缓存 = 零 async 传染、零环。

| buff type | 生效位置（文件 : 行） | 现状与改法 | 受 G9 冻结 |
| --- | --- | --- | --- |
| `cargoPods` 额外货舱 | `schedule.service.ts:805 dropCargoPods`，数量硬编码在 **`:820 for (let i = 0; i < 3; i++)`** | 改为 `3 + buff.cargoPods`；`ScheduleService` 在 `GameTasksModule`，须把 `WorldEventService` 加进 `game.module` **exports** 后构造注入 | ❌ 否（该文件 1138 行，无行数门禁） |
| `checkinExp` 签到经验 | `checkin-reward.service.ts:78 calcExp(cfg, consecutiveDays)`（同步、无 userId） | 加第三参 `expFactor = 1` 并在结果乘系数；调用点 `time-settle.service.ts:544` 先 await 取 `buff.checkinExpPct/100` 传入 | ❌ 否 |
| `vitalityRegen` 活力恢复 | `time-settle.service.ts:168-206`（**非** 61-73 时间基准段），公式单一源 `vitality.service.ts:61 recover()` | 系数加在调用处 `recover(current, elapsed * (1 + pct/100), max)`，**勿改 recover 内部** | ❌ 否 |
| `challengeBox` 挑战层奖励箱 | `time-settle.service.ts:378-388`，`boxCount` 在 **`:384`** | `Math.ceil(level/5) + buff.challengeBox` | ❌ 否 |
| ~~`dropRate` 全服掉率~~ | ~~`combat-system` 掉落链路~~ | G9 = 12573 **零余量**，**本期不做** | ✅ **是** |

### 5.5 展示与播报

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `worldEvent.announceOnMilestone` | boolean | `true` | 里程碑达成是否公屏播报 |
| `worldEvent.announceOnStart` | boolean | `true` | 新周期开启是否公屏播报 |
| `worldEvent.progressBroadcastStep` | number | `10` | 进度每跨过 N% 播报一次（0=关闭） |
| `worldEvent.panelTitle` | string | `星海远征` | 面板/活动名（可每期换，制造新鲜感） |
| `worldEvent.panelDesc` | string | 见 §6.4 | 面板副标题 / 背景故事 |

---

## 6. 指令设计

### 6.1 指令表（`server/prisma/seed.ts`）

```ts
{ name: '世界事件', alias: 'world-event,事件,sj', description: '查看全服世界事件进度与奖励', handlerKey: 'worldEvent', minRole: 'USER', sortOrder: 360 },
{ name: '领取世界奖励', alias: 'claim-world-reward,lqsjjl', description: '领取已解锁的世界事件奖励', handlerKey: 'worldEvent', minRole: 'USER', sortOrder: 361 },
{ name: '世界事件管理', alias: 'world-event-admin', description: '开启/结算/重置世界事件(管理员)', handlerKey: 'worldEvent', minRole: 'ADMIN', sortOrder: 1000 },
```

> ⚠️ **`sortOrder` 用 1000 不用 999**：999 已被现有 `管理` 指令占用（重复不报错但影响帮助/列表排序）。360/361 实测未占用。

**命名与落地注意事项**（v3 实测）：

- **seed 用 `upsert({ where:{name}, update:cmd, create:cmd })` 会拿代码覆盖 DB**（`seed.ts:417-423`，与 SystemConfig 的 `ensureDefaultConfigs` 只补缺相反）→ **新增指令必须重跑 seed**，否则指令表无这几行、handler 永远不会被分发到。
- **前缀冲突：实测无。** 枚举现有 284 条 name + 全部 alias 做双向 `startsWith` 比对，没有任何项是新名的前缀、也没有新名是现有项前缀。`世界事件` ⊂ `世界事件管理` 是唯一前缀对，但引擎优先级安全：带空格输入走 name 精确匹配（`command.service.ts:244`），无空格 `世界事件管理开启` 走最长前缀（`:312`）命中 `世界事件管理`。仍保留 §11.4「指令分发」用例兜底。
- **别名须全局唯一**：alias 精确匹配用 `allCmds.find()`（`:248-254`）按 DB 行序取首个，重复别名分发不确定；且 `sj` 这类 2 字别名会吞掉所有以 `sj` 开头的无空格输入——若担心可只保留 `world-event`/`事件`。提议别名实测均未占用。
- 备选方案：并入现有 `管理` 指令（`game/commands/admin-command.service.ts:96`）做子命令，彻底规避命名问题。

### 6.2 落地方式：独立 handlerKey 子域（**不写进 `game-command.handler.ts`**）

> 架构门禁硬要求（`architecture-guard.spec.ts`，v3 实测基线）：
> - **G5**：`game-command.handler.ts` 行数 ≤ 2041
> - **G1**：`game.service.ts` 行数 ≤ 1789（现 1783，仅 6 行余量，勿往此处加 handleXxx）
> - **G6**：`game.service.ts` 的 `handleXxx(` 方法数 ≤ 243
> - G5 报错原文：「新增指令一律新文件，不得继续写入 GameCommandHandler.dispatch 的分支」

因此必须新建子域：

| 文件 | 作用 |
| --- | --- |
| `server/src/modules/command/handlers/world-event.handler.ts` | 新建，实现 `CommandHandler` 接口（属性名是 `key`，非 `handlerKey`），含 3 个指令分支；照 `lottery-command.handler.ts` 用显式 `@Inject(WorldEventService)` |
| `server/src/modules/command/handlers/index.ts:26-44` | 把 `WorldEventHandler` 加进 `handlerProviders` 数组（工厂按 `handler.key` 建 map） |
| `server/src/modules/game/world-event.service.ts` | 新建，业务逻辑（周期管理 / 进度 / 发奖 / cron / getActiveBuffValues） |
| `server/src/config/world-event.config.ts` | 新建，纯常量模块（配置键 + 默认值），照**新版** `src/config/red-packet.config.ts`（避免 `system-config → game → system-config` 循环依赖） |
| `server/src/modules/game/game.module.ts` | **providers 与 exports 都注册** `WorldEventService`：`ScheduleService`（在 GameTasksModule）需注入它，故必须 export；`WorldEventService` 注入 `CheckinRewardService`（仅 providers 不 export）→ 二者必须同声明于 GameModule。**不要**在 `game-tasks.module.ts` 重复 provide（会得到两实例、两份 cron 运行锁） |

**方法签名约定**（与全项目一致，返回回执文案字符串）：

```ts
// world-event.service.ts
async viewPanel(userId: number): Promise<string>                    // 进度面板回执
async claimReward(userId: number, percent?: number): Promise<string> // 领取奖励
async adminCommand(userId: number, args: string[]): Promise<string>  // 管理指令（内部自鉴权）
```

> ⚠️ `minRole` 目前**不被引擎强制执行**（`command.service.ts:359-362` 是空实现）。
> 管理员指令必须**自己在 service 里查 `user.role`** 鉴权，照抄 `admin-command.service.ts:96`：
> ```ts
> const user = await this.prisma.user.findUnique({ where: { id: userId } });
> if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') return '权限不足，需要管理员权限';
> ```

### 6.3 管理员子命令

```
世界事件管理 开启 [目标值]     手动开启新周期（目标值可选，缺省按 baseGoal + 自动缩放）
世界事件管理 结算              立即结算当前周期（调试/活动收尾）
世界事件管理 重置              丢弃当前周期（不计入历史）
世界事件管理 目标 20000        调整当前周期目标
```

### 6.4 回执文案

**`世界事件`（进度面板）**

```
🌍 世界事件 · 星海远征
━━━━━━━━━━━━━━━━━━━━
异界的裂隙正在扩大，全使魔的战斗意志是世界唯一的屏障。

⏳ 周期：2026-W38（剩余 3 天 14 小时）
📊 进度：14,286 / 20,000（71.4%）
[██████████████░░░░░░] 71%

🏆 里程碑
  ✅ 25%  已达成 · 每小时额外货舱 +1
  ✅ 50%  已达成 · 每日签到经验 +20%
  ⏳ 75%  未达成 · 活力恢复速度 +25%（还差 714）
  ⏳ 100% 未达成 · 挑战层每日奖励箱 +1（还差 5,714）

🎁 可领取：2 项　→ 发送「领取世界奖励」
```

**`领取世界奖励`**

```
✅ 领取成功！
  · 强化券 x5
  · 强化券 x10
  · 经验 +5000
（第 2026-W38 周期 · 25% / 50% 里程碑）
```

**失败分支文案**（注意避开 `isSuccessfulAction` 的失败关键词黑名单，
`game-command.handler.ts:71/77` 命中「失败/错误/无法/未找到/冷却中」等会**阻止任务推进**）

| 场景 | 文案 |
| --- | --- |
| 无进行中周期 | `当前没有进行中的世界事件，下一周期即将开启` |
| 无可领奖励 | `暂时没有可领取的世界奖励，先把进度推上去吧` |
| 已领过 | `这项奖励你已经领过了（第 2026-W38 周期）` |
| 领取窗口已关闭 | `第 2026-W37 周期的奖励领取已关闭` |
| 权限不足 | `权限不足，需要管理员权限（ADMIN 或 SUPER_ADMIN）` |

**里程碑达成播报**（公屏，走 `broadcastSystem`）

```
🌍 全服里程碑！世界进度突破 50%
「每日签到经验 +20%」已对全服生效，持续至本周期结束。
距下一档 75% 还差 5,000，继续推进！
```

**新周期开启播报**

```
🌍 新的世界事件开启：星海远征（第 2026-W38 周期）
目标：全服击杀累计 20,000　周期：7 天
达成里程碑即可解锁全服增益，100% 达成更有全员奖励。
发送「世界事件」查看进度。
```

---

## 7. 进度计算与周期流转

### 7.1 进度读取（零侵入核心）

```ts
// world-event.service.ts
async currentProgress(cycle: WorldEventCycle): Promise<{
  current: number; goal: number; percent: number;
}> {
  // 唯一真相源：世界熟练度点数（内存权威 + 10s flush）
  const now = await this.globalProficiency.getPoints(WORLD_PROFICIENCY_NAME);
  const start = Number(cycle.startPoints) || 0;

  // 管理员下调过世界点数 → 差值变负，需自愈。两条路径都会触发：
  //   ① replacePoints 整表替换（admin.controller.ts:228/295）
  //   ② setWorldLevel 逆运算覆写（`管理 世界等级` → admin-command.service.ts:260）
  if (now < start) {
    this.logger.warn(`世界熟练度出现回退（${start} → ${now}），重置周期基准`);
    await this.resetCycleBaseline(cycle.id, now);
    return { current: 0, goal: Number(cycle.goalPoints), percent: 0 };
  }

  const current = now - start;
  const goal = Number(cycle.goalPoints) || 1;
  return { current, goal, percent: Math.min(100, Math.floor((current / goal) * 100)) };
}
```

> `GlobalProficiencyService.getPoints(name)` 是 public 方法（`global-proficiency.service.ts:218`），
> 返回**原始点数**（不是等级），正是差值计算所需。**无需改动该服务一行代码。**

### 7.2 周期流转状态机

```
  [无周期] ──cron/指令──→ ACTIVE ──到 endAt──→ SETTLED ──graceEndAt──→ [归档]
                            │                    │
                            │ 里程碑达成          │ 玩家仍可领奖
                            ↓                    ↓
                      写 reached + 播报      WorldEventClaim 判定幂等
```

**cron 任务**（`@Cron` 写在 `world-event.service.ts`；`ScheduleModule.forRoot()` 全局扫描，
`WorldEventService` 进 GameModule providers 即生效，**无需**在 `game-tasks.module.ts` 重复注册）：

```ts
@Cron('0 */10 * * * *')              // 每 10 分钟
async worldEventTick() {
  if (this.worldEventRunning) return;           // 运行锁，防重入
  this.worldEventRunning = true;
  try {
    await this.ensureActiveCycle();             // 无周期且 autoStart → 开新周期（含 period 对齐 + 任务池随机抽样）
    await this.checkMilestones();               // 检查并解锁里程碑（含播报）
    await this.settleIfDue();                   // 到点结算（按快照 endAt）
    this.maybeBroadcastProgress();              // 跨过 progressBroadcastStep% 时推 worldEvent:progress + 公屏
  } catch (err: any) {
    this.logger.error(`世界事件轮询失败: ${err?.message ?? err}`);  // 只告警，绝不抛出
  } finally {
    this.worldEventRunning = false;
  }
}
```

**开周期时的随机抽样**（与 `cycleId` 派生种子，保证幂等）：

```ts
function pickTask(pool: TaskDef[], cycleId: string, random: boolean): TaskDef {
  const usable = pool.filter(t => metricReady(t.metric));  // Phase1: 只留 kill
  if (!usable.length) return FALLBACK_KILL_TASK;
  if (!random) return usable.reduce((a, b) => (b.weight > a.weight ? b : a));
  // 简单可复现：FNV-1a(cycleId) → [0,1) → 加权区间
  const r = unitFromHash(cycleId);
  // …加权抽取…
}
```

> 照抄 `schedule.service.ts:970` 的运行锁范式；cron 抛错会打满日志。

**结算幂等**（照抄 `red-packet.service.ts:569-573` 的条件更新抢占）：

```ts
// 多实例/重入只结算一次
const acquired = await this.prisma.worldEventCycle.updateMany({
  where: { id: cycle.id, status: 'ACTIVE' },
  data: { status: 'SETTLED', settledAt: new Date(), finalPoints: now },
});
if (acquired.count === 0) return;   // 已被别人结算，直接返回
```

### 7.3 目标自动缩放

结算时按完成度算下周期目标（`goalAutoAdjust=true` 时）：

```ts
const ratio = actual / goal;                                  // 上周期完成度
const factor = Math.min(goalAdjustMax, Math.max(goalAdjustMin, ratio));
const nextGoal = Math.max(1, Math.floor(goal * factor));
```

例：目标 20000 实完 34000（170%）→ factor=1.5 → 下周期 30000。

---

## 8. 奖励发放

### 8.1 发放出口

**直接复用 `CheckinRewardService.grantRewards`**（`checkin-reward.service.ts:125`），
它已支持 `item` / `exp` / `vitality` 三种类型并有完善的容错。

```ts
const texts = await this.checkinReward.grantRewards(userId, entries, { player });
```

> 奖励条目结构与签到完全一致（`{ type, name, quantity }`，**数量键 `quantity`**），
> 解析/规范化逻辑照抄 `normalizeRewards` / `normalizeGroups` 的写法即可。

**货币类奖励**：若后续需要发钻石/数据核心，走统一入口
`setCurrencyAmount(player, '钻石', value, backpack)`（`player.service.ts:858`），
`CurrencyLog` 审计由 `savePlayer` / `mutate` 管道**自动生成**，无需手写。

### 8.2 幂等与离线到账

```ts
// 1) 唯一约束做幂等（与 RedPacketClaim 同构）
try {
  await this.prisma.worldEventClaim.create({
    data: { cycleId: cycle.id, userId, percent },
  });
} catch {
  return '这项奖励你已经领过了';    // 违反 @@unique → 已领过
}

// 2) 先记账后发货；发货失败要回滚记录，避免"领了但没到账"
try {
  await this.checkinReward.grantRewards(userId, entries, { player });
} catch (err) {
  await this.prisma.worldEventClaim.delete({ where: { id: claim.id } });
  throw err;
}
```

**离线玩家**：奖励走 `addToBackpack` 直接写库，**不要求在线**（照抄红包退款 `red-packet.service.ts:557`）。
在线通知（`emitToUser`）只是附加，不是发奖路径的一部分。

### 8.3 批量发奖（若未来做「达成即全员直发」）

不要照抄 `handleWealthRanking` 的无分页全表扫描（`ranking-command.service.ts:261`）。
正确范式（`red-packet.sweepExpired`）：

- `findMany` + `take: BATCH_SIZE` 分批
- 单人发奖包进 `playerService.addToBackpack`（内部 `enqueueUserWrite` 串行）
- 单人 `try/catch` 兜底，失败不中断整批

### 8.4 为什么本期不做「全服掉率 buff」

`combat-system.service.ts` 被 G9 **行数冻结在 12573 行 = 零余量**（`architecture-guard.spec.ts:596-601` 的 `PHASE2_FILE_LINE_BASELINES`），
且统计口径是 `wc -l`，**注释也算行** → 本期一行都不能加。掉率 buff 需要在掉落链路注入倍率，必然加行。

若确需此 buff，两条路：
1. 把倍率计算抽到**新的 util 文件**（`world-event-buff.util.ts`），`combat-system` 只加 1~2 行调用 → 仍需上调 G9 基线 + PR 评审；
2. 改挂在**不受冻结的调用方**（如 `delayed-settle.service.ts` 结算出口）→ 优先选这条。

---

## 9. 广播与前端呈现

### 9.1 后端广播

| 场景 | 方式 | 是否落库 |
| --- | --- | --- |
| 周期开启（含抽到的任务名） / 里程碑达成 | `chatService.broadcastSystem('世界频道', text)`（`chat.service.ts:57`） | ✅ 落 `ChatMessage(type='system')` |
| 进度条实时刷新 | `chatService.emitToChannel('世界频道', 'worldEvent:progress', {...})`（`:111`） | ❌ 不落库 |
| 个人领取成功 | `chatService.emitToUser(userId, 'worldEvent:claimed', {...})`（`:100`） | ❌ 不落库 |

> 广播落库的价值：历史消息可刷新回放，天然成为**事件留痕**，省一张埋点表。
> **推送节奏**：`worldEventTick` 每 10 分钟算一次 percent；仅当跨过 `progressBroadcastStep`（默认 10）的整数倍
> 或里程碑达成时才 emit，避免刷屏；前端同时用本地增量做「丝滑」过渡。

### 9.2 只读 API（写操作一律走指令，不新增写接口）

> 项目约定：写操作零新增接口，一律发与 QQ 端逐字相同的指令，保证单写路径、结算不双轨。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/game/world-event/current` | 当前周期 + 进度 + 里程碑 + 本人可领状态 + **period/taskTitle** |

返回体草案（v2）：

```json
{
  "cycleId": "2026-W38",
  "period": "week",
  "taskKey": "kill_wave",
  "title": "清扫裂隙",
  "description": "异界的裂隙正在扩大，全使魔的战斗意志是世界唯一的屏障。",
  "startAt": "2026-09-14T00:00:00.000Z",
  "endAt": "2026-09-21T00:00:00.000Z",
  "current": 14286,
  "goal": 20000,
  "percent": 71,
  "milestones": [
    { "percent": 25, "reached": true, "buffLabel": "每小时额外货舱 +1" },
    { "percent": 50, "reached": true, "buffLabel": "每日签到经验 +20%" },
    { "percent": 75, "reached": false, "buffLabel": "活力恢复速度 +25%" },
    { "percent": 100, "reached": false, "buffLabel": "挑战层每日奖励箱 +1" }
  ],
  "claimable": [25, 50],
  "status": "ACTIVE"
}
```

`worldEvent:progress` Socket 载荷（轻量，只推条）：

```json
{
  "cycleId": "2026-W38",
  "current": 14500,
  "goal": 20000,
  "percent": 72,
  "milestoneJustReached": 75
}
```

**OpenAPI**：新增端点必须同步更新 `docs/openapi.json`（项目规范要求可导入 Apifox）。
建议在 `world-event.controller.ts` 上加 `@ApiOperation` / `@ApiResponse` 装饰器后重新导出。

### 9.3 前端 · 实时进度 UI（v2 强化）

**观看路径（三层，由轻到重）**：

```
 ① Chat 顶部细进度条（常驻，不挡聊天）
      │  点击 / 展开按钮
      ▼
 ② 完整事件面板（Teleport 弹层，仿 RedPacketMinePanel）
      │  里程碑达成瞬间
      ▼
 ③ game:highlight 高光 + 公屏播报（社交可见性）
```

| 层 | 位置 | 形态 | 数据源 |
| --- | --- | --- | --- |
| ① 常驻细条 | `ChatView.vue` `chat-header` 下方 | 高 6–8px 渐变条 + 右侧 `71% · 3天14时` 文案；里程碑刻度 25/50/75/100 | 首屏 GET `/current`，之后只听 `worldEvent:progress` |
| ② 完整面板 | 点击细条展开；或指令回执内嵌 | 标题（任务名+周期号）/ 大进度条 / 里程碑四档卡片（已达成✓+buff文案 / 未达成还差X）/ 可领按钮 / 历史3期摘要 | 同上 + claimable |
| ③ 高光播报 | 公屏 | 复用 `highlight.service.ts` + `broadcastSystem` | 里程碑事件 |

**面板布局示意**（桌面宽，手机纵向堆叠）：

```
┌──────────────────────────────────────────────┐
│ 🌍 清扫裂隙 · 2026-W38          [周] [⟳][✕] │
│ 异界的裂隙正在扩大……                          │
│ ████████████████░░░░░░  71%  · 还剩 3天14时   │
│ 14,286 / 20,000                              │
│                                              │
│  ✅ 25% 货舱+1   ✅ 50% 签到经验+20%           │
│  ⏳ 75% 活力+25%（还差714） ⏳ 100% 奖励箱+1    │
│                                              │
│  [领取已解锁奖励 ×2]      近3期: 100% 86% 42% │
└──────────────────────────────────────────────┘
```

| 实现落点（v3 核查更正） | 说明 |
| --- | --- |
| `web/src/components/WorldEventBar.vue` | **新建**：细条 + 可展开完整面板。细条照 `PendingActionBar.vue` 的 `.pa-track`>`.pa-fill :style="{width: pct+'%'}"`（高 4–6px、`var(--accent-gradient)`、`transition:width .9s`），里程碑刻度照 `HomeBuildGuide.vue:202` 的 track `position:relative`+绝对定位 tick；面板照 `RedPacketMinePanel.vue` 结构（**实为居中弹窗非抽屉**，`Teleport to="body"`>`.rpm-overlay`>`@click.self=close`>`.rpm-modal`），类名前缀改 `we-`，`defineEmits(['close','notify'])`，组件**自拉数据** |
| `ChatView.vue` | `<WorldEventBar />` 插在 `</header>`（**≈L614**）之后、`<div class="messages">`（**≈L619**）之前；不改消息流逻辑 |
| Socket 监听 | **无 `utils/socket.js` 封装**，ChatView 在 `onMounted` 的 `io()` 注册块内加 `socket.on('worldEvent:progress', cb)`（`onUnmounted` 仅 `socket?.disconnect()`，无逐项 off，照此即可）；`game:highlight` 常量已存在（`utils/gameHighlight.js`） |
| `web/src/api/index.js` | 末尾 `export default http` 前加 `export const worldApi = { getCurrent: () => http.get('/game/world-event/current') }`；baseURL 已含 `/api`，**响应拦截已 `return res.data`**（信封 `{code,data,message}`），组件取 `res.data`；写操作（领取）走发指令通道，不新增写 API |
| `web/src/config.js` | 末尾具名导出 `WORLD_EVENT_UI`（颜色/里程碑文案/空态/`refreshMs`），照 `HOME_YARD_CONFIG`/`RED_PACKET_CLIENT_CONFIG` 分块风格；`import { WORLD_EVENT_UI as WE } from '../config'` |
| 倒计时 | `import { serverNow } from 'utils/serverClock'`（存在，`serverNow()=Date.now()+offset`，socket `connect` 内 `syncServerClock()` 已调）；`endAt - serverNow()`，1s `setInterval`，`onBeforeUnmount` 清 |

**手机端**：细条仍常驻 header 下；完整面板用纯 CSS `@media (max-width:640px){ .we-modal{ width:100vw; max-height:100dvh; border-radius:0 } }` 铺满（项目无 JS 布局分支、无全屏抽屉先例，红包面板即靠 `min(420px,100vw-32px)` 自适应，照此族写法）。

**Q 群纯文本**：面板文案必须能降级为 §6.4 的字符进度条，不依赖颜色。

> 前端图标/文案/颜色全部进 `config.js`，避免硬编码。

---

## 10. 埋点设计

### 10.1 现有埋点（自动获得，无需开发）

| 埋点 | 位置 | 覆盖内容 |
| --- | --- | --- |
| `CommandLog` | `command.service.ts:642-663` | 每条 `世界事件` / `领取世界奖励` 调用：指令名、回执、耗时、来源（web/bot） |
| `ChatMessage(type='system')` | `chat.service.ts:57` | 周期开启、里程碑达成的**全量留痕**（含时间戳） |
| `CurrencyLog` | `player.service.ts:1509` | 若发货币，变动自动审计 |

### 10.2 本期新增埋点

**① 周期归档（结构化，落 `WorldEventCycle` 表）**

结算时写入 `finalPoints`、`reached`（各档达成时刻）、`settledAt`。
本身就是周期维度的完整埋点，支持复盘「第 N 周期完成度 = X%」。

**② 参与率（新增配置项，结算时追加）**

| key | type | 默认 | 说明 |
| --- | --- | --- | --- |
| `worldEvent.history` | json | `[]` | 每周期归档一条，最多保留 20 条 |

```json
[
  {
    "cycleId": "2026-W38",
    "goal": 20000,
    "actual": 34120,
    "percent": 100,
    "reachedMilestones": [25, 50, 75, 100],
    "claimedUsers": 87,
    "activeUsers": 120,
    "settledAt": "2026-09-21T00:00:05.000Z"
  }
]
```

> `activeUsers` 口径：取**事件周期内有过 CommandLog 的去重 userId**
> （`prisma.commandLog.findMany({ where: { createdAt: { gte, lt } }, distinct: ['senderId'] })`），
> 比 `updatedAt` 近 5 分钟估算准确（后者会被后台自动保存误判，见 `admin.service.ts:876-877`）。

**③ 关键指标（运营看板）**

| 指标 | 计算方式 | 用途 |
| --- | --- | --- |
| 周期完成度 | `actual / goal` | 校准 `baseGoal` |
| 参与率 | `claimedUsers / activeUsers` | 判断玩法是否被感知 |
| 里程碑达成分布 | `reachedMilestones` 长度分布 | 判断难度曲线是否合理 |
| 面板查看频次 | `CommandLog where command='世界事件'` 计数 | 判断玩家是否关注进度 |

### 10.3 不建议做的埋点

- ❌ 新增独立 `Analytics` / `EventLog` 表：项目无此先例，`ChatMessage` + `CommandLog` + 周期表已足够；
- ❌ 在 `combat-system` 埋点：会撞 G9 行数冻结。

---

## 11. 改动清单与分期

### 11.1 文件级改动清单（v3）

| # | 文件 | 改动 | 门禁风险 |
| --- | --- | --- | --- |
| 1 | `server/prisma/schema.prisma` | 新增 `WorldEventCycle`（含 `period`/`taskKey`/`taskTitle`） / `WorldEventClaim` | 无 |
| 2 | `server/src/config/world-event.config.ts` | **新建**：配置键 + 默认值 + 任务池结构类型（照**新版** `src/config/red-packet.config.ts` 纯常量惯例） | 无 |
| 3 | `server/src/modules/system-config/system-config.service.ts` | `DEFAULT_CONFIGS` 追加 `worldEvent.*`（value 一律字符串，JSON.stringify；label/description 一次写定，重启会用代码覆盖库同字段） | 无 |
| 4 | `server/src/modules/game/world-event.service.ts` | **新建**：周期对齐（day/week/month）/ 任务抽样 / 进度 / 里程碑 / 结算 / 发奖 / cron / progress 推送 / **getActiveBuffValues 同步缓存** | 无（新文件不受冻结） |
| 5 | `server/src/modules/command/handlers/world-event.handler.ts` | **新建**：`key='worldEvent'` 子域，3 个指令分支（显式 `@Inject`） | 无 |
| 6 | `server/src/modules/command/handlers/index.ts` | `handlerProviders`（L26-44）追加 `WorldEventHandler` | 无 |
| 7 | `server/src/modules/game/game.module.ts` | **providers + exports 都注册** `WorldEventService`（`ScheduleService` 在 GameTasksModule 要注入它）；`controllers` 加 `WorldEventController` | 无 |
| 8 | ~~`game-tasks.module.ts`~~ | **无需改动**：cron 由 `ScheduleModule` 全局 discovery，`WorldEventService` 进 GameModule providers 即生效；重复 provide 会得到两实例两运行锁 | — |
| 9 | `server/prisma/seed.ts` | 追加 3 条指令（`commands` 数组 L51-351；sortOrder 360/361/**1000**）；**seed upsert 覆盖 DB，须重跑 seed** | 无 |
| 10 | `server/src/modules/game/schedule.service.ts` | `cargoPods` buff：`dropCargoPods` 内**硬编码 `:820 for i<3`** 改 `3 + buff.cargoPods`（同文件 `getConfigValue` L1110） | ⚠️ 无行数冻结（1138 行），注入 WorldEventService |
| 11 | `server/src/modules/game/checkin-reward.service.ts` | `calcExp`（`:78`）加第三参 `expFactor=1` 并乘系数 | 无 |
| 12 | `server/src/modules/game/commands/time-settle.service.ts` | 活力恢复系数加在 **`:168-206`** 调用 `recover()` 处（勿改 `vitality.service.ts:61` 内部）；挑战箱 `:384 boxCount += buff.challengeBox`；`:544` 传 `checkinExpPct` | 无 |
| 13 | `server/src/modules/game/world-event.controller.ts` | **新建**：`@Controller('game/world-event')` `GET current`（只读，`req.user.userId`，`JwtAuthGuard`） | 无 |
| 14 | `docs/openapi.json` | 同步端点文档（Apifox 可导入） | 无 |
| 15 | `server/test/world-event.spec.ts` | **新建**：见 §11.4（含 period 边界 / 随机抽样稳定性） | 无 |
| 16 | `web/src/components/WorldEventBar.vue` | **新建**：顶部细条（照 `PendingActionBar`）+ 展开面板（照 `RedPacketMinePanel`，`we-` 前缀，居中弹窗） | 无 |
| 17 | `web/src/views/ChatView.vue` | `</header>`(≈L614) 后插入 `WorldEventBar`；`onMounted` socket 块加 `worldEvent:progress` 监听 | 无 |
| 18 | `web/src/api/index.js` | `export const worldApi = { getCurrent }` | 无 |
| 19 | `web/src/config.js` | 末尾具名导出 `WORLD_EVENT_UI` 文案/颜色 | 无 |

### 11.2 Phase 1（本期，建议 1.5~2 周 · **v2 范围**）

- 数据模型（含 `period` / `taskKey`） + 配置骨架（含任务池） + 周期流转（day/week/month 对齐 / 开 / 结算 / 归档）
- **随机抽样**（`taskSource=pool`） + 进度读取（世界熟练度差值） + 里程碑解锁 + 播报
- `世界事件` 面板指令 + `领取世界奖励` + 幂等领取
- **先跑一个只观测不发奖的周期**校准 `baseGoal`（建议先 `period=week` 观测，再开 `day` 做日常）
- buff 只上 `cargoPods` + `checkinExp`（最安全、最好实现）
- **前端**：`WorldEventBar` 顶部细条 + 展开面板 + `worldEvent:progress` 监听

### 11.3 Phase 2（数据验证后）

- 个人贡献榜：`WorldEventContribution` 表（草案见下），挂钩指令流水线
  ```prisma
  model WorldEventContribution {
    id        Int      @id @default(autoincrement())
    cycleId   Int
    userId    Int
    amount    Float    @default(0)
    updatedAt DateTime @updatedAt

    @@unique([cycleId, userId])
    @@index([cycleId, amount])
  }
  ```
  挂钩点建议：`command.service.ts:114-116`（`recordRankingStats` 附近，**该文件无行数冻结**），
  **不要**挂到 `combat-system`（G9）。
- 多指标落地：`gather` / `craft` / `challenge` 真正计数（任务池里已有占位，埋点就绪后自动入池）
- 剩余两类 buff（`vitalityRegen` / `challengeBox`）
- 贡献排名奖励（Top N 额外奖励）

### 11.4 必须覆盖的测试

| 场景 | 断言 |
| --- | --- |
| 进度计算 | 差值正确；`now < start` 时自愈不崩 |
| **周期边界 day/week/month** | 固定时钟注入：day 跨 0 点切周期；week 跨周一；month 跨 1 日；`cycleId` 格式分别为 `2026-09-17` / `2026-W38` / `2026-09` |
| **period 改配置** | 当前周期仍按快照 `period` 结束；下一周期用新 `period` |
| **任务池随机抽样** | 同一 `cycleId` 多次 `pickTask` 结果一致；池里只剩 gather 且埋点未就绪时回退 kill |
| 里程碑解锁 | 跨过阈值只解锁一次；`reached` 记录达成时刻 |
| 结算幂等 | 并发两次结算只生效一次（`updateMany` count=0 分支） |
| 领取幂等 | 同一玩家同档位重复领取被拒（唯一约束） |
| 领取窗口 | `graceEndAt` 之后不可领 |
| 离线到账 | 不在线玩家背包正确增加 |
| 发货失败回滚 | `grantRewards` 抛错时 `WorldEventClaim` 记录被删除 |
| 管理员鉴权 | 非 ADMIN 调用 `世界事件管理` 被拒 |
| 指令分发 | `世界事件` 与 `世界事件管理` 不被前缀匹配互相吞掉 |
| 配置容错 | `rewards` / `buffs` / `taskPool` 被改成非法 JSON 时回落默认且不影响其他功能 |
| progress 推送节奏 | percent 跨 step 才 emit；同 step 内重复 tick 不重复广播 |

**回归门禁**：跑全量 `npm test`，重点确认
`architecture-guard.spec.ts`（G1/G5/G6/G9 冻结）与
`title-achievement-sources.spec.ts`（若新增成就需双写 markers + tasks）全绿。

---

## 12. 边界与注意

| 项 | 说明 |
| --- | --- |
| **世界熟练度是内存权威** | 10s flush，进程强杀最多丢 10s 增量。对周级周期可忽略；`onModuleDestroy` 会 flush |
| **管理员下调世界点数会打乱差值** | 两条路径：`replacePoints` 整表替换（`admin.controller.ts:228/295`）与 `setWorldLevel` 逆运算覆写（`管理 世界等级` → `admin-command.service.ts:260`）。差值转负时自愈（重置基准 + 告警），但应在说明里提示慎用 |
| **进度只增不减** | 与「世界等级」同构，玩家不会有「进度被打回去」的挫败感 |
| **未达成没有惩罚** | 世界等级照常上涨（原有机制不变），只是拿不到额外奖励 |
| **多实例部署** | 结算用 `updateMany` 条件更新抢占；cron 运行锁仅单实例内有效，跨实例靠数据库状态机 |
| **Q群与网页同源** | 指令走统一引擎，QQ 端回执是纯文本，面板要能在无 UI 的聊天窗里读清楚 |
| **指令名前缀冲突** | `世界事件` / `世界事件管理` 必须在测试中覆盖分发优先级（§6.1） |
| **成就双写** | 若后续加「参与世界事件」类成就，必须同时写 `markers` 与 `taskService.advance`，否则 `title-achievement-sources.spec.ts` 会红 |
| **不要往 `game.service.ts` 加 `handleXxx`** | G1 + G6 双重拦截，新指令一律走独立 handlerKey 子域 |
| **注释也算行数** | G9 统计口径是 `wc -l`；本期全程新建文件，不触碰冻结文件 |

---

## 13. 与后续多人玩法的衔接

本设计是「第一期 · 合作型多人」的地基，后续可直接复用：

| 后续玩法 | 复用本设计的什么 |
| --- | --- |
| 世界 Boss 共享血条 | 周期状态机、结算幂等、广播播报、领取记录结构 |
| 异步镜像天梯 PVP | 周期即赛季；`WorldEventCycle` 可直接承载赛季概念 |
| 悬赏 / 委托板 | 配置驱动的奖励表结构、`grantRewards` 发放出口 |
| 领地争夺 | 里程碑达成播报、全服 buff 生效框架 |

**验证顺序建议**：本玩法跑通一个完整周期后，用「参与率」和「周期完成度」两个指标判断
玩家是否买账——若参与率 > 40%，说明「全服共同目标」这条路走通，可以往对抗型玩法推进；
若 < 15%，说明玩家对多人内容无感，应先回到单机深度（Build 分化、不可逆选择）而非继续加多人玩法。
