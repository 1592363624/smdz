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
  const RAW_SAVEPLAYER_BASELINE = 272;
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

  // ===== 地图聚合串行化门禁（per-map 闭环写）=====
  // 背景：GameMap 的 summons/vehicles/items/markers 等 Json 列是「读出数组 → 内存改 →
  // 整组写回」的裸聚合。历史上 getMapById 合并快照做读改写会在并发时互相覆盖
  // （白被地图写竞态清除即此类事故）。正确做法是 mutateMapFields / mutateSummons
  // 锁内闭环。文档会丢，测试不会丢——以下规则把收口固化为门禁。

  it('业务代码禁止直写 GameMap 动态聚合列（必须走 mutateMapFields/mutateSummons 闭环）', () => {
    // 允许的落库 sink：map.service.ts 内部（mutateMapFields/updateDynamicFields/
    // refreshExpiredMapResources 等封装了锁内闭环/缓存失效），以及 actor builtin-types.ts
    // （map Actor 自身的 load→save 路径）。其余业务文件若再出现裸
    // prisma.gameMap.update / updateMany 写聚合列即判违规。
    const MAP_SINK_FILES = ['map.service.ts', 'builtin-types.ts'];
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
});
