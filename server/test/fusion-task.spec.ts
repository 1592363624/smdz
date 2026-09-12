import { GameCommandHandler } from '../src/modules/command/handlers/game-command.handler';
import { GameService } from '../src/modules/game/game.service';
import { createGameServiceStub } from './helpers/game-service-stub.factory';

function parseJson(value: any, fallback: any): any {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function parseEquipment(item: any): any {
  const bonus: Record<string, number> = {};
  let specialEffect = 0;
  for (const segment of String(item?.data || '').split('!').slice(1)) {
    if (segment.startsWith('bx')) specialEffect = Number(segment.substring(2)) || 0;
    if (segment.startsWith('bw')) bonus['暴击伤害'] = Number(segment.substring(2)) || 0;
  }
  return { name: item?.name || '', bonus, specialEffect };
}

function makeFusionService(options: { artisan?: boolean; random?: number } = {}) {
  const player: any = {
    id: 7,
    userId: 42,
    name: '冒险者',
    mapId: 1,
    backpack: JSON.stringify([
      { name: '测试装备', type: '装备', quantity: 1, durability: 0, data: 's!ai10!aw20!bx2' },
      { name: '灵石', type: '资源', quantity: 3 },
      { name: '凭证', type: '资源', quantity: 3 },
    ]),
  };
  const service = createGameServiceStub() as any;
  service.logger = { log: jest.fn(), warn: jest.fn() };
  service.playerService = {
    safeJsonParse: parseJson,
    getPlayerData: jest.fn(async () => ({ player, backpack: parseJson(player.backpack, []) })),
    savePlayer: jest.fn(async (value: any) => {
      if (value?.backpack !== undefined) {
        player.backpack = typeof value.backpack === 'string'
          ? value.backpack
          : JSON.stringify(value.backpack);
      }
    }),
  };
  service.mapService = {
    getMapById: jest.fn(async () => ({
      summons: JSON.stringify(options.artisan === false ? [] : [{ name: '神之工匠', qq: 'npc1g' }]),
      npcs: '[]',
    })),
  };
  service.staticData = {
    getEquipmentByName: jest.fn(() => ({ equipType: '射弹武器' })),
    isWeapon: jest.fn(() => true),
    getAllEffects: jest.fn(() => [
      { name: '通用特效', limit: '' },
      { name: '武器特效', limit: '武器' },
      { name: '装备特效', limit: '装备' },
    ]),
  };
  service.itemService = { parseEquipment };
  service.shortcutService = { setTempInput: jest.fn(async () => '') };

  const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(options.random ?? 0.05);
  return { service, player, randomSpy };
}

describe('融合23装备迁移闭环', () => {
  afterEach(() => jest.restoreAllMocks());

  it('神之工匠处传说装备按10%成功，成功升为神迹并保留已有特效', async () => {
    const fixture = makeFusionService({ random: 0.05 });

    const result = await fixture.service.handleMerge(42, '1');
    const backpack = JSON.parse(fixture.player.backpack);

    expect(result).toContain('造神成功');
    expect(backpack[0].data.charAt(0)).toBe('x');
    expect(backpack[0].data).toContain('bx2');
    expect(backpack.find((item: any) => item.name === '灵石')).toBeUndefined();
    expect(fixture.service.playerService.savePlayer).toHaveBeenCalled();
  });

  it('造神失败消耗3灵石，并给无特效装备激活补偿特效', async () => {
    const fixture = makeFusionService({ random: 0.9 });
    const backpack = JSON.parse(fixture.player.backpack);
    backpack[0].data = 's!ai10';
    fixture.player.backpack = JSON.stringify(backpack);

    const result = await fixture.service.handleMerge(42, '1');
    const saved = JSON.parse(fixture.player.backpack);
    const spirit = saved.find((item: any) => item.name === '灵石');

    expect(result).toContain('失败');
    expect(result).toContain('补偿');
    expect(saved[0].data).toMatch(/s!ai10!bx[1-3]/);
    expect(spirit).toBeUndefined();
  });

  it('没有神之工匠时按原版消耗1灵石和1凭证激活特效', async () => {
    const fixture = makeFusionService({ artisan: false, random: 0.2 });

    const result = await fixture.service.handleMerge(42, '1');
    const backpack = JSON.parse(fixture.player.backpack);

    expect(result).toContain('激活了');
    expect(backpack[0].data).toMatch(/bx[1-3]/);
    expect(backpack.find((item: any) => item.name === '灵石').quantity).toBe(2);
    expect(backpack.find((item: any) => item.name === '凭证').quantity).toBe(2);
  });

  it('支持移除特效和修正属性两个无概率分支', async () => {
    const fixture = makeFusionService({ random: 0.2 });
    const backpack = JSON.parse(fixture.player.backpack);
    backpack[0].data = 'x!ai10!bx2';
    fixture.player.backpack = JSON.stringify(backpack);

    await fixture.service.handleMerge(42, '1', ['0']);
    expect(JSON.parse(fixture.player.backpack)[0].data).not.toContain('bx');

    const repaired = JSON.parse(fixture.player.backpack);
    repaired[0].data = 'x!ai10';
    fixture.player.backpack = JSON.stringify(repaired);
    const result = await fixture.service.handleMerge(42, '1', ['修正']);
    expect(result).toContain('修好了');
    expect(JSON.parse(fixture.player.backpack)[0].data).toContain('aw4');
  });

  it('名称参数对齐原版：非数字按到整数=0处理，落入编号校验失败', async () => {
    const fixture = makeFusionService({ random: 0.2 });
    fixture.player.backpack = JSON.stringify([
      { name: '木头', type: '资源', quantity: 3 },
    ]);

    const result = await fixture.service.handleMerge(42, '木头');
    const backpack = JSON.parse(fixture.player.backpack);

    expect(result).toContain('你背包里面没有这么多东西或者输入了0');
    expect(backpack).toHaveLength(1);
    expect(fixture.service.playerService.savePlayer).not.toHaveBeenCalled();
  });

  it('无参数显示融合23帮助文案（原版 L8607-8613）', async () => {
    const fixture = makeFusionService({ random: 0.2 });

    const result = await fixture.service.handleMerge(42, '');

    expect(result).toContain('融合23');
    expect(result).toContain('神之工匠');
    expect(result).toContain('汪酱');
  });
});

describe('融合23任务分流', () => {
  function makeHandler(result: string) {
    const taskService: any = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const gameService: any = {
      handleMerge: jest.fn(async () => result),
    };
    const handler = new GameCommandHandler(
      gameService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      taskService,
    );
    return { handler, gameService, taskService };
  }

  it('不丢失融合23第二参数，造神成功推进造神任务', async () => {
    const fixture = makeHandler('造神成功！');
    await fixture.handler.handle({ userId: 42, rawMessage: '融合 23 0', source: 'web' } as any, ['23', '0']);

    expect(fixture.gameService.handleMerge).toHaveBeenCalledWith(42, '23', ['0']);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '造神');
    expect(fixture.taskService.advance).not.toHaveBeenCalledWith(42, '融合');
  });

  it('汪酱暴击伤害转移成功推进融合任务（原版 L8992）', async () => {
    const fixture = makeHandler('冒险者,测试装备获得了50%暴击伤害');
    await fixture.handler.handle({ userId: 42, rawMessage: '融合 3 42', source: 'web' } as any, ['3', '42']);

    expect(fixture.gameService.handleMerge).toHaveBeenCalledWith(42, '3', ['42']);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '融合');
  });

  it('移除特效与自选特效不加成就（原版对应分支无成就）', async () => {
    const removeFixture = makeHandler('冒险者移除了测试装备的特效');
    await removeFixture.handler.handle({ userId: 42, rawMessage: '融合 1 0', source: 'web' } as any, ['1', '0']);
    expect(removeFixture.taskService.advance).not.toHaveBeenCalled();

    const selectFixture = makeHandler('冒险者激活了测试装备的特效【通用特效】');
    await selectFixture.handler.handle({ userId: 42, rawMessage: '融合 1 自选1', source: 'web' } as any, ['1', '自选1']);
    expect(selectFixture.taskService.advance).not.toHaveBeenCalled();
  });
});
