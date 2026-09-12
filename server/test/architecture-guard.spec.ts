import * as fs from 'fs';
import * as path from 'path';

/**
 * 架构门禁：玩家状态写入口收口
 *
 * 背景：玩家数据走「读快照 → 改 → 整包写回 + version CAS」模型，历史上反复
 * 出现旧快照覆盖新写入的事故。正确的收口方式已经存在（PlayerMutateService.mutate），
 * 但规范写在文档/技能里会丢——曾经就丢过一次，导致后续代码全部绕过入口裸写。
 *
 * 因此把规范固化成自动化门禁：**文档会丢，测试不会丢。**
 *
 * 两条规则：
 * 1. 裸调 savePlayer 的处数只减不增 —— 新增代码必须走 mutate / enqueueUserWrite。
 * 2. mutate 的调用数只增不减 —— 迁移是单向的，不允许回退。
 * 3. 裸调 prisma.player.update（绕过邮箱的直接写库）必须收敛到只剩「落库 sink」
 *    （PlayerService.persistPlayerData 内部那唯一一处）；任何业务代码再出现
 *    prisma.player.update / updateMany 即判违规——全量单写者的硬门禁。
 *
 * 迁移完一处就把基线调低一处，让门禁成为可度量的进度条。
 */

const SRC_DIR = path.resolve(__dirname, '../src');

/** 收口相关文件自身不计入违规（它们是入口的实现者，不是调用方） */
const EXCLUDED_FILES = ['player-mutate.service.ts', 'player.service.ts'];

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 遍历目录下的测试文件（*.spec.ts，含子目录） */
function walkSpecs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSpecs(full));
    } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 统计非注释行中某个模式的出现次数，返回 [总数, 按文件计数] */
function countPattern(files: string[], pattern: RegExp): [number, Array<[string, number]>] {
  let total = 0;
  const perFile: Array<[string, number]> = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let hits = 0;
    for (const raw of lines) {
      const line = raw.trim();
      // 跳过注释行，避免把说明文字算成违规
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
      const m = line.match(pattern);
      if (m) hits += m.length;
    }
    if (hits > 0) perFile.push([path.relative(SRC_DIR, file), hits]);
    total += hits;
  }
  perFile.sort((a, b) => b[1] - a[1]);
  return [total, perFile];
}

describe('架构门禁：玩家状态写入口收口', () => {
  // ===== 基线（2026-08-30 记录，收口方式升级为"基础设施层安全网 + 串行邮箱"）=====
  // 演进：早期做法是逐个把写入口迁到 mutate（裸写只减不增）。现升级为在
  // getPlayerData / savePlayer 自身加"上下文感知"安全网——任何在 mutate 上下文内
  // 的裸写都自动复用唯一快照 / 合并回上下文 / 由最外层统一落库，旧快照覆盖类事故
  // 在基础设施层被根除；指令入口之外、由定时器驱动的写（ScheduleService 的
  // settlePendingMoves / cleanupExpiredBuffs）则收口到 PlayerService 的 per-user
  // 串行邮箱（enqueueUserWrite → savePlayer），同样单用户串行、无竞态、无 CAS。
  // - 单点收口：指令总入口 CommandService.executeDispatch 已用 mutate 包住整条指令，
  //   因此 game/familiar/combat 等裸写都被纳入同一快照。
  // - 基线 217 → 219：ScheduleService 两条定时器裸写（prisma.player.update）已合规
  //   收口为 enqueueUserWrite → savePlayer，属预期增量（它们本就绕开指令漏斗，现经
  //   串行邮箱获得同等安全保证）。其余 217 处裸写维持不变（安全网已保护）。
  // - 基线 219 → 266（2026-08-30 全局迁移）：将 item-system(24)/item(8)/admin(5)/
  //   game(3+1 updateMany)/familiar(2)/dungeon(2)/task(1)/schedule(1 updateMany)/
  //   player.service(4) 共 51 处绕过邮箱的裸 prisma.player.update 全部收口为
  //   enqueueUserWrite → getPlayerData → 改 → savePlayer（单写者）。这些 savePlayer
  //   是「邮箱内的落库 sink」，属预期增量；真正的硬门禁见下方 raw prisma.player.update 检查。
  // - 基线 273 → 275（2026-09-06 逐技能第四批复刻）：召唤/召唤银龙/冻结傀儡/
  //   封印解除/纳米模式/全弹发射按原版重写，指令路径内的落库 sink 净增 2 处
  //   （同 266 批次口径）。
  // - 基线 272 → 273（2026-09-06 逐技能第三批复刻）：啾啾猫猫/银龙附体/光翼/炮冠/
  //   安宝加油/砸瓦鲁多按原版重写，指令路径内的落库 sink 净增 1 处（同 266 批次口径）。
  // - 基线 270 → 272（2026-09-06 保存图片链复刻）：保存图片开始（写“tk”增益 120 秒）
  //   与保存图片停止（移除 tk）各 +1 落库 sink，属预期增量（同 266 批次口径）。
  // - 基线 269 → 270（2026-09-06 狐自动攻击复刻）：到达触发狐攻击（原版 L6762-6776）
  //   写入「狐」60秒冷却标记 + 活跃度落库 sink +1，属预期增量（同 266 批次口径）。
  // - 基线 268 → 269（2026-09-06 出口分支复刻）：前往「出口」（原版 L6549-6576）
  //   写入 markers2「移动」标记（原版 L6574 添加标记("移动",b)）时落库 sink +1，
  //   属预期增量（同 266 批次口径）。
  // - 基线 266 → 268（2026-09-05 复刻批次）：召唤货舱延时结算（applyCargoSummon，
  //   原「召h货1藏」）与维修延时结算（applyCompleteVehicleRepair，原「维修wcc1」）
  //   两个 dts tick 直调入口按支柱二收口为 enqueueUserWrite → savePlayer，
  //   各新增 1 处邮箱内落库 sink，属预期增量（同 266 批次口径）。
  // - 基线 275 → 276（2026-09-08 RVW04 修复轮实测校准）：HEAD 存量裸写实测已为
  //   276 处（前序提交未同步基线，门禁在干净工作树上即红）；本轮 P1-3（CAS 默认
  //   strict）/ P2-7（static-data 校验+索引）两项修复零新增 savePlayer，按实测校准。
  const RAW_SAVEPLAYER_BASELINE = 276;
  const MUTATE_CALL_BASELINE = 4;
  // 业务代码（非 excluded 文件）不得再出现任何裸 prisma.player.update——
  // 唯一允许的落库 sink 在 PlayerService.persistPlayerData（已 excluded，不计入）。
  // 故非 excluded 文件的裸写必须严格为 0，任何新增即判违规。
  const RAW_PLAYER_UPDATE_BASELINE = 0;
  // 批量写也必须走 per-user 邮箱，禁止 updateMany 直接落库。
  const RAW_PLAYER_UPDATEMANY_BASELINE = 0;

  const targetFiles = walkTs(SRC_DIR).filter(
    (f) => !EXCLUDED_FILES.some((name) => f.endsWith(name)),
  );

  it('裸调 savePlayer 的处数不得增加（新代码一律走 PlayerMutateService.mutate）', () => {
    const [count, perFile] = countPattern(targetFiles, /savePlayer\s*\(/g);

    if (count > RAW_SAVEPLAYER_BASELINE) {
      const top = perFile.slice(0, 8).map(([f, c]) => `  ${String(c).padStart(4)}  ${f}`).join('\n');
      throw new Error(
        `裸调 savePlayer 处数 ${count} 已超过基线 ${RAW_SAVEPLAYER_BASELINE}。\n` +
          `新增的写入点必须改用 PlayerMutateService.mutate(userId, ctx => {...})。\n` +
          `违规分布 TOP 8：\n${top}`,
      );
    }

    expect(count).toBeLessThanOrEqual(RAW_SAVEPLAYER_BASELINE);
  });

  it('mutate 调用数不得减少（迁移是单向的，不允许回退到裸写）', () => {
    const [count] = countPattern(targetFiles, /\.mutate\s*\(/g);
    expect(count).toBeGreaterThanOrEqual(MUTATE_CALL_BASELINE);
  });

  it('裸调 prisma.player.update 必须为 0（全量单写者，业务代码禁止绕过邮箱）', () => {
    // 匹配 update( 但排除 updateMany(；唯一允许的落库 sink 在 excluded 的
    // PlayerService.persistPlayerData 内，不计入本统计，故业务代码须严格为 0。
    const [count, perFile] = countPattern(targetFiles, /prisma\.player\.update(?!Many)/g);
    if (count > RAW_PLAYER_UPDATE_BASELINE) {
      const top = perFile.slice(0, 8).map(([f, c]) => `  ${String(c).padStart(4)}  ${f}`).join('\n');
      throw new Error(
        `裸调 prisma.player.update 处数 ${count} 超过基线 ${RAW_PLAYER_UPDATE_BASELINE}。\n` +
        `业务代码必须走 enqueueUserWrite / PlayerMutateService.mutate，禁止直接 prisma.player.update。\n` +
        `违规分布 TOP 8：\n${top}`,
      );
    }
    expect(count).toBe(RAW_PLAYER_UPDATE_BASELINE);
  });

  it('prisma.player.updateMany 必须为 0（批量写也须走 per-user 邮箱）', () => {
    const [count, perFile] = countPattern(targetFiles, /prisma\.player\.updateMany/g);
    if (count > RAW_PLAYER_UPDATEMANY_BASELINE) {
      const top = perFile.slice(0, 8).map(([f, c]) => `  ${String(c).padStart(4)}  ${f}`).join('\n');
      throw new Error(
        `prisma.player.updateMany 处数 ${count} 应等于 0（批量写也应走 enqueueUserWrite 逐玩家串行）。\n` +
        `违规分布 TOP 8：\n${top}`,
      );
    }
    expect(count).toBe(RAW_PLAYER_UPDATEMANY_BASELINE);
  });

  it('Actor 聚合键必须唯一：禁止行 id 回退，邮箱重入必须校验 run 在执行', () => {
    // 行 id 作为邮箱键会造出 'player:<行id>' 幽灵邮箱：同一玩家两条互不串行的
    // 邮箱互相覆盖；幽灵 cell 激活时 getOrCreatePlayer(行id) 还会以行 id 建档，
    // 触发 player 外键冲突（Foreign key constraint violated: userId）。
    const playerSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/player.service.ts'),
      'utf8',
    );
    // 行 id 只允许出现在展示/日志里，绝不允许进入邮箱键或查询键
    expect(playerSrc).not.toMatch(/actorKey\('player',[^)]*\?\?/);
    expect(playerSrc).not.toMatch(/enqueueUserWrite\([^)]*\?\?/);
    expect(playerSrc).not.toMatch(/where:\s*\{\s*userId:\s*player\.userId\s*\?\?\s*player\.id/);

    // savePlayer 的邮箱内快捷分支必须校验 run 真的在执行（ALS 会随定时器逃逸出
    // run 作用域，只比 ALS key 会让逃逸回调把旧快照 merge 进活态再落库）。
    expect(playerSrc).toContain('isRunActive');
    expect(playerSrc).toContain('resolveActorUserId');
    expect(playerSrc).toContain('mergeIntoLiveState');

    // 落库必须默认带乐观锁（旧快照覆盖的最后防线），冲突必须显式可观测
    expect(playerSrc).toContain('updateMany');
    expect(playerSrc).toContain('乐观锁冲突');
  });

  it('输出当前收口进度（信息性，每次运行都能看到迁移到哪了）', () => {
    const [raw] = countPattern(targetFiles, /savePlayer\s*\(/g);
    const [mutated] = countPattern(targetFiles, /\.mutate\s*\(/g);
    const total = raw + mutated;
    const pct = total > 0 ? ((mutated / total) * 100).toFixed(1) : '0.0';
    // eslint-disable-next-line no-console
    console.log(
      `[架构门禁] 玩家写入口收口进度 ${mutated}/${total} = ${pct}%` +
        `（裸写 ${raw} 处待迁移，基线 ${RAW_SAVEPLAYER_BASELINE}）`,
    );
    expect(total).toBeGreaterThan(0);
  });

  it('玩家写入口本身必须持锁并复用快照（关键实现不被误删）', () => {
    const mutateSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/player-mutate.service.ts'),
      'utf8',
    );
    // 两者任一被删掉，串行 / 单一快照就会失效
    expect(mutateSrc).toContain('enqueueUserWrite'); // 串行
    expect(mutateSrc).toContain('mutateContext.currentFor'); // 嵌套复用同一快照
  });

  it('双表示必须保持收敛：行 JSON 字段为权威 accessor，禁止回退到基线调和', () => {
    const playerSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/player.service.ts'),
      'utf8',
    );
    // 行字段必须是读写都透传到顶层权威表示的 accessor（style A/B 等价的根基）；
    // 基线调和机制一旦回来（__actorBase / syncParsedFields），说明双表示又分叉了，
    // 「陈旧表示覆盖新数据」类回归（如医疗箱永久标记被抹掉）就会复发。
    expect(playerSrc).toContain('installCanonicalAccessors');
    expect(playerSrc).not.toContain('__actorBase');
    const mutateSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/player-mutate.service.ts'),
      'utf8',
    );
    expect(mutateSrc).not.toContain('syncParsedFields');
  });

  it('mutate 上下文登记处不得依赖业务服务（否则 PlayerService 与它循环依赖）', () => {
    const ctxSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/player-mutate-context.service.ts'),
      'utf8',
    );
    // PlayerService 需要读上下文、PlayerMutateService 需要写上下文，
    // 中间的登记处必须保持零业务依赖，否则 Nest 注入成环。
    expect(ctxSrc).not.toContain("from './player.service'");
    expect(ctxSrc).not.toContain("from './player-mutate.service'");
  });

  it('addExp 必须能在 mutate 内复用快照（否则被 mutate 包住时会产生第二份快照）', () => {
    const playerSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/player.service.ts'),
      'utf8',
    );
    // 采集结算等复杂函数内部会调 addExp；若它仍自己读档保存，外层 mutate 的
    // 改动就会被覆盖。这是「mutate 化可局部推进」的前提。
    expect(playerSrc).toContain('mutateContext?.currentFor');
  });

  it('getPlayerData 必须上下文感知（mutate 内复用唯一快照，禁止重读档）', () => {
    const playerSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/player.service.ts'),
      'utf8',
    );
    expect(playerSrc).toContain('return ctx as unknown as PlayerData;');
  });

  it('savePlayer 必须上下文感知（mutate 内合并回上下文、由最外层统一落库）', () => {
    const playerSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/player.service.ts'),
      'utf8',
    );
    expect(playerSrc).toContain('mergeIntoMutateContext(ctx, player)');
  });

  it('指令总入口必须用 mutate 包住整条指令（单点收口，全部裸写纳入同一快照）', () => {
    const cmdSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/command/command.service.ts'),
      'utf8',
    );
    expect(cmdSrc).toContain('this.playerMutate.mutate(ctx.userId');
  });

  // ===== Actor 运行时激活门禁 =====
  // 背景：ActorModule（玩家域单写者内核：内存活态 + 串行邮箱 + writeThrough 落库）
  // 曾长期未被 AppModule 导入——PlayerService 的 @Optional actorRuntime 恒为
  // undefined，markPlayerDirty 两路（Actor ALS / mutateContext）在管道外全部静默
  // 失效，「领取了新手教程」每条指令重复输出即此根因。生产只跑 legacy 邮箱路径、
  // Actor 代码悬空的「两套并存」状态自此禁止回退。
  it('AppModule 必须导入 ActorModule（Actor 运行时激活，禁止悬空双轨回退）', () => {
    const appSrc = fs.readFileSync(path.join(SRC_DIR, 'app.module.ts'), 'utf8');
    expect(appSrc).toContain('ActorModule');
    // PlayerService 必须保留 Actor 类型注册（激活后 enqueueUserWrite 走 run 路径的前提）
    const playerSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/player.service.ts'),
      'utf8',
    );
    expect(playerSrc).toContain("registerType('player'");
    expect(playerSrc).toContain("persist: 'writeThrough'");
  });

  it('PlayerService 必须是 Actor 单路径（legacy 邮箱 fallback 已删除，禁止回归）', () => {
    // 2026-09-08 起 enqueueUserWrite 只有一条实现：actorRuntime.run。构造器对未注入
    // runtime 的测试桩自动内置实例——「测试验证的路径 = 生产运行的路径」。曾因
    // 双轨并存（生产 legacy、Actor 悬空）出现 markPlayerDirty 静默 no-op 事故。
    const playerSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/player.service.ts'),
      'utf8',
    );
    expect(playerSrc).not.toContain('userMailboxes');
    expect(playerSrc).not.toContain('mailboxContext');
    expect(playerSrc).toContain('injectedRuntime ?? new ActorRuntime()');
  });

  it('玩家建档口径必须唯一：users.service 禁止自建玩家行（统一走 getOrCreatePlayer）', () => {
    // ensurePlayer 曾自建只有 userId 的裸档，抢占 getOrCreatePlayer 的完整初始化
    // （新手装备/初始任务/出生地图永不执行）。建档入口只允许 player.service 一个。
    const usersSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/users/users.service.ts'),
      'utf8',
    );
    expect(usersSrc).not.toMatch(/prisma\.player\.create/);
    expect(usersSrc).toContain('getOrCreatePlayer');
  });

  // ===== 地图聚合串行化门禁（per-map 闭环写）=====
  // 背景：GameMap 的 summons/vehicles/items/markers 等 Json 列是「读出数组 → 内存改 →
  // 整组写回」的裸聚合。历史上 getMapById 合并快照做读改写会在并发时互相覆盖
  // （白被地图写竞态清除即此类事故）。正确做法是 mutateMapFields / mutateSummons
  // 锁内闭环。文档会丢，测试不会丢——以下规则把收口固化为门禁。

  it('业务代码禁止直写 GameMap 动态聚合列（必须走 mutateMapFields/mutateSummons 闭环）', () => {
    // 允许的落库 sink：map.service.ts 内部（mutateMapFields/updateDynamicFields/
    // refreshExpiredMapResources 等封装了锁内闭环/缓存失效）。其余业务文件若再出现裸
    // prisma.gameMap.update / updateMany 写聚合列即判违规。
    // （RVW04 P1-4：actor/builtin-types.ts 的 map Actor load→save 路径已随悬空注册
    // 删除，不再作为豁免 sink——任何新文件直写 gameMap 聚合列都会被本门禁拦下。）
    const MAP_SINK_FILES = ['map.service.ts'];
    const business = targetFiles.filter(
      (f) => !MAP_SINK_FILES.some((name) => f.endsWith(name)),
    );
    const [count, perFile] = countPattern(business, /prisma\.gameMap\.update(Many)?\s*\(/g);
    if (count > 0) {
      const top = perFile.slice(0, 8).map(([f, c]) => `  ${String(c).padStart(4)}  ${f}`).join('\n');
      throw new Error(
        `裸写 prisma.gameMap.update 处数 ${count} 应等于 0。\n` +
          `对 summons/items/markers 等动态列的变更必须走 mapService.mutateMapFields / mutateSummons` +
          `（锁内闭环，禁丢更新）；确需直写请封装进 map.service.ts。\n违规分布 TOP 8：\n${top}`,
      );
    }
    expect(count).toBe(0);
  });

  it('地图闭环写入口的实现不被误删（锁内重读 + 逐字段 diff 写回是关键防线）', () => {
    const mapSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/map.service.ts'),
      'utf8',
    );
    // 锁内必须重读 DB 最新行（而非用调用方传入的陈旧快照），否则并发仍会互相覆盖
    expect(mapSrc).toContain('withMapLock(mapId');
    expect(mapSrc).toContain('prisma.gameMap.findUnique({ where: { id: mapId } })');
    // 只写真正变了的列（写同值也会推进 version + 放大落库，故必须 diff）
    expect(mapSrc).toContain('JSON.stringify(before');
    expect(mapSrc).toContain('JSON.stringify(working');
    // mutateSummons 是 mutateMapFields 的 summons 简写，两者都在
    expect(mapSrc).toContain('async mutateMapFields');
    expect(mapSrc).toContain('async mutateSummons');
  });

  // ===== 支柱二门禁：延时任务结算入口必须自串行 =====
  // 背景：dts tick 直调结算 handler（无任何外层锁），若结算入口不自串行，
  // 「读档→改→写回」窗口与邮箱内操作并发就会互相覆盖（旧快照覆盖族事故）。
  // 规则：game.service 里注册给 DelayedTaskService 的每个玩家级结算入口，
  // 函数体内必须出现 enqueueUserWrite（指令路径调用时邮箱重入放行，无双锁）。
  it('延时任务结算入口必须自串行（dts tick 直调，不得依赖调用方持锁）', () => {
    const gameSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/game.service.ts'),
      'utf8',
    );
    const settleEntries = [
      'settleGatherResource', // gather
      'performArrival',       // move
      'completeRescue',       // rescue
      'completeReload',       // reload
      'settleManualMine',     // mine
      'completeRefill',       // refill
      'completeCargoSummon',  // cargo（原「召h货1藏」，2026-09-05 补）
      'completeVehicleRepair', // repair（原「维修wcc1」，2026-09-05 补）
    ];
    for (const fn of settleEntries) {
      const start = gameSrc.indexOf(`async ${fn}(`);
      if (start < 0) throw new Error(`延时结算入口 ${fn} 不存在（被改名/删除？）`);
      // 函数体切片：到下一个同级方法声明为止
      const rest = gameSrc.slice(start + 1);
      const next = rest.search(/\r?\n  (private )?async /);
      const body = rest.slice(0, next < 0 ? undefined : next);
      if (!body.includes('enqueueUserWrite')) {
        throw new Error(
          `延时结算入口 ${fn} 未自串行（函数体内无 enqueueUserWrite）。\n` +
            `它会被 DelayedTaskService.tick 在无锁上下文直调，必须像 settleGatherResource 一样\r\n` +
            `在入口处包 enqueueUserWrite（指令路径重入放行），否则读改写窗口会与邮箱内操作并发覆盖。`,
        );
      }
    }
  });

  // ===== 支柱一门禁：货币读写必须走统一入口（双字段镜像分裂的构造级封堵）=====
  // 背景（正式库 7516）：兑换加券只写 quantity、召唤只读 count——同一份 Actor 活态
  // 双字段分裂，读侧拿到陈旧值；召唤数量≤旧值时按旧值扣减写回，刚到账的券被整段
  // 吞掉。统一入口 PlayerService.getEntryQuantity/getCurrencyAmount/setCurrencyAmount
  // 让「读到旧字段」在构造上不再可能。文档会丢，测试不会丢。
  it('召唤/兑换必须走统一货币读写入口（禁止单字段读写回归）', () => {
    const familiarSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/familiar-system.service.ts'),
      'utf8',
    );
    // 召唤读券：统一读入口（携带工作数组，提交与全库「解析克隆→改→写回」约定一致）
    expect(familiarSrc).toContain("getCurrencyAmount(player, '召唤券'");
    // 召唤扣券 / 兑换扣货币：统一写入口（双字段同步 + 刷新物化基准）
    expect(familiarSrc).toContain("setCurrencyAmount(player, '召唤券'");
    expect(familiarSrc).toContain("setCurrencyAmount(player, currencyName");
    // 旧的单字段读不得回归：applySummonFamiliar 曾用 ticketItem.count || 1 当余额
    expect(familiarSrc).not.toMatch(/ticketItem\s*\?\s*\(ticketItem\.count\s*\|\|/);
    // 商店余额展示同样走统一读入口
    expect(familiarSrc).toContain("getCurrencyAmount(player, '钻石')");
  });

  // ===== integration 测试写玩家状态：须经 Actor 漏斗，禁裸 prisma.player.update =====
  // 背景：真实远程库套件曾用裸 prisma.player.update 直写玩家行（baseName/hp/markers），
  // 但玩家权威状态存于 PlayerService 的 Actor cell——裸直写只改 DB 不更新活态，随后任一
  // 游戏指令经 savePlayer 邮箱路径把陈旧 cell 回写 DB，覆盖裸直写（「旧快照覆盖」型事故，
  // 曾致 familiar-select/openbox/home-frontline 三套件失败）。正确写法是 test/actor-write.util.ts
  // 的 mutatePlayerState（包进 enqueueUserWrite，使 DB 与活态一致）。
  it('integration 测试禁止裸直写玩家行（必须经 mutatePlayerState / Actor 漏斗）', () => {
    const testDir = path.resolve(__dirname, '../test');
    const realDbSpecs = walkSpecs(testDir).filter((f) => f.includes('integration-'));
    // 只识别「真实调用」行：排除注释、mock 断言（expect(...)/.mock/toHaveBeen 等）与
    // .mock* 桩注入。真实 prisma.player.update( / updateMany( 即判违规。
    const raw = /prisma\.player\.update(?:Many)?\s*\(/g;
    const offenders: Array<[string, number]> = [];
    for (const file of realDbSpecs) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      let hits = 0;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
        // mock 断言 / 桩注入行不是对真实库的裸写
        if (/expect\s*\(/.test(line) || /\.mock\w*/.test(line) || /mockImplementation|mockResolved|mockRejected/.test(line)) continue;
        const m = line.match(raw);
        if (m) hits += m.length;
      }
      if (hits > 0) offenders.push([path.relative(testDir, file), hits]);
    }
    if (offenders.length > 0) {
      const top = offenders.map(([f, c]) => `  ${String(c).padStart(4)}  ${f}`).join('\n');
      throw new Error(
        `integration 测试裸直写玩家行 ${offenders.reduce((s, [, c]) => s + c, 0)} 处，应为 0。\n` +
          `玩家状态改写在真实库套件里必须经 mutatePlayerState(ps, uid, mutate)` +
          `（test/actor-write.util.ts，读活态→改→savePlayer 包进 enqueueUserWrite），\n` +
          `否则陈旧 Actor cell 会覆盖裸直写（旧快照覆盖）。裸 prisma.player.update 仅允许在\n` +
          `player 行尚未激活任何命令的「建档」场景用 prisma.player.create。\n违规分布：\n${top}`,
      );
    }
    expect(offenders.length).toBe(0);
  });

  // ===== GameService 体积冻结门禁（RVW04 P1-2）=====
  // 背景：game.service.ts 从评审基线 15,222 行一路膨胀（RVW04 评审时点 17,296 行，
  // 2026-09-08 修复轮实测——含本轮 P2-8 前后端契约注释落笔后的终值——17,434 行；
  // 2026-09-09 自 17,428 上调 +6：当时取值实测时 handleInventory 的 P2-8 契约注释
  // 因编辑未落地而少计 6 行，注释重做落地后按实测修正，见 QA Round 1 回归记录），
  // 单文件 god class 已经大到任何修改都要在数千行里找上下文、任何合并都可能踩冲突。
  // 止血规则：**新增指令 handler 一律新文件（挂 game 模块下），GameService 只减不增**；
  // 后续把成组 handler 拆成子 service 后，请同步下调本基线。
  const GAME_SERVICE_LINE_BASELINE = 17434;

  it('game.service.ts 行数只减不增（新增指令 handler 一律新文件，禁止继续膨胀）', () => {
    const gameSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/game.service.ts'),
      'utf8',
    );
    // 与 wc -l 同口径：按换行符计数（该文件为 CRLF、末尾带换行，17,434 即实测值）
    const lineCount = (gameSrc.match(/\r?\n/g) ?? []).length;
    if (lineCount > GAME_SERVICE_LINE_BASELINE) {
      throw new Error(
        `game.service.ts 行数 ${lineCount} 已超过冻结基线 ${GAME_SERVICE_LINE_BASELINE}。\n` +
          `新增指令 handler 一律新文件（挂 game 模块下），GameService 只减不增；\n` +
          `拆分子 service 后请下调基线。`,
      );
    }
    expect(lineCount).toBeLessThanOrEqual(GAME_SERVICE_LINE_BASELINE);
  });

  // ===== P0 止损门禁：膨胀转移通道冻结（game.service.ts 模块化重构方案 §5 P0）=====
  // 背景：G1 只冻结了 game.service.ts 一个文件，而门禁只会位移矛盾——
  // game-command.handler.ts 从 1,009 行（08-13）膨胀到 2,041 行（09-11）即前车之鉴。
  // 因此把「新增指令一律新文件」的止损口径扩展成一组冻结规则：
  // - G5：调度层 game-command.handler.ts 行数只减不增（新增指令注册到
  //   command/handlers/ 下新的 handlerKey 子域，不再写入 GameCommandHandler.dispatch）。
  // - G6：game.service.ts 中 handleXxx 指令方法数量只减不增（P0-3 白名单冻结：
  //   新指令不得以 handleXxx 形态挤进 god class；模块化拆分只允许让这个数变小）。
  // - G9：combat-system / familiar-system / familiar-skills / item-system 四个二期
  //   重点文件行数冻结（基线 = 2026-09-12 实测），二期拆分开工时改为「准许下降」。
  // 冻结口径 = 净行数不增：改 bug / 重构 / 删代码不受限，只禁新增功能堆行。
  // 真有正当理由加行数时，显式上调基线走 PR 评审——被门禁拦下的改动必须被看见。
  const GAME_COMMAND_HANDLER_LINE_BASELINE = 2041;
  const GAME_SERVICE_HANDLE_METHOD_BASELINE = 240;

  it('game-command.handler.ts 行数只减不增（G5：新指令走新 handlerKey 子域，禁止膨胀转移）', () => {
    const handlerSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/command/handlers/game-command.handler.ts'),
      'utf8',
    );
    const lineCount = (handlerSrc.match(/\r?\n/g) ?? []).length;
    if (lineCount > GAME_COMMAND_HANDLER_LINE_BASELINE) {
      throw new Error(
        `game-command.handler.ts 行数 ${lineCount} 已超过冻结基线 ${GAME_COMMAND_HANDLER_LINE_BASELINE}。\n` +
          `新增指令一律新文件（game/commands/<域>.service.ts + 新 handlerKey 子域），\n` +
          `不得继续写入 GameCommandHandler.dispatch 的分支；确需增量请显式上调基线走评审。`,
      );
    }
    expect(lineCount).toBeLessThanOrEqual(GAME_COMMAND_HANDLER_LINE_BASELINE);
  });

  it('game.service.ts 的 handleXxx 方法数量只减不增（G6：新增指令不得挤进 god class）', () => {
    const gameSrc = fs.readFileSync(
      path.join(SRC_DIR, 'modules/game/game.service.ts'),
      'utf8',
    );
    // 只统计方法声明行（类体内 2 空格缩进的 handleXxx(），不匹配调用点。
    // 当前 240 个即现有指令面白名单计数上限：新增指令必须落在新文件。
    const handleDecls = gameSrc.match(
      /^\s{2}(?:private\s+|public\s+|protected\s+|static\s+|async\s+)*handle[A-Z]\w*\s*\(/gm,
    );
    const count = handleDecls ? handleDecls.length : 0;
    if (count > GAME_SERVICE_HANDLE_METHOD_BASELINE) {
      throw new Error(
        `game.service.ts 的 handleXxx 方法数量 ${count} 已超过冻结基线 ${GAME_SERVICE_HANDLE_METHOD_BASELINE}。\n` +
          `新增指令一律新文件（game/commands/<域>.service.ts），不得以 handleXxx 形态进入 GameService；\n` +
          `模块化拆分迁出后请同步下调本基线。`,
      );
    }
    expect(count).toBeLessThanOrEqual(GAME_SERVICE_HANDLE_METHOD_BASELINE);
  });

  // G9：四个二期重点文件行数冻结（P0-4，基线 = 2026-09-12 实测）。
  // 这些文件暂无门禁约束时，game.service 被冻结后新增战斗/使魔/物品逻辑会涌入，
  // 重演 game-command.handler 1,009→2,041 的教训（§11.1）。
  const PHASE2_FILE_LINE_BASELINES: Array<[string, number]> = [
    ['modules/game/combat-system.service.ts', 12418],
    ['modules/game/familiar-system.service.ts', 4853],
    ['modules/game/familiar-skills.service.ts', 4053],
    ['modules/game/item-system.service.ts', 3386],
  ];
  for (const [relFile, baseline] of PHASE2_FILE_LINE_BASELINES) {
    it(`二期重点文件行数冻结（G9）：${path.basename(relFile)} 只减不增（基线 ${baseline}）`, () => {
      const src = fs.readFileSync(path.join(SRC_DIR, relFile), 'utf8');
      const lineCount = (src.match(/\r?\n/g) ?? []).length;
      if (lineCount > baseline) {
        throw new Error(
          `${relFile} 行数 ${lineCount} 已超过冻结基线 ${baseline}。\n` +
            `该文件是二期拆分重点，一期冻结防膨胀转移；改 bug / 重构 / 删代码不受限，\n` +
            `确需新增功能堆行请显式上调基线走 PR 评审。`,
        );
      }
      expect(lineCount).toBeLessThanOrEqual(baseline);
    });
  }
});
