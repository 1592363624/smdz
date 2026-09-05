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
  monsters?: any[];
  mapSummons?: any[];
  otherPlayers?: any[];
} = {}) {
  const player: any = options.player || {
    id: 1, userId: 42, name: '冒险者', mapId: 7, type: '龙姬',
    hp: 100, maxHp: 100, affinity: 0,
    markers: '{}', markers2: '[]', equipment: '[]', sets: '{}',
  };
  const map: any = {
    id: 7, name: '森林', summons: JSON.stringify(options.mapSummons ?? []),
  };
  const service: any = Object.create(FamiliarSkillsService.prototype);
  Object.assign(service, {
    prisma: {
      player: {
        findMany: jest.fn(async () => options.otherPlayers ?? []),
      },
    },
    playerService: {
      getPlayerData: jest.fn(async () => ({
        player,
        markers: parseJson(player.markers, {}),
        markers2: parseJson(player.markers2, []),
        equipment: parseJson(player.equipment, []),
      })),
      getMarkerValue: jest.fn((markers: any, name: string) => Number(markers?.[name] ?? 0)),
      setMarker: jest.fn((markers: any, name: string, value: any) => {
        markers[name] = value;
      }),
      savePlayer: jest.fn(async () => undefined),
      enqueueUserWrite: jest.fn(async (_uid: number, fn: () => any) => fn()),
      getSkillLevel: jest.fn((markers: any, name: string) => {
        const proficiency = Math.max(0, Number(markers?.[`${name}技能熟练度`] ?? 0));
        let level = 1;
        while (proficiency >= level * level) level += 1;
        return level;
      }),
      isPlayerDead: jest.fn((p: any) => Number(p?.hp ?? 1) <= 0),
      handlePlayerDeath: jest.fn(() => '你死了'),
    },
    mapService: {
      getMapById: jest.fn(async () => map),
      getMapMonsters: jest.fn(async () => options.monsters ?? []),
    },
    combatSystem: {
      weaponAttack: jest.fn(async () => ({ result: '攻击结算文本' })),
      triggerMapBattleLoop: jest.fn(async () => undefined),
    },
    taskService: { advance: jest.fn(async () => '') },
    shortcutService: { setTempInput: jest.fn(async () => undefined) },
    systemConfig: {
      get: jest.fn(async (_key: string, defaultValue: any) => defaultValue),
    },
    familiarSystem: { getSkillEffect: jest.fn(() => 1) },
    logger: { log: jest.fn(), warn: jest.fn() },
  });
  return { service, player, map };
}

function makePlayer(overrides: Record<string, any>) {
  return {
    id: 1, userId: 42, name: '冒险者', mapId: 7,
    hp: 100, maxHp: 100, affinity: 0,
    markers: '{}', markers2: '[]', equipment: '[]', sets: '{}',
    ...overrides,
  };
}

describe('使魔技能第二批：歼灭模式/绝对守护/斗转星移/火力全开/斩/会心一击（原版 L1505-1790 复刻验证）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('歼灭模式：伊卡洛斯门禁、库洛牌放大 30 秒增益、歼灭模式熟练度、原版台词', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '歼灭模式')).toContain('这是伊卡洛斯的技能');

    const { service, player } = makeSkillsService({
      player: makePlayer({
        type: '伊卡洛斯',
        equipment: JSON.stringify([{ name: '库洛牌' }]),
      }),
    });
    const result = await service.executeSkill(42, '歼灭模式');

    expect(result).toContain('原谅你们是上帝的事情，而我的工作是送你们去见他');
    const buffs = parseJson(player.buffs, []);
    const mode = buffs.find((b: any) => b.name === '歼灭模式');
    expect(mode).toBeTruthy();
    expect(mode.expireAt - Date.now() / 1000).toBeGreaterThan(37);
    expect(mode.expireAt - Date.now() / 1000).toBeLessThanOrEqual(38);
    expect(parseJson(player.markers, {})['歼灭模式']).toBe(1);
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '伊卡洛斯技能冷却')).toBeTruthy();
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '使用技能');
  });

  it('绝对守护：战斗女仆门禁、守护1时长=库洛牌×(10+技能等级/2)、沉着=2、好感100写守护3/4', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '绝对守护')).toContain('这是战斗女仆的技能');

    const { service, player } = makeSkillsService({
      player: makePlayer({
        type: '战斗女仆',
        affinity: 100,
        markers: JSON.stringify({ 战斗女仆技能熟练度: 16, 战斗女仆好感: 100 }), // 技能等级 5
        equipment: JSON.stringify([{ name: '库洛牌' }]),
      }),
    });
    const result = await service.executeSkill(42, '绝对守护');

    expect(result).toContain('撒，细数你的罪恶吧');
    const buffs = parseJson(player.buffs, []);
    const guard = buffs.find((b: any) => b.name === '守护1');
    expect(guard).toBeTruthy();
    expect(guard.expireAt - Date.now() / 1000).toBeGreaterThan(15);
    expect(guard.expireAt - Date.now() / 1000).toBeLessThanOrEqual(16); // 1.25*(10+5/2)=15.625
    const markers = parseJson(player.markers, {});
    expect(markers['沉着']).toBe(2);
    expect(markers['守护3']).toBe(1);
    expect(markers['守护4']).toBe(1);
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '战斗女仆技能冷却')).toBeTruthy();
  });

  it('斗转星移：星尘门禁、回复 25% 护盾上限并置 dz 标记、原版文本', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '斗转星移')).toContain('这是星尘的技能');

    const { service, player } = makeSkillsService({
      player: makePlayer({ type: '星尘', hp: 100, maxHp: 100, shield: 0, maxShield: 100 }),
    });
    const result = await service.executeSkill(42, '斗转星移');

    expect(result).toContain('星辰之力！');
    expect(result).toContain('回复了25护盾（25%）');
    expect(Number(player.shield)).toBe(25);
    expect(parseJson(player.markers, {})['dz']).toBe(25);
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '星尘技能冷却')).toBeTruthy();
  });

  it('火力全开：普拉娜门禁、压制增益（强度/时长）与武器冷却削减、熟练度置位', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '火力全开')).toContain('这是普拉娜的技能');

    const { service, player } = makeSkillsService({
      player: makePlayer({
        type: '普拉娜',
        markers: JSON.stringify({ 普拉娜技能熟练度: 1 }), // 技能等级 1
        weapons: JSON.stringify([{ name: '加特林' }]),
        markers2: JSON.stringify([{ name: '加特林冷却', expireAt: Date.now() + 60 * 1000 }]),
      }),
    });
    const result = await service.executeSkill(42, '火力全开');

    expect(result).toContain('恐惧一般来源于火力不足');
    expect(result).toContain('所有武器冷却时间减少了27秒'); // 25 + 技能等级2（熟练度1→等级2）
    expect(result).toContain('火力压制32.3%'); // 28.5 + 1.9*2
    expect(result).toContain('剩余20秒');
    const markers2 = parseJson(player.markers2, []);
    const suppression = markers2.find((m: any) => m.名称 === '压制');
    expect(suppression).toBeTruthy();
    const gatling = markers2.find((m: any) => m.name === '加特林冷却');
    expect(gatling.expireAt).toBeLessThanOrEqual(Date.now() + 34 * 1000); // 60 - 27
    expect(parseJson(player.markers, {})['火力全开']).toBe(1);
  });

  it('斩：好感不足先于类型门禁；成功回满三池、原版台词、冷却键斩冷却', async () => {
    const lowAffinity = makeSkillsService({
      player: makePlayer({ type: '史莱姆', affinity: 10 }),
    });
    expect(await lowAffinity.service.executeSkill(42, '斩')).toContain('需要60好感');

    const { service, player } = makeSkillsService({
      player: makePlayer({ type: '剑圣', affinity: 60, hp: 40, maxHp: 100 }),
    });
    const result = await service.executeSkill(42, '斩');

    expect(result).toContain('吾心吾行澄如明镜，所行所为皆是正义！');
    expect(Number(player.hp)).toBe(100); // 三池回满
    const markers2 = parseJson(player.markers2, []);
    const cd = markers2.find((m: any) => m.name === '斩冷却');
    expect(cd).toBeTruthy();
    expect(cd.expireAt - Date.now()).toBeLessThanOrEqual(50 * 1000); // 无冷却核心 → 50
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '使用技能');
  });

  it('会心一击：满池九头龙闪（无穿透）、非满池天翔龙闪（三层穿透15）、无怪练习文本', async () => {
    // 无怪 → 练习文本
    const practice = makeSkillsService({
      player: makePlayer({ type: '剑圣', affinity: 60 }),
      monsters: [],
    });
    const practiceResult = await practice.service.executeSkill(42, '会心一击');
    expect(practiceResult).toContain('对着空气练习了会心一击');

    // 满池 → 九头龙闪
    const full = makeSkillsService({
      player: makePlayer({
        type: '剑圣', affinity: 60,
        hp: 100, maxHp: 100, armor: 50, maxArmor: 50, shield: 30, maxShield: 30,
      }),
      monsters: [{ id: 1, name: '野怪' }],
    });
    const fullResult = await full.service.executeSkill(42, '会心一击');
    expect(fullResult).toContain('九头龙闪！');
    expect(full.service.combatSystem.weaponAttack).toHaveBeenCalledWith(42, 0, expect.objectContaining({
      damageMultiplier: 210, attackText: '会心一击b', // 200 + 10*1
      extraPenetrationFlat: undefined,
    }));

    // 非满池 → 天翔龙闪 + 三穿透 15
    const notFull = makeSkillsService({
      player: makePlayer({
        type: '剑圣', affinity: 60,
        hp: 60, maxHp: 100, armor: 0, maxArmor: 50, shield: 0, maxShield: 30,
      }),
      monsters: [{ id: 1, name: '野怪' }],
    });
    const notFullResult = await notFull.service.executeSkill(42, '会心一击');
    expect(notFullResult).toContain('天翔龙闪！');
    expect(notFull.service.combatSystem.weaponAttack).toHaveBeenCalledWith(42, 0, expect.objectContaining({
      extraPenetrationFlat: 15,
    }));
    const markers2 = parseJson(notFull.player.markers2, []);
    expect(markers2.find((m: any) => m.name === '剑圣技能冷却')).toBeTruthy();
  });
});
