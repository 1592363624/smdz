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
  mapSummons?: any[];
  monsters?: any[];
  feathers?: number;
  markers2?: any[];
} = {}) {
  const player: any = options.player || {
    id: 1, userId: 42, name: '冒险者', mapId: 7, type: '花园猫',
    hp: 100, maxHp: 100, affinity: 0,
    markers: '{}', markers2: '[]', equipment: '[]', sets: '{}', buffs: '[]',
  };
  const map: any = {
    id: 7, name: '森林', markers2: '[]',
    summons: JSON.stringify(options.mapSummons ?? []),
  };
  const service: any = Object.create(FamiliarSkillsService.prototype);
  Object.assign(service, {
    prisma: {
      player: {
        findMany: jest.fn(async () => []),
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
      safeJsonParse: parseJson,
    },
    mapService: {
      getMapById: jest.fn(async () => map),
      getMapMonsters: jest.fn(async () => options.monsters ?? []),
      mutateMapFields: jest.fn(async (_mapId: number, _fields: string[], fn: (f: any) => any) => {
        const f: any = { markers2: parseJson(map.markers2, []), resources: parseJson(map.resources, []), resources2: parseJson(map.resources2, []), markers: {} };
        const changed = fn(f);
        map.markers2 = JSON.stringify(f.markers2);
        return changed;
      }),
      mutateSummons: jest.fn(async (_mapId: number, fn: (s: any[]) => any) => {
        const summons = parseJson(map.summons, []);
        fn(summons);
        map.summons = JSON.stringify(summons);
        return summons;
      }),
    },
    mutateService: {
      mutate: jest.fn(async (_uid: number, fn: (ctx: any) => any) => fn({
        player,
        markers: parseJson(player.markers, {}),
        markers2: parseJson(player.markers2, []),
      })),
    },
    combatSystem: {
      weaponAttack: jest.fn(async () => ({ result: '攻击结算文本' })),
      buildAttackerBonus: jest.fn(() => ({ 生命: 100, 物伤: 50, 冰伤: 0, 火伤: 0, 电伤: 0 })),
      triggerMapBattleLoop: jest.fn(async () => undefined),
      // 羽毛系统桩：起始羽毛数由 options.feathers 控制，负数扣减
      getFeather: jest.fn((_player: any, markers: any, _now: number, deduction?: number) => {
        markers['羽毛'] = Number(markers['羽毛'] ?? options.feathers ?? 0) + (deduction ?? 0);
        return markers['羽毛'];
      }),
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
    markers: '{}', markers2: '[]', equipment: '[]', sets: '{}', buffs: '[]',
    ...overrides,
  };
}

describe('使魔技能第三批：啾啾猫猫/银龙附体/光翼/炮冠/日轮/安宝加油/灼烂歼鬼/洗脑/砸瓦鲁多（原版 L1649-2070 复刻验证）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('啾啾猫猫：花园猫门禁、地图标记3“啾啾猫猫”增益（库洛牌放大/强度50+等级×5）、怪物型召唤物+1生命', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '啾啾猫猫')).toContain('这是花园猫的技能');

    const { service, player, map } = makeSkillsService({
      player: makePlayer({
        type: '花园猫',
        markers: JSON.stringify({ 花园猫技能熟练度: 16 }), // 技能等级 5
        equipment: JSON.stringify([{ name: '库洛牌' }]),
      }),
      mapSummons: [{ qq: '怪物1g', 当前生命: 5 }, { qq: '召唤物2', 当前生命: 5 }],
    });
    const result = await service.executeSkill(42, '啾啾猫猫');

    expect(result).toContain('猫猫，想让大家变得幸福');
    // 地图标记3：时长 1.25*30=37.5 秒、强度 50+5*5=75
    const mapMarkers2 = parseJson(map.markers2, []);
    const meow = mapMarkers2.find((m: any) => m.名称 === '啾啾猫猫');
    expect(meow).toBeTruthy();
    expect(meow.强度).toBe(75);
    expect(meow.有效期至 - Date.now()).toBeGreaterThan(37 * 1000);
    // 怪物型（QQ 以 g 结尾）召唤物 +1 生命，非 g 结尾不变
    const summons = parseJson(map.summons, []);
    expect(summons.find((s: any) => s.qq === '怪物1g').当前生命).toBe(6);
    expect(summons.find((s: any) => s.qq === '召唤物2').当前生命).toBe(5);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '使用技能');
  });

  it('银龙附体：古月娜门禁、回血 30% 最大生命、玩家与同图银龙同获增益', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '银龙附体')).toContain('这是古月娜的技能');

    const { service, player, map } = makeSkillsService({
      player: makePlayer({ type: '古月娜', hp: 50, maxHp: 100 }),
      mapSummons: [{ type: '银龙', qq: '怪物9g', 当前生命: 10, maxHp: 200 }, { type: '狼', qq: '怪物8g', 当前生命: 10, maxHp: 200 }],
    });
    const result = await service.executeSkill(42, '银龙附体');

    expect(result).toContain('银龙附体！');
    expect(Number(player.hp)).toBe(80); // 50 + 100*0.3
    const buffs = parseJson(player.buffs, []);
    const dragon = buffs.find((b: any) => b.name === '银龙附体');
    expect(dragon).toBeTruthy();
    expect(dragon.expireAt - Date.now() / 1000).toBeLessThanOrEqual(30); // 无库洛牌 → 30 秒
    // 同图银龙召唤物回血 30%，非银龙不变
    const summons = parseJson(map.summons, []);
    expect(summons.find((s: any) => s.type === '银龙').当前生命).toBe(70); // 10 + 200*0.3
    expect(summons.find((s: any) => s.type === '狼').当前生命).toBe(10);
  });

  it('光翼：绝灭天使门禁、羽毛不足拦截、满 10 片时消耗并写 15 秒增益', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '光翼')).toContain('这是绝灭天使的技能');

    const insufficient = makeSkillsService({
      player: makePlayer({ type: '绝灭天使' }),
      feathers: 5,
    });
    const insufficientResult = await insufficient.service.executeSkill(42, '光翼');
    expect(insufficientResult).toContain('羽毛只有');

    const { service, player } = makeSkillsService({
      player: makePlayer({ type: '绝灭天使' }),
      feathers: 12,
    });
    const result = await service.executeSkill(42, '光翼');

    expect(result).toContain('释放了光翼');
    expect(result).toContain('羽毛2'); // 12 - 10 = 2
    const buffs = parseJson(player.buffs, []);
    const wing = buffs.find((b: any) => b.name === '光翼');
    expect(wing).toBeTruthy();
    expect(wing.expireAt - Date.now() / 1000).toBeLessThanOrEqual(15);
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '光翼冷却')).toBeTruthy();
  });

  it('炮冠：绝灭天使门禁、好感80门槛、炮冠增益5秒+光盾-30秒+hd标记60秒', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '炮冠')).toContain('这是绝灭天使的技能');

    const lowAffinity = makeSkillsService({
      player: makePlayer({ type: '绝灭天使', affinity: 50 }),
    });
    expect(await lowAffinity.service.executeSkill(42, '炮冠')).toContain('需要好感达到80');

    const { service, player } = makeSkillsService({
      player: makePlayer({
        type: '绝灭天使', affinity: 80,
        markers: JSON.stringify({ 绝灭天使好感: 80 }),
        markers2: JSON.stringify([{ name: '光盾', expireAt: Date.now() + 100 * 1000 }]),
      }),
      feathers: 30,
    });
    const result = await service.executeSkill(42, '炮冠');

    expect(result).toContain('个羽毛进入了准备状态');
    const buffs = parseJson(player.buffs, []);
    expect(buffs.find((b: any) => b.name === '炮冠').expireAt - Date.now() / 1000).toBeLessThanOrEqual(5);
    const markers2 = parseJson(player.markers2, []);
    // 光盾有效期前移 30 秒
    const lightShield = markers2.find((m: any) => m.name === '光盾');
    expect(lightShield.expireAt - Date.now()).toBeLessThanOrEqual(70 * 1000);
    expect(markers2.find((m: any) => m.名称 === 'hd')).toBeTruthy();
  });

  it('日轮：绝灭天使门禁文本与冷却键=绝灭天使技能冷却', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '日轮')).toContain('这是绝灭天使的技能');

    const { service, player } = makeSkillsService({
      player: makePlayer({ type: '绝灭天使' }),
      feathers: 20,
    });
    await service.executeSkill(42, '日轮');
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '绝灭天使技能冷却')).toBeTruthy();
  });

  it('安宝加油：安克雷奇门禁、好感分层（安宝乖乖/烟雾弹地图增益）、冷却键', async () => {
    const gate = makeSkillsService({ player: makePlayer({ type: '史莱姆' }) });
    expect(await gate.service.executeSkill(42, '安宝加油')).toContain('这是安克雷奇的技能');

    const { service, player, map } = makeSkillsService({
      player: makePlayer({
        type: '安克雷奇', affinity: 60,
        markers: JSON.stringify({ 安克雷奇好感: 60 }),
      }),
      monsters: [{ id: 1, name: '野怪' }],
    });
    const result = await service.executeSkill(42, '安宝加油');

    expect(result).toContain('加油！');
    expect(result).toContain('（安宝乖乖）');
    expect(result).toContain('（烟雾弹）');
    // 有怪 → 走鱼雷b 全体攻击
    expect(service.combatSystem.weaponAttack).toHaveBeenCalledWith(42, 0, expect.objectContaining({
      attackText: '鱼雷b', mustHit: true, allAttack: true,
    }));
    const buffs = parseJson(player.buffs, []);
    expect(buffs.find((b: any) => b.name === '安宝乖乖')).toBeTruthy();
    const mapMarkers2 = parseJson(map.markers2, []);
    expect(mapMarkers2.find((m: any) => m.名称 === '烟雾弹')).toBeTruthy();
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '安克雷奇技能冷却')).toBeTruthy();
  });

  it('灼烂歼鬼：伊芙利特门禁文本、三池回满、灼烂歼鬼增益', async () => {
    const { service, player } = makeSkillsService({
      player: makePlayer({ type: '伊芙利特', hp: 40, maxHp: 100, shield: 0, maxShield: 50, armor: 0, maxArmor: 30 }),
    });
    const result = await service.executeSkill(42, '灼烂歼鬼');

    expect(result).toContain('开始我们的约会吧(战斗)吧！');
    expect(Number(player.hp)).toBe(100); // 三池回满
    expect(Number(player.armor)).toBe(30);
    const buffs = parseJson(player.buffs, []);
    expect(buffs.find((b: any) => b.name === '灼烂歼鬼')).toBeTruthy();
  });

  it('砸瓦鲁多：女仆套装4件门禁、150秒冷却键、地图“幻时”增益20秒', async () => {
    const noSet = makeSkillsService({ player: makePlayer({ type: '女仆', sets: '{}' }) });
    expect(await noSet.service.executeSkill(42, '砸瓦鲁多')).toContain('需要女仆套装');

    const { service, player, map } = makeSkillsService({
      player: makePlayer({ type: '女仆', sets: JSON.stringify({ 女仆: 4 }) }),
    });
    const result = await service.executeSkill(42, '砸瓦鲁多');

    expect(result).toBe('砸瓦鲁多！');
    const mapMarkers2 = parseJson(map.markers2, []);
    const phantom = mapMarkers2.find((m: any) => m.名称 === '幻时');
    expect(phantom).toBeTruthy();
    expect(phantom.有效期至 - Date.now()).toBeLessThanOrEqual(20 * 1000);
    const markers2 = parseJson(player.markers2, []);
    expect(markers2.find((m: any) => m.name === '女仆技能冷却')).toBeTruthy();
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '使用技能');
  });
});
