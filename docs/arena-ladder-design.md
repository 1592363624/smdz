# 使魔竞技场 · 镜像天梯（异步 PVP）设计

> 状态：v1 服务端与前端已实现，待 `prisma db push` + `prisma:seed` 上线
> 日期：2026-09-21（名次互换制改版）
> 一句话：玩家把当前配置冻结成「角斗镜像」挂上天梯，别人挑战镜像 → 系统自动跑完整场战斗 → 出战报。
> 打的是镜像，**不动任何真实资产**：输了只掉名次，不掉装备、不掉经验、不掉活力、不引怪、不广播。
> 天梯**没有积分**：只能挑战排在自己前面的人，打赢就顶替他的名次、他退到自己的旧位置。

## 1. 为什么是镜像而不是实时 PVP

实时 PVP 需要双方同时在线、需要战斗链路可重入、需要处理"打着打着对方下线"。异步镜像把这三个问题一次性消掉：

- 战斗可以在**任意时刻、对任意离线玩家**发起，结算完全无头（不进地图、不进玩家写锁）；
- 镜像是**冻结快照**，主人换装不影响已挂出的榜单，赛季内攻防两侧口径一致；
- 失败代价只有名次，可以放开手打，无需资产保护规则。

## 2. 数据模型（全部新表，`Player` 宽表零改动）

| 表 | 作用 | 关键字段 |
| --- | --- | --- |
| `ArenaSeason` | 赛季与结算幂等 | `no` / `startAt` / `endAt` / `status` / `rewardSnapshot` / `settleInfo` |
| `ArenaProfile` | 玩家天梯状态 | `rating`（**席位号**）/ `bestRank`（列名沿用 `peakRating`）/ `tier` / `wins`/`losses`/`draws` / `streak` / `daily{lastDate,used}` / `avoid` |
| `ArenaMirror` | 角斗镜像（冻结快照） | `ownerId` / `seasonId` / `snapshot` / `power` / `level` / `rating`（席位号冗余，跟主人同步）/ `version` |
| `ArenaMatch` | 战报存档 | `winner` / `rounds` / `durationSec` / 双方席位 `ratingBefore/After` / `entryCost` / `report{mode,seats,ranks}` |
| `PlayerPrivilege` | 可授予/可到期撤销的**功能特权** | `key` / `source` / `expiresAt` / `revokedAt` |
| `PlayerAvatarFrame` | 头像框（拥有 + 单一佩戴） | `frameKey` / `source` / `equipped` |

镜像与战报只存 JSON，赛季删除即整体失效。

**席位号（`rating` 列）与名次（对外口径）是两回事**：

- 席位只是排序键，**越大越靠前**；名次 = 按席位降序后的序号，玩家与后台文案、段位、赛季奖励读的都是名次。
- 新入榜者拿「当前最低席位再往后一名」（空榜第一人拿 1 号席位），所以席位长期会往 0/负数走 —— 这是刻意的：
  插入永远排在末尾，不需要发初始分，也没有可搬运的数值。
- 席位唯一的变化动作就是**互换**：打赢的拿到对方席位，输的拿到对方旧席位，两人席位集合恒定。
- 换季时 `compactSeats` 按最终名次把席位压回 `N..1`（`keep` 口径下即「按上季末名次继承席位」）；
  重排只在这一个时刻做（榜单已冻结，没有人正在打）。
- `bestRank` 是「本赛季达到过的最好名次」（0=还没上过榜），只进不退，提交镜像与打赢换位两处都记。
- 列名 `rating` / `peakRating` 是积分制遗留，用 `@map` 保持库表不变，语义已在 schema 注释里改成席位/最好名次。

## 3. 战斗结算：复用现有伤害引擎，跑在无头快照上

**不复制伤害公式**（红线：单一真相源）。结算器只做「时间轴 + 三池扣减 + 判定」，数值全部走 `CombatSystemService` 现成公共函数：

| 用途 | 复用的唯一实现 |
| --- | --- |
| 属性块（含三池上限、命中/闪避/暴击/易伤/世界等级差距） | `buildAttackerBonus(player, playerData)` |
| 武器解析（伤害/属性系数/冷却/特效语义） | `getWeaponData(actor, weaponIndex)`（本次由 `private` 提为公开，行为不变） |
| 命中率 / 命中判定 / 暴击判定 | `calcHitRate` / `checkHit` / `checkCrit` |
| 单次伤害（三段评级、贯穿、侵彻、三层抗性、**三池分伤 `poolDamage`**） | `calcDamage(...)` |

时间轴模型：双方各自按**在手武器的冷却**推进（`t=0` 同时可出手，之后各自 `+冷却`），先出手者先结算；每次命中按 `poolDamage` 依次扣 护盾→装甲→生命。
判定：任一方生命 ≤0 立即分胜负；到 `arena.battleTimeLimitSec`（默认 180s）仍未分则按剩余生命比例判定，相等记平局（双方名次不变，次数照耗）。

**v1 明确不做**（不做假装有）：主动使魔技能、召唤物/宠物助战（`buildAttackerBonus` 的地图宠物项在无头场景为 0）、免死复活链路（军姬/死亡行者/石中剑）、战斗内三池回满与吸血、载具与地精玩法。镜像只保证「面板属性 + 武器伤害」同源的对抗，这些偏 PVE 的机制不进竞技场，v2 再按需扩。

## 4. 天梯规则

- **名次互换（没有积分）**：只能挑战**排在自己前面**的人。打赢 → 自己拿到对方的席位、对方退回自己原来的席位（名次互换）；
  打输或平局 → 双方席位都不动。段位由**名次**推导（`arena.tierConfig` 是名次区间表 `[{key,name,rankFrom,rankTo,tone}]`，
  `rankTo=0` 表示不设上限，后台可改名字与区间）。
  这套规则本身就把「喂分」变成了不成立的命题：**没有可搬运的数值**，小号无法把任何东西倒给主号；
  想让某人排到前面，只能自己真的打赢前面的人，而被打赢的那个人会掉到自己的旧位置 —— 顶人的代价是自己的名次。
  剩下的只有「前面的人故意站着让小号打」这种共谋，它同样要付出被路人在前面截胡的风险，且名次不会凭空增长。
- **一顺位往上打**：`arena.challengeRankWindow` **默认 1**，只能打紧挨在自己前面的那一名，想碰更高的人必须先赢眼前这个；
  调成 N 允许跳 N 名，设 0 表示只要求「排名更高」、不限差多少（放开跳级狙击榜首）。
- **练手局（免费、不计成绩）**：打**排名不高于自己**的镜像不再被拒，而是判为练手局 —— 完整跑一场并出战报，但
  不扣入场消耗、不占每日挑战次数、双方席位与名次一律不动、也不计进胜败场次（`ArenaMatch.report.mode='practice'`
  与 `entryCost.mode='practice'` 是审计上分辨它的依据，四列席位前后相等）。
  这样玩家被防连打卡住、或当日额度用光时仍有事可做，而练手既刷不出胜率也刷不出参与奖场次；
  唯一保留的约束是**防连打冷却照样吃** —— 免费的东西只能靠冷却防止被拿来对着同一个人无限刷情报。
  模式判定与名次门在同一处、同一把锁内完成（`rankGateCheck`）：判据若留在锁外，排队期间守方被顶下去就会把
  本该换位的正式局漏判成练手局、或反过来让打赢的人掉到更差的席位。
- **开榜初始名次按战力**：系统刚上线、全服还没有任何天梯档案时，`seedInitialSeats()` 逐人现算战斗力，
  按降序发下 `N..1` 的初始席位（同战力按 userId 升序定序），而不是让榜首等于「谁先发送提交镜像」。
  只建档案**不建镜像** —— 没参与过竞技场的人不该平白变成别人能打的靶子，席位在他第一次提交镜像时兑现到榜上。
  开关 `arena.rankInitByPower`（默认开）与人数上限 `arena.rankInitLimit`（默认 500：`Player` 没有存战力列，只能逐人算）；
  候选粗筛口径与「排行榜」一致（`level ≥ arena.minLevelToEnter` 且已选使魔）。
  触发点是每小时的赛季巡检，**不是启动钩子**（真实库套件与开发 watch 会反复 boot 整个应用，挂 OnModuleInit 等于每次重启都扫一遍全服）；
  上线当天想立刻生效发 `竞技场管理 初排` 即可。表里已有档案时两条路径都是无操作，不会覆盖已经打出来的名次。
- **提交镜像**：指令 `竞技场提交`（别名 `提交镜像`）。用当前玩家数据算一次 `buildAttackerBonus` + 武器列表，冻结入库；已有镜像则覆盖并 `version+1`（文案提示「镜像已刷新」）。提交不改席位。
- **榜单**：指令 `竞技场`（本服前 20 + 自己的位置）。分页 `竞技场 2`。
- **挑战**：`挑战镜像 <榜单序号>` 或 `挑战镜像 <玩家名>`。攻击方用**当前**配置现算快照，防守方用库里的冻结镜像。
- **每日次数**：`arena.dailyChallengeLimit`（默认 10），懒重置（`daily.lastDate` 对 `localTodayString` 口径）。
- **入场消耗**：`arena.entryMode` = `free` / `vitality` / `ticket`。活力走 `Player.vitality`（不足直接拒绝，不进战斗）；门票为背包道具（`arena.entryTicketItem`，默认「竞技场门票」，结算时按名扣减）。刷新镜像自身的消耗同一套口径（`arena.submitMode`），互不影响次数计数。
- **防连打**：同一镜像 `arena.avoidRepeatHours`（默认 6）小时内不能重复挑战（记在 `ArenaProfile.avoid`）。正式局与练手局共用这条冷却。
- **资产保护**：结算全程不写 `Player`（除入场消耗的活力/门票），不调 `savePlayer`，不碰地图/标记/聊天广播。挑战前后战斗力快照、背包、经验、称号一律不变。

## 5. 赛季与可配置奖励

赛季生命周期由 `ArenaSeasonService` 每小时巡检（`@Cron('7 * * * *')` + 进程内重入位，配置 `arena.seasonLengthDays` 默认 30）：
到期 → 按**名次**（席位降序）排名 → 依 `arena.seasonRewards` 发奖 → `status=SETTLED` + `settleInfo` 复盘快照
→ 按最终名次把席位压回 `N..1` → 开下一赛季（镜像清空需重新提交，`ArenaProfile` 席位按 `arena.seasonCarry` 继承：
`keep`=沿用上季末名次 / `reset`=重头排队；写成别的值一律按 `keep` 处理，积分制时代的 `softReset` 已随之删除）。
卡在 `SETTLING` 超过 10 分钟的赛季（进程被杀、结算中途抛错）会被下一次巡检重新抢占，不会永久锁死。

**奖励条目复用签到发放出口** `CheckinRewardService.grantRewards`，本次把类型从 `item|exp|vitality` 扩到 `title|frame|privilege`：

```jsonc
// arena.seasonRewards（SystemConfig，type=json，group=arena）
{
  "ranks": [
    { "from": 1, "to": 1,
      "titles": ["竞技场之王"],
      "frames": ["arena_champion"],
      "privileges": [{ "key": "batchGather", "days": 30, "reason": "赛季冠军" }],
      "rewards": [{ "type": "item", "name": "凭证", "quantity": 30 }] },
    { "from": 2, "to": 3, "frames": ["arena_elite"], "rewards": [...] },
    { "from": 4, "to": 10, "rewards": [...] }
  ],
  "participation": { "minMatches": 10, "titles": ["天梯常客"], "rewards": [...] }
}
```

名次档、称号、头像框、资源、特权键与天数全部在后台改，**不需要发版**。发放写 `ArenaMatch`/`settleInfo` 之外的审计行（`Privilege`/`Frame` 表自带 `source`，称号写 `Player.titles`）。

头像框定义同样可配：`arena.avatarFrames` = `[{key,name,tone,description}]`，`tone` 是给前端的渐变/描边标识。v1 展示位：竞技场面板、天梯榜、战绩列表（服务端文本 + 竞技场页）。它是一次「装扮数据 + 佩戴」的权威实现，后续要铺到聊天头像只需在既有消息负载上带 `frame` 字段。

## 6. 特权：把「批量采集」从角色判定改成能力判定

现状（`gather-panel.service.ts`）：`const isAdmin = role === 'ADMIN' || 'SUPER_ADMIN'` → 只有后台角色能在野外一次采 N 次。

改造：
1. 新增 `PlayerPrivilege` 表 + `EntitlementService`（`grant` / `revoke` / `active` / `isActive`），到期或撤销自动失效；
2. 采集口读实时权限：管理员判定保留（后台测试/活动照常绕过），**额外**允许持有 `batchGather` 特权的玩家；
3. 特权持有者的批量倍率上限独立配置（`arena.batchGatherPrivilegeMax`，默认 10），管理员仍不受限——避免玩法奖励变成无上限产资源；
4. 开始采集时把生效倍率与 `adminBatch` 一并写进 `markers['采集中']`（现有口径），结算只读标记，不在结算时二次判权。
5. 授予口径：特权键必须在 `ARENA_PRIVILEGE_DEFS` 登记（写错键名的授予是"静默无效"的，直接拒），且**没写天数不等于永久**——只有显式 `days=0`/`permanent` 才永久，避免一次漏填变成永久授权。

指令 `竞技场管理`（内部自鉴权）支持：`结算` / `初排` / `开季` / `改期 <天>` / `榜 <N>` / `预览` / `授特权 <玩家> <key> <天>` / `撤特权 <玩家> <key>` / `持权`，管理员页另有同名接口。

## 7. 配置项一览（`group = "arena"`，全部 SystemConfig 在线改）

`arena.enabled`、`arena.tierConfig`（名次区间表）、`arena.challengeRankWindow`（可挑战名次差上限，默认 1=一顺位往上打，0=不限）、
`arena.rankInitByPower` + `arena.rankInitLimit`（开榜按战力排初始名次 / 人数上限）、
`arena.dailyChallengeLimit`、`arena.entryMode`、`arena.entryVitalityCost`、`arena.entryTicketItem`、`arena.entryTicketCost`、
`arena.submitMode`、`arena.submitVitalityCost`、`arena.submitTicketItem`、`arena.submitTicketCost`、
`arena.avoidRepeatHours`、`arena.battleTimeLimitSec`、`arena.battleMaxActions`、`arena.minLevelToEnter`、`arena.ladderPageSize`、
`arena.seasonLengthDays`、`arena.seasonStartAt`、`arena.seasonCarry`、`arena.seasonRewards`、`arena.avatarFrames`、
`arena.batchGatherPrivilegeMax`、`arena.announceSeason` —— 共 26 个键。

积分制时代的 `arena.ratingBase` / `ratingFloor` / `ratingK` / `ratingMarginCap` 已删除，
连同 `ARENA_SOFT_RESET_KEEP_RATIO` 常量一起进了 `OBSOLETE_CONFIG_KEYS`（启动时清理，后台里不留假开关）。
`test/arena-wiring.spec.ts` 有一条静态门禁：每个 `arena.*` 键都必须能在源码里找到读取点，且默认表与键集一一对应 —— 加了没人读的键会变红。

## 8. 落地清单

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `server/prisma/schema.prisma` | 新增 6 张表 |
| 2 | `server/src/config/arena.config.ts` | 类型 + 配置键 + 默认值 + 席位/段位/奖励归一的纯函数（纯常量模块，避开循环依赖） |
| 3 | `server/src/modules/game/arena/mirror-snapshot.util.ts` | 快照构造/校验/深拷贝（`schemaVersion`） |
| 4 | `server/src/modules/game/arena/arena-battle.service.ts` | 无头镜像对战 + 战报 |
| 5 | `server/src/modules/game/entitlement.service.ts` | 特权 + 头像框 + 称号直发 |
| 6 | `server/src/modules/game/checkin-reward.service.ts` | 奖励类型扩 `title`/`frame`/`privilege` |
| 7 | `server/src/modules/game/arena/arena.service.ts` | 镜像提交/榜单/挑战（锁内名次门 + 席位互换）/每日次数/开榜按战力排初始名次/面板文案 |
| 8 | `server/src/modules/game/arena/arena-season.service.ts` | 赛季巡检（含初始名次兜底）+ 结算发奖 + 席位重排 + 管理指令 + 限定称号成就标记 |
| 9 | `server/src/modules/game/arena/arena.controller.ts` / `arena-admin.controller.ts` | Web 只读接口 / 管理接口 |
| 10 | `server/src/modules/game/game.module.ts` | providers + exports + controllers 注册 |
| 11 | `server/src/modules/command/handlers/arena.handler.ts` + `handlers/index.ts` | 指令入口（`handlerKey='arena'`） |
| 12 | `server/prisma/seed.ts` | 7 条 `Command` 行：竞技场 / 提交镜像 / **挑战镜像** / 竞技场战绩 / 战报 / 头像框 / 竞技场管理 |
| 13 | `server/src/modules/system-config/system-config.service.ts` | `DEFAULT_CONFIGS` 展开 arena 组（26 个键，静态扫描保证每个都有读取点）+ `OBSOLETE_CONFIG_KEYS` 清掉积分制四键 + 积分制旧值（minRating 段位表 / `seasonCarry=softReset`）启动刷回默认 |
| 14 | `server/src/modules/game/commands/gather-panel.service.ts` | 批量采集门槛接特权 |
| 15 | `server/prisma/data/titles.json` | 新增 3 个限定称号（条件写只有赛季结算会打的标记） |
| 16 | `web/src/api/index.js` + `web/src/views/ArenaView.vue` + 路由/侧栏 | 天梯页（榜单 / 战绩 / 战报回放 / 奖励公示 / 装扮 / 管理） |
| 17 | `server/test/arena-{battle,service,season,wiring}.spec.ts`、`entitlement.spec.ts`、`integration-arena.spec.ts` | 单测 + 真实库端到端（已进 `jest.db-specs.cjs` 串行清单） |

两个实测踩到的坑（都已在代码里修好，别回退）：

- **BigInt 会炸快照**：`Player` 的 `lastOpTime/readTime/playTime` 是 BigInt 列，快照深拷贝若用裸 `JSON.stringify` 会抛
  `Do not know how to serialize a BigInt`——真库里每次「提交镜像」都失败，单测因为用普通数字建桩而全绿。
  `mirror-snapshot.util.ts` 的 `deepClone` 用 replacer 把 BigInt 转字符串；`test/arena.service.spec.ts` 的玩家桩保留 BigInt 列做回归。
- **端到端断言要和「每条消息一次时间结算」分开**：走指令通道时，装甲回充/每日登录奖励会合法改动玩家行，
  把它误算成竞技场的写入会产生随机红灯。`integration-arena.spec.ts` 因此分两步：
  指令通道验功能与文案，**逐列比对玩家行**那段直接调 `ArenaService`，只允许活力按入场费变化。

两点命名与入口口径：

- 挑战指令叫 **「挑战镜像」** 而不是「挑战」——项目里 `使魔挑战` / `开始挑战` 是爬塔指令，且指令分发的「无空格前缀回落」会把裸 `挑战` 归到别的行，改名后零冲突。
- 管理入口有两处、逻辑同一：指令 `竞技场管理 …`（内部自鉴权）与 `/api/admin/arena/*`（RolesGuard）。玩家侧写操作**只有指令一条路**（网页也走 `commandApi.execute`），保证三条入口行为一致。
- 限定称号的排他性由数据保证：`titles.json` 里这三个称号的条件写的是 `竞技场赛季冠军/前十/参与` 标记，而这三个标记只有赛季结算会写 → 「领取称号」白嫖不到，已拥有者也不会看到「0/1」的假缺失进度。`test/title-achievement-sources.spec.ts` 会强制这一对应关系。

## 9. 边界与风险

- **席位互换是「读 → 算 → 写回」，必须锁住双方**：守方此刻不在线，名次只能由结算方代写。
  挑战链路加两把键级串行锁，顺序恒为 **挑战者锁 → 参战双方锁**（键按 userId 升序逐层嵌套，内层不回头取外层，无环不成死锁）：
  挑战者锁防同一玩家连点双花每日次数与「提交/挑战」互相覆盖档案；参战双方锁防多人同时打同一镜像时丢掉一次换位，
  也防 A↔B 互打时两条链路各写一半。与 `MapService.withMapLock` 同一手法（队尾接力 + 空闲清理），前提是 PM2 单实例 fork 模式。
  `test/arena.service.spec.ts` 里的并发用例即锁的存在性证明（把 `withKeyLock` 的队尾换成 `Promise.resolve()` 立刻变红）。
- **名次门必须在锁内判定**：排队等锁期间，守方可能已经被别人顶到了自己后面。锁外算名次的话，
  会拿着过期名次去打一个「现在排在你后面」的人 —— 赢了反而掉到他的差席位上。
  现在 `rankGateCheck` 与换位落在同一把锁内，锁内还会重读双方镜像行。
  回归用例（`排队期间守方掉到自己后面…`）用人工占住参战锁 + 手工换位来复现，把门挪回锁外即变红。
- **换季席位重排只改被结算那一季的档案**：`compactSeats` 必须带 `seasonId` 条件。补算卡住的旧赛季时，
  新赛季的档案可能已经在跑，只按 `userId` 更新会把下一季的席位一起覆盖掉。
- **镜像不随主人变强**：主人换神装后旧镜像仍是老属性 → 面板与榜单都标注快照等级/战斗力与提交时间，鼓励刷新；不做静默自动刷新（自动刷新会让「挑战一个已知镜像」变成打随机人）。
- **快照可被反复刷新用于试错**：提交也有消耗（`arena.submitMode`），且 `version` 计入战报，异常刷提交可在后台看到。
- **战斗随机性**：`calcDamage` 内含随机区间与贯穿判定，同一次挑战不可复现。战报把逐回合结果整份存档（`ArenaMatch.report.actionLog`），复盘以存档为准。单测不给引擎注随机源，而是**换成可控的战斗引擎替身**（`test/arena-battle.spec.ts`）只验结算器契约：时间轴、三池次序、终局判定、快照不被改写——数值本身仍由 PVE 那一份实现负责，不造第二真相源。
- **镜像对战不吃 PVE 的成长红利**：`世界等级差距`（新人保护/压制）两侧统一清零，否则低等级号能在竞技场里靠加成打赢高等级。
- **喂分不再是代码漏洞，而是规则不成立的命题**：积分制下「三个小号轮流给主号送分」识别不了（Elo 只能按分差截断期望胜率），
  互换制下没有可搬运的数值 —— 新入榜一律排在末尾，小号想排到前面只能自己去打赢前面的人；
  每次换位都是「一人升一名、一人退到他原来的位置」，全服名次总和不变，也变不出额外的名次。
  剩下的可钻空间只有共谋（前面的人挂老镜像站着让指定号打），代价是这个人会同时被任何路人顶下去，
  且每一场都留在 `ArenaMatch` 里可审计。调节阀：`arena.challengeRankWindow`（默认 1，一顺位往上打）、
  `arena.dailyChallengeLimit`、`arena.avoidRepeatHours`、`arena.minLevelToEnter`、`arena.batchGatherPrivilegeMax`（特权倍率上限）。
  关联账号识别（同 QQ/同设备）仍是独立的风控课题，本期不做、也不假装有。
- **DB 变更**：本项目走 `prisma db push`（禁 `--accept-data-loss` 打生产）。新增 6 张表为纯增量，无需回填。
  当前状态：`.env` 指向的**测试库 smdztest 已 `db push` + `prisma:seed`**（端到端用例即跑在它上面）；
  **生产库 smdz 仍需自行执行这两步并重启**，未执行时竞技场指令会报「未找到指令」。
- **不做的事**：不掉真实资产、不给 PVP 掉落、挑战过程不进世界频道广播、不改 `game.service.ts` 门面（指令走独立 handler，避开门面行数门禁）。赛季结算**会**发一条世界公告（每赛季一次，`arena.announceSeason` 可关）。
