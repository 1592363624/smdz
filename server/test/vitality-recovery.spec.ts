/**
 * 活力恢复链路回归：覆盖「时间基准从未落库 → 时间流逝系统整体死锁」的缺陷。
 * 对齐原版 加成计算.ecode L1596-1597（时间差计算 + 无条件回写读取时间）
 * 与 L2625-2643（活力按时间差恢复、受魅力历史上限封顶）。
 */
import { GameService } from '../src/modules/game/game.service';
import { VitalityService } from '../src/modules/game/vitality.service';

/** 构造最小可运行的 GameService：只注入 calculateTimeElapsed 实际用到的依赖。 */
function build(player: any) {
  const saved: any[] = [];
  const playerService: any = {
    getPlayerData: jest.fn(async () => ({ player, markers: JSON.parse(player.markers || '{}') })),
    savePlayer: jest.fn(async (p: any) => { saved.push({ ...p }); }),
    safeJsonParse: jest.fn((v: any, fallback: any) => {
      if (typeof v !== 'string') return v ?? fallback;
      try { return JSON.parse(v); } catch { return fallback; }
    }),
    getMarkerValue: jest.fn((markers: any, key: string) => Number(markers?.[key] ?? 0)),
  };
  const systemConfig: any = { get: jest.fn(async (_k: string, fallback: any) => fallback) };
  const vitalityService = new VitalityService(systemConfig, playerService);

  const service = new GameService(
    {} as any, // prisma
    playerService,
    {} as any, // bonusService
    {} as any, // combatSystem
    {} as any, // itemService
    {} as any, // mapService
    {} as any, // familiarService
    {} as any, // dungeonService
    {} as any, // adminService
    {} as any, // achievementService
    {} as any, // itemSystemService
    {} as any, // homeService
    {} as any, // familiarSystemService
    {} as any, // familiarSkillsService
    {} as any, // tutorialService
    {} as any, // staticData
    systemConfig,
    {} as any, // chatService
    {} as any, // feedbackService
    {} as any, // taskService
    {} as any, // shortcutService
    {} as any, // statsService
    {} as any, // combatState
    {} as any, // autoMineService
    vitalityService,
  );
  return { service, player, saved };
}

describe('活力恢复：时间基准初始化', () => {
  it('首次操作时两个时间戳都是0：只落基准不补偿，且基准必须写库', async () => {
    const player = {
      vitality: 0, lastOpTime: BigInt(0), readTime: BigInt(0),
      markers: JSON.stringify({ 活力2: 100, 使用活力: 0 }),
      markers2: '[]', hp: 50, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
      regenHp: 0, regenShield: 0, regenArmor: 0,
    };
    const { service, saved } = build(player);

    const text = await service.calculateTimeElapsed(1);

    expect(text).toBe('');
    // 关键：基准必须落库，否则后续每次都会因 timeDiff=0 提前返回 → 永久死锁
    expect(saved).toHaveLength(1);
    expect(Number(saved[0].lastOpTime)).toBeGreaterThan(0);
    expect(player.vitality).toBe(0);
  });

  it('基准落库后再过 1200 秒：活力按原版公式 +1（20分钟1点）', async () => {
    const player = {
      vitality: 0, lastOpTime: BigInt(0), readTime: BigInt(0),
      markers: JSON.stringify({ 活力2: 100, 使用活力: 0 }),
      markers2: '[]', hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
      regenHp: 0, regenShield: 0, regenArmor: 0,
    };
    const { service, player: p } = build(player);

    await service.calculateTimeElapsed(1);
    // 手动回退 1200 秒，模拟玩家离开了 20 分钟
    p.lastOpTime = BigInt(Date.now() - 1200 * 1000);

    const text = await service.calculateTimeElapsed(1);

    // 活力恢复：时间差/1200 且不超过上限
    expect(p.vitality).toBeCloseTo(1, 5);
    // 三池回复率为0且活力未到80%时，原版不输出任何额外文本
    expect(text).toBe('');
  });

  it('不足10秒的零碎时间不结算也不推进基准，时间持续累积', async () => {
    const player = {
      vitality: 0, lastOpTime: BigInt(0), readTime: BigInt(0),
      markers: JSON.stringify({ 活力2: 100, 使用活力: 0 }),
      markers2: '[]', hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
      regenHp: 0, regenShield: 0, regenArmor: 0,
    };
    const { service, player: p, saved } = build(player);

    await service.calculateTimeElapsed(1);
    const base = Number(p.lastOpTime);
    p.lastOpTime = BigInt(Date.now() - 5 * 1000);

    const text = await service.calculateTimeElapsed(1);

    expect(text).toBe('');
    expect(p.vitality).toBe(0);
    // 基准未被推进，零碎时间得以累积到下一次结算
    expect(saved).toHaveLength(1);
    expect(base).toBeGreaterThan(0);
  });

  it('魅力历史值提高上限时，恢复速度按 (1+魅力/200) 放大', async () => {
    const player = {
      vitality: 0, lastOpTime: BigInt(0), readTime: BigInt(0),
      // 历史魅力 100 → 上限 200 → 恢复系数 1.5
      markers: JSON.stringify({ 活力2: 200, 使用活力: 0 }),
      markers2: '[]', hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
      regenHp: 0, regenShield: 0, regenArmor: 0,
    };
    const { service, player: p } = build(player);

    await service.calculateTimeElapsed(1);
    p.lastOpTime = BigInt(Date.now() - 1200 * 1000);
    await service.calculateTimeElapsed(1);

    expect(p.vitality).toBeCloseTo(1.5, 5);
  });

  it('活力≥上限80%时输出「活力快满了」提示，且600秒内只提示一次', async () => {
    const player = {
      vitality: 0, lastOpTime: BigInt(0), readTime: BigInt(0),
      markers: JSON.stringify({ 活力2: 100, 使用活力: 0 }),
      markers2: '[]', hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
      regenHp: 0, regenShield: 0, regenArmor: 0,
    };
    const { service, player: p } = build(player);

    await service.calculateTimeElapsed(1);
    // 一次性离线 40 小时：40*3600/1200 = 120 点，超过上限被封顶为 100
    p.lastOpTime = BigInt(Date.now() - 40 * 3600 * 1000);
    const first = await service.calculateTimeElapsed(1);

    expect(p.vitality).toBe(100);
    expect(first).toContain('活力快满了');
    expect(first).toContain('100/100');

    // 冷却中：第二次不再提示
    p.lastOpTime = BigInt(Date.now() - 3600 * 1000);
    const second = await service.calculateTimeElapsed(1);
    expect(second).not.toContain('活力快满了');
  });
});
