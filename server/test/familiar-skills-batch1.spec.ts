import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';
import { FamiliarSkillsService } from '../src/modules/game/familiar-skills.service';

function parseJson(value: any, fallback: any): any {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function makeSkillsService(options: {
  player?: any;
  weaponAttackResult?: string;
} = {}) {
  const player: any = options.player || {
    id: 1, userId: 42, name: '冒险者', mapId: 7, type: '龙姬',
    hp: 100, maxHp: 100, affinity: 0,
    markers: '{}', markers2: '[]', equipment: '[]', sets: '{}',
  };
  const service: any = Object.create(FamiliarSkillsService.prototype);
  Object.assign(service, {
    playerService: {
      getPlayerData: jest.fn(async () => ({
        player,
        markers: parseJson(player.markers, {}),
        markers2: parseJson(player.markers2, []),
        equipment: parseJson(player.equipment, []),
      })),
      getMarkerValue: jest.fn((markers: any, name: string) => Number(markers?.[name] ?? 0)),
      getSkillLevel: jest.fn((markers: any, name: string) => {
        // 与 PlayerService.getSkillLevel 同口径：熟练度开方推导等级
        const proficiency = Math.max(0, Number(markers?.[`${name}技能熟练度`] ?? 0));
        let level = 1;
        while (proficiency >= level * level) level += 1;
        return level;
      }),
      setMarker: jest.fn((markers: any, name: string, value: any) => {
        markers[name] = value;
      }),
      savePlayer: jest.fn(async () => undefined),
      enqueueUserWrite: jest.fn(async (_uid: number, fn: () => any) => fn()),
    },
    combatSystem: {
      weaponAttack: jest.fn(async () => ({ result: options.weaponAttackResult ?? '攻击结算文本' })),
    },
    taskService: { advance: jest.fn(async () => '') },
    shortcutService: { setTempInput: jest.fn(async () => undefined) },
    systemConfig: {
      get: jest.fn(async (_key: string, defaultValue: any) => defaultValue),
    },
    familiarSystem: {
      getSkillEffect: jest.fn(() => 1),
    },
    logger: { log: jest.fn(), warn: jest.fn() },
  });
  return { service, player };
}

describe('使魔技能第一批：怒吼/万象/鹰眼/歼灭（原版 使魔技能.ecode L1312-1503 复刻验证）', () => {
  afterEach(() => jest.restoreAllMocks());

  function makePlayer(overrides: Record<string, any>) {
    return {
      id: 1, userId: 42, name: '冒险者', mapId: 7,
      hp: 100, maxHp: 100, affinity: 0,
      markers: '{}', markers2: '[]', equipment: '[]', sets: '{}',
      ...overrides,
    };
  }

  it('怒吼：非龙姬返回原版门禁文本', async () => {
    const { service } = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });

    const result = await service.executeSkill(42, '怒吼');

    expect(result).toContain('这是龙姬的技能');
    expect(service.taskService.advance).not.toHaveBeenCalled();
  });

  it('怒吼：库洛牌放大增益时长、冷却键为龙姬技能冷却（冷却核心 50 秒）', async () => {
    const { service, player } = makeSkillsService({
      player: makePlayer({
        type: '龙姬',
        markers: JSON.stringify({ 龙姬技能熟练度: 16 }), // 熟练度 16 → 技能等级 5
        equipment: JSON.stringify([{ name: '库洛牌' }, { name: '冷却核心' }]),
      }),
    });

    const result = await service.executeSkill(42, '怒吼');

    expect(result).toContain('大地为之颤抖');
    expect(result).toContain('技能经验+');
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '使用技能');
    // a3(1.25) × (10 + 技能等级5/2) = 15.625 秒
    const buffs = parseJson(player.buffs, []);
    const roar = buffs.find((b: any) => b.name === '怒吼');
    expect(roar).toBeTruthy();
    expect(roar.expireAt - Date.now() / 1000).toBeGreaterThan(15);
    expect(roar.expireAt - Date.now() / 1000).toBeLessThanOrEqual(16);
    // 冷却键 = 类型+技能冷却；冷却核心 → 50 秒
    const markers2 = parseJson(player.markers2, []);
    const cd = markers2.find((m: any) => m.name === '龙姬技能冷却');
    expect(cd).toBeTruthy();
    expect(cd.expireAt - Date.now()).toBeLessThanOrEqual(50 * 1000);
    expect(cd.expireAt - Date.now()).toBeGreaterThan(49 * 1000);
    // 当前生命 +0.1、活跃度 +1
    expect(Number(player.hp)).toBeCloseTo(100.1, 5);
    expect(Number(parseJson(player.markers, {})['活跃度'])).toBe(1);
  });

  it('怒吼：冷却中拦截', async () => {
    const { service } = makeSkillsService({
      player: makePlayer({
        type: '龙姬',
        markers2: JSON.stringify([{ name: '龙姬技能冷却', expireAt: Date.now() + 30000 }]),
      }),
    });

    const result = await service.executeSkill(42, '怒吼');

    expect(result).toContain('技能冷却中');
    expect(service.taskService.advance).not.toHaveBeenCalled();
  });

  it('鹰眼：非恶毒返回原版门禁文本；成功写入鹰眼增益并回复原版文本', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '鹰眼')).toContain('这是恶毒的技能');

    const { service, player } = makeSkillsService({
      player: makePlayer({ type: '恶毒' }),
    });
    const result = await service.executeSkill(42, '鹰眼');

    expect(result).toContain('我看到你了');
    const buffs = parseJson(player.buffs, []);
    const hawk = buffs.find((b: any) => b.name === '鹰眼');
    expect(hawk).toBeTruthy();
    // 无库洛牌 → 30 秒
    expect(hawk.expireAt - Date.now() / 1000).toBeLessThanOrEqual(30);
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '恶毒技能冷却')).toBeTruthy();
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '使用技能');
  });

  it('万象（军姬2）：冷却键军姬2技能冷却、好感≥20 写 jj2hg1 抵挡标记、死亡置 jj3', async () => {
    const { service, player } = makeSkillsService({
      player: makePlayer({
        type: '军姬2', hp: 0, // 死亡状态：倍率 300+7.5*技能等级
        markers: JSON.stringify({ 军姬2好感: 20 }),
      }),
    });

    const result = await service.executeSkill(42, '万象');

    expect(result).toContain('(死亡情况下使用)');
    expect(result).toContain('抵挡3次伤害'); // 取整(3+0*0.05)=3
    expect(result).toContain('攻击结算文本');
    const markers = parseJson(player.markers, {});
    expect(markers['jj2']).toBe(1);
    expect(markers['jj3']).toBe(1);
    expect(markers['jj2hg1']).toBe(3);
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '军姬2技能冷却')).toBeTruthy();
    // 死亡倍率 Math.floor(300 + 7.5*1) = 307（技能等级最低为1）
    expect(service.combatSystem.weaponAttack).toHaveBeenCalledWith(42, 0, expect.objectContaining({
      damageMultiplier: 307, attackText: '【万象】', allAttack: true,
    }));
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '使用技能');
  });

  it('万象（军姬本体）：森罗万象文本、万象增益 30 秒、好感≥60 回血 50% 并置万象2', async () => {
    const { service, player } = makeSkillsService({
      player: makePlayer({ type: '军姬', hp: 40, maxHp: 100, affinity: 60 }),
    });

    const result = await service.executeSkill(42, '万象');

    expect(result).toContain('森罗万象！');
    expect(result).toContain('生命+50');
    expect(Number(player.hp)).toBe(90); // 40 + 50
    const buffs = parseJson(player.buffs, []);
    expect(buffs.find((b: any) => b.name === '万象')).toBeTruthy();
    const markers = parseJson(player.markers, {});
    expect(markers['万象2']).toBe(1);
    expect(service.combatSystem.weaponAttack).not.toHaveBeenCalled();
  });

  it('歼灭：非阿尔缇娜返回原版门禁文本；成功走战斗引擎并按好感写 a技能2', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '歼灭')).toContain('这是阿尔缇娜的技能');

    const { service, player } = makeSkillsService({
      player: makePlayer({
        type: '阿尔缇娜',
        markers: JSON.stringify({ 阿尔缇娜好感: 20 }),
      }),
    });
    const result = await service.executeSkill(42, '歼灭');

    expect(result).toContain('攻击结算文本');
    expect(result).toMatch(/剑光指引前进的道路|剑刃所向即是帝国边疆|正义从不缺席/);
    const buffs = parseJson(player.buffs, []);
    expect(buffs.find((b: any) => b.name === 'a技能2')).toBeTruthy();
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '阿尔缇娜技能冷却')).toBeTruthy();
    // 存活基础倍率 100 + 5*1 = 105（技能等级最低为1）
    expect(service.combatSystem.weaponAttack).toHaveBeenCalledWith(42, 0, expect.objectContaining({
      damageMultiplier: 105, attackText: '歼灭a',
    }));
  });
});
