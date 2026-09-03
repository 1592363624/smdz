import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';

describe('纯白之翼自动技能', () => {
  const parse = (value: any, fallback: any) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
  };

  function createService(player: any, familiarSkills: any) {
    const markers = parse(player.markers, {});
    const playerService: any = {
      getPlayerData: jest.fn().mockResolvedValue({ player, markers }),
      getBackpackItems: jest.fn().mockReturnValue(parse(player.backpack, [])),
      safeJsonParse: parse,
      getMarkerValue: jest.fn((source: any, key: string) => Number((source || {})[key] || 0)),
      getSkillLevel: jest.fn((source: any, name: string) => {
        const proficiency = Number((source || {})[`${name}技能熟练度`] || 0);
        let level = 1;
        while (proficiency >= level * level) level += 1;
        return level;
      }),
      savePlayer: jest.fn().mockResolvedValue(undefined),
    };
    return new FamiliarSystemService(
      {} as any,
      playerService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      familiarSkills,
    );
  }

  it('执行特有技能，并同时写入30秒纯白冷却和5秒自动训练冷却', async () => {
    const player = {
      type: '花园猫',
      uniqueSkill: '啾啾猫猫！',
      markers: '{}',
      markers2: '[]',
      backpack: '[{"name":"纯白之翼","quantity":1}]',
    };
    const familiarSkills = { executeSkill: jest.fn().mockResolvedValue('啾啾猫猫已释放') };
    const service = createService(player, familiarSkills);

    await expect(service.autoCastSkill(1)).resolves.toBe('啾啾猫猫已释放');
    expect(familiarSkills.executeSkill).toHaveBeenCalledWith(1, '啾啾猫猫');
    const markers2 = parse(player.markers2, []);
    expect(markers2).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '纯白cd' }),
      expect.objectContaining({ name: '自动训练' }),
    ]));
  });

  it('兰音公共冷却归零时自动改为形神合一', async () => {
    const player = {
      type: '兰音',
      uniqueSkill: '心无所扰',
      // 原版技能等级为熟练度平方阈值；1521 对应等级40。
      markers: JSON.stringify({ 兰音技能熟练度: 1521 }),
      markers2: '[]',
      backpack: '[{"name":"纯白之翼","quantity":1},{"name":"冷却核心","quantity":1}]',
    };
    const familiarSkills = { executeSkill: jest.fn().mockResolvedValue('形神合一已释放') };
    const service = createService(player, familiarSkills);

    await expect(service.autoCastSkill(1)).resolves.toBe('形神合一已释放');
    expect(familiarSkills.executeSkill).toHaveBeenCalledWith(1, '形神合一');
  });

  it('纯白冷却未结束时不重复释放', async () => {
    const now = Date.now() / 1000;
    const player = {
      type: '花园猫',
      uniqueSkill: '啾啾猫猫',
      markers: '{}',
      markers2: JSON.stringify([{ name: '纯白cd', expireAt: now + 20 }]),
      backpack: '[{"name":"纯白之翼","quantity":1}]',
    };
    const familiarSkills = { executeSkill: jest.fn() };
    const service = createService(player, familiarSkills);

    await expect(service.autoCastSkill(1)).resolves.toBe('');
    expect(familiarSkills.executeSkill).not.toHaveBeenCalled();
  });
});
