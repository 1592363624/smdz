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
  const RAW_SAVEPLAYER_BASELINE = 266;
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
});
