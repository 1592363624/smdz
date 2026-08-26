# P3 延时任务统一作业表 —— 实施计划（押后备忘，待 P0-P2 生产稳定后启动）

> **执行方式**：加载技能 `smdz3-fullstack-features`（含 P0 锁/CAS、P1 货币列化、P2 mutate 管道的全部规范与决策），
> 然后按本计划顺序执行。提交前跑 `node server/scripts/precommit-gate.js` 门禁。
> 提交由用户自己完成，助手只改码和验证。

**目标**：把散落在 GameService / CombatSystemService 里的「进程内 setTimeout 定时器 + cron 兜底扫描」双路延时结算，
收敛为单一的持久化作业表（DelayedJob）+ 原子认领的统一 worker，删除各处防重入补丁地图。

**前置条件（启动闸门）**：
- P0-P2 改动已上生产并稳定运行 ≥2 周，无新增货币/数据丢失投诉；
- CurrencyLog 审计表在生产有数据，可作为回归对照。

---

## 一、现状盘点（2026-08-26 核实过的锚点）

四组进程内定时器家族，全部共享同一模式：**状态持久化在 Player.markers2 JSON 里，定时器本身在内存 Map 里，
服务重启靠 cron 每 5 秒扫库兜底补结算**。

| 家族 | 进程内定时器 | 到点结算函数 | 兜底扫描 | 补丁性防御 |
|---|---|---|---|---|
| 资源采集 | `GameService.gatherTimers` (game.service.ts:55) | `settleGatherResource` (~2870 起) | `ScheduleService.settlePendingGathers` (schedule.service.ts:102, cron */5s) | `gatherStartInflight`(57)、`gatherFallbackAt`(59)、`gatherFallbackCount`(61)、最小间隔15s/连续上限3次/60s窗口自愈(66-71) |
| 扶/救助/自救 | `GameService.rescueTimers` (game.service.ts:53) | 私有 `completeRescue` (~11745 起) | `settlePendingRescues` (schedule.service.ts:83, cron */5s) | `rescueFallbackAt`(63)、`rescueFallbackCount`(65)、同款 15s/3次/60s 自愈(72-77) |
| 副本清场 | `GameService.dungeonClearTimers` (game.service.ts:51, key=group.name) | 见 7866 附近调度点 | 无持久化兜底（重启即丢，需确认业务影响） | 无 |
| 延时攻击/锁定 | `CombatSystemService.delayedAttackTimers` + `lockStates` (combat-system.service.ts:7636-7642) | `weaponAttack` 入口（已包共享用户锁） | 无持久化兜底（重启即丢） | `isDelayed` 防递归标志 |

另有**自动战斗周期回调**与**自动开采结算**：
- 自动战斗循环汇入 `weaponAttack`（已包锁），周期由内存定时器驱动——评估是否纳入作业表或保留（见开放问题 Q3）；
- `AutoMineService.checkpointAll` 由 schedule.service.ts:65 每分钟 cron 驱动，本身已是「扫库式」，天然接近目标架构，仅缺统一认领。

### 为什么现在是补丁
原版易语言是单线程全局「待执行延时」队列，天然无丢失。移植成 Node 后每家族各自造了
「setTimeout 主路 + 扫库兜底 + 防重复结算三件套（间隔/计数/窗口）」。P0-P2 已保证这些写入不再互相覆盖
（正确性问题已解决），剩下的是**可维护性问题**：新增任何延时玩法都要再抄一套五张 Map。

---

## 二、目标架构

```
┌─ 写入侧 ─────────────────────────────┐
│ startGather / startRescue /          │   不再 setTimeout
│ scheduleDelayedAttack / 副本清场      │──→ INSERT INTO DelayedJob
│                                      │   (userId, type, runAt, payloadJson,
└──────────────────────────────────────┘    status='pending', claimedBy=null)

┌─ 统一 worker ────────────────────────┐
│ ScheduleService 单一 cron (*/5s)：    │
│  UPDATE DelayedJob SET claimedBy=…   │   原子认领（WHERE status='pending'
│  WHERE runAt<=now AND status='pending'│   AND (claimedBy IS NULL OR 心跳过期)）
│  LIMIT n                             │
│  → 按 type 分发到现有 settle 函数     │──→ 成功 → status='done'
│                                      │    失败 → status 回 pending + retry++
└──────────────────────────────────────┘   （上限 3 次，超过置 'failed' 留查）

取消路径：startXxx 重开时先 cancel 同 type 未完成 job（UPDATE status='cancelled'）。
```

要点：
1. **原子认领替代全部防重入 Map**：claimedBy = `${hostname}:${pid}:${随机}`，多实例部署安全；心跳字段防 worker 中途崩溃死占。
2. **到点结算函数保持不变**（settleGatherResource / completeRescue / weaponAttack 内部逻辑不动），只换触发来源——这是控制风险的核心。
3. **markers2 里的状态标记保留**（采集中/锁定中是玩家可见状态，查询走它），但不再是「兜底扫描的数据源」——扫描源变成作业表，markers2 仅作展示冗余。
4. 全部结算调用走 `PlayerMutateService.mutate()` 或至少共享用户锁（P2 规范），审计自动生效。

## 三、Schema

```prisma
model DelayedJob {
  id         Int      @id @default(autoincrement())
  userId     Int
  type       String   @db.VarChar(32)   // GATHER | RESCUE | DELAYED_ATTACK | DUNGEON_CLEAR
  payload    String   @db.LongText      // JSON: 地图id/武器索引/group名 等
  runAt      DateTime                                   // 到期时间
  status     String   @db.VarChar(16) @default("pending") // pending|claimed|done|cancelled|failed
  claimedBy  String?  @db.VarChar(64)
  claimedAt  DateTime?
  retryCount Int      @default(0)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@index([status, runAt])
  @@index([userId, type, status])
}
```
迁移照例双轨：schema.prisma + 手写 `prisma/migrations/<ts>_add_delayed_job/migration.sql` +
幂等守卫脚本 `scripts/add-delayed-job-table.js`（参照 add-currency-log.js）。

## 四、任务拆解（TDD，每个任务独立可验证）

> 顺序刻意「先边缘后核心」：副本清场最孤立，用它打通管道；采集测试覆盖最厚，最后迁。

### Task 1：DelayedJob 表 + 幂等脚本
- schema.prisma 加模型；手写迁移 SQL；`scripts/add-delayed-job-table.js` 上远程库。
- 验证：守卫脚本二次执行输出 already exists；`npx tsc -p tsconfig.build.json --noEmit` 干净。

### Task 2：JobQueueService 骨架（纯逻辑先行）
- 新建 `server/src/modules/game/job-queue.service.ts`：
  `enqueue(userId,type,payload,runAt)` / `cancel(userId,type)` / `claimDue(workerId,limit)` /
  `complete(id)` / `fail(id,err)`（retry<3 回 pending，否则 failed）。
- 测试 `server/test/job-queue.spec.ts`（stub Prisma）：认领互斥（两个 worker 抢同一 job 只成一个）、
  取消后不再被认领、重试计数、到点过滤。
- 注册进 game.module.ts。

### Task 3：统一 worker 接管 cron
- ScheduleService 新增单一 `@Cron('*/5 * * * * *') processDueJobs()`：claimDue → 按 type 分发。
- 本步分发器先只接一个空类型（如 DUNGEON_CLEAR 的 noop），旧 cron 全部保留——灰度并存。
- 验证：BOOT 冒烟（NestFactory.createApplicationContext）确认注入无环；旧功能不受影响。

### Task 4：副本清场迁入（试点，风险最小）
- `dungeonClearTimers` 的调度点（game.service.ts:7866 附近）改为 enqueue(DUNGEON_CLEAR)；
  到点回调逻辑原样搬进分发器分支。删除该 Map。
- 注意：此家族目前**无持久化兜底**，迁入后反而获得重启恢复能力——顺手修一个隐性 bug。
- 测试：新建 spec 覆盖「入队→时间到→清场执行一次且仅一次」「重复开团取消旧 job」。

### Task 5：救援迁入
- `rescueTimers` 调度点 → enqueue(RESCUE)；completeRescue 保持不动，由分发器调。
- **删除** rescueFallbackAt/rescueFallbackCount 及 15s/3次/60s 三常量（schedule.service.ts:83 的旧 cron 同步删）。
- 回归：test/rescue-social 相关套件全绿；手工冒烟「发起救助→杀进程→重启→5s 内补结算」。

### Task 6：采集迁入
- `gatherTimers` 调度点 → enqueue(GATHER)；`gatherStartInflight` 用 enqueue 前 cancel+唯一索引语义替代
  （或保留为进程内快路径去重，二选一，倾向前者）。
- **删除** gatherFallback 四张 Map 与三常量、schedule.service.ts:102 旧 cron。
- 回归：test/gather-task、user-lock-regression、delayed-settle-dedupe 全绿——最后一个专测防重复结算，
  迁移后应改为断言「同一 job 只被认领一次」而非旧的间隔启发式。

### Task 7：延时攻击迁入（最后，最敏感）
- `delayedAttackTimers`/`lockStates` → enqueue(DELAYED_ATTACK)；锁定状态的查询点改为查作业表
  （status IN (pending,claimed) 即锁定中）。`isDelayed` 防递归标志保留。
- weaponAttack 已包共享用户锁，勿动。
- 回归：combat 相关套件 + 手工冒烟「延时武器攻击→中途重启→重启后攻击仍落地一次」。

### Task 8：收尾
- 删除所有残留注释引用旧 Map 的死文案；README/技能文档更新。
- 全量门禁：`node scripts/precommit-gate.js` EXIT 0。
- （可选，另立任务）AutoMineService.checkpointAll 改走 claimDue(AUTO_MINE) 统一认领。

## 五、验证清单（最终验收）
1. `npx tsc -p tsconfig.build.json --noEmit` 干净；
2. 全量 jest 绿（integration-dodge/counter-attack 远程库抖动单跑复验即可，不算失败）;
3. 杀进程重启：进行中的采集/救助/延时攻击均在 ≤10s 内被补结算恰好一次（人工冒烟三项）;
4. CurrencyLog 对照：迁移前后同样操作序列产生的审计行一致;
5. 双开两个服务实例指向同一库短跑 5 分钟：无双重结算（认领互斥的生产级证据）。

## 六、风险与开放问题
- **Q1 双写窗口**：迁移期间旧标记残留会被新 worker 当孤儿吗？→ 分发器对「job 不存在但 markers 有状态」的行
  保留一次性清扫（沿用现兜底逻辑一个版本，下版本删）。
- **Q2 时钟漂移**：runAt 用 DB 时间还是应用时间？→ 建议 `now() from DB` 口径，避免多实例时钟差。
- **Q3 自动战斗是否纳入**：它是持续循环而非一次性延时，硬塞进作业表会把表变成轮询垃圾场。
  倾向保留进程内驱动（重启丢失可接受，玩家重新开启即可），仅文档注明。启动 P3 前和用户确认。
- **Q4 job 表膨胀**：done 行定期清理（cron 每日删 7 天前 done/cancelled）。
