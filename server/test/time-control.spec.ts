import { FamiliarSkillsService } from '../src/modules/game/familiar-skills.service';

/**
 * Issue #9 反馈③回归：时间主宰「掌控时间」对齐原版（使魔技能.ecode L2090-2099）
 *
 * 原版行为：装备时间主宰 → 获得增益(标记2, 类型+"技能冷却", -60, 叠加时间=真)
 * → 当前使魔类型的技能冷却剩余时间直接减 60 秒（减完即清空），自身冷却 360 秒（6分钟），
 * 文案"清空了技能冷却"。
 *
 * 修复前：错做成「加一个 30 秒属性 buff（冷却缩减%）」且自身 CD 600 秒——
 * 不清除任何 CD，与装备描述"清空当前使魔技能冷却，冷却6分钟"不符。
 */

function parseJson(value: any, fallback: any): any {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function makeService(player: any): any {
  const service = Object.create(FamiliarSkillsService.prototype) as any;
  service.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  service.playerService = {
    getPlayerData: jest.fn(async () => ({ player })),
    savePlayer: jest.fn(async () => undefined),
    getMarkerValue: () => 0,
  };
  return service;
}

function makePlayer(overrides: any = {}): any {
  return {
    id: 1,
    userId: 42,
    name: '花园猫',
    type: '伊卡洛斯',
    mapId: 1,
    baseName: '花园猫',
    equipment: '[]',
    backpack: '[]',
    markers: '{}',
    markers2: '[]',
    buffs: '[]',
    ...overrides,
  };
}

describe('时间主宰「掌控时间」对齐原版（Issue #9 反馈③）', () => {
  it('未装备时间主宰时拒绝；装备在背包不在身上也拒绝（原版只查当前装备）', async () => {
    const player = makePlayer();
    const service = makeService(player);
    await expect(service.timeControl(42)).resolves.toBe('需要「时间主宰」装备才能掌控时间');

    player.backpack = JSON.stringify([{ name: '时间主宰', quantity: 1 }]);
    await expect(service.timeControl(42)).resolves.toBe('需要「时间主宰」装备才能掌控时间');
  });

  it('清空在冷却中的技能 CD（类型+技能冷却 与 setCooldown 打标的技能标记），文案对齐原版', async () => {
    const now = Date.now();
    const player = makePlayer({
      equipment: JSON.stringify([{ name: '时间主宰', type: '手掌' }]),
      markers2: JSON.stringify([
        // 原版机制键：类型+技能冷却（剩余100秒，掌控后应减60剩约40秒）
        { name: '伊卡洛斯技能冷却', expireAt: now + 100 * 1000 },
        // 项目内每技能 CD（setCooldown 打 kind:'skill-cd' 标签，剩余60秒 → 清空）
        { name: '怒吼', expireAt: now + 60 * 1000, kind: 'skill-cd' },
        // 状态类条目（无标签、非技能CD）不得被误伤
        { name: '救援', expireAt: now + 3600 * 1000, token: 't1' },
      ]),
    });
    const service = makeService(player);

    await expect(service.timeControl(42)).resolves.toBe('花园猫清空了技能冷却');

    const markers2 = parseJson(player.markers2, []);
    // 怒吼 60 秒 CD 被整段清空（条目移除）
    expect(markers2.some((m: any) => m.name === '怒吼')).toBe(false);
    // 类型+技能冷却按原版 -60 秒：100 秒剩约 40 秒（仍在 CD，不是清零）
    const typeCd = markers2.find((m: any) => m.name === '伊卡洛斯技能冷却');
    expect(typeCd).toBeDefined();
    const remainingSec = (typeCd.expireAt - Date.now()) / 1000;
    expect(remainingSec).toBeGreaterThan(35);
    expect(remainingSec).toBeLessThan(45);
    // 状态类条目原样保留
    const rescue = markers2.find((m: any) => m.name === '救援');
    expect(rescue).toBeDefined();
    expect(rescue.token).toBe('t1');
  });

  it('技能 CD 剩余不足 60 秒时直接清空（原版：减到当前时间以内即删除条目）', async () => {
    const now = Date.now();
    const player = makePlayer({
      equipment: JSON.stringify([{ name: '时间主宰', type: '手掌' }]),
      markers2: JSON.stringify([
        { name: '伊卡洛斯技能冷却', expireAt: now + 30 * 1000 },
      ]),
    });
    const service = makeService(player);

    await expect(service.timeControl(42)).resolves.toBe('花园猫清空了技能冷却');

    const markers2 = parseJson(player.markers2, []);
    // 30 秒 - 60 秒 < 0 → 条目删除，技能立即可用
    expect(markers2.some((m: any) => m.name === '伊卡洛斯技能冷却')).toBe(false);
  });

  it('掌控时间自身冷却 6 分钟（360 秒，对齐原版"sjz,360"与装备描述）', async () => {
    const player = makePlayer({
      equipment: JSON.stringify([{ name: '时间主宰', type: '手掌' }]),
      markers2: '[]',
    });
    const service = makeService(player);

    await expect(service.timeControl(42)).resolves.toBe('花园猫清空了技能冷却');

    // 立即再次使用：应被自身 CD 拦截，剩余约 360 秒
    const second = await service.timeControl(42);
    expect(second).toMatch(/冷却中/);
    const remaining = Number((second.match(/剩余(\d+)秒/) ?? [])[1]);
    expect(remaining).toBeGreaterThan(350);
    expect(remaining).toBeLessThanOrEqual(360);
  });
});
