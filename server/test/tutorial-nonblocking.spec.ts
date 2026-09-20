/**
 * 新手指引「只追加、不拦截」回归
 *
 * 背景：用户实测「首次穿上 麻醉枪A」只看到引导（且文案写死石制工具）、装备未生效——
 * 根因是引导在动作执行前拦截 return。统一口径：指令正文照常执行，引导追加在正文之后
 * （对齐原版 物品操作.ecode L811 查看背包、_主程序.ecode L4262/L4289 装备引导）。
 *
 * 本套件覆盖「背包 / 地图 / 信息 / 查看使魔 / 对话」五条指令（背包、地图、信息的引导
 * 实现在各自的 InventoryHandler / MapHandler / InfoHandler；对话的 talk 引导追加到正文
 * 末尾），以及引导消费入口 TutorialService.consumeTutorial 的「每类只提示一次 +
 * 标记落库」语义。
 */

import { InventoryHandler } from '../src/modules/command/handlers/inventory.handler';
import { MapHandler } from '../src/modules/command/handlers/map.handler';
import { InfoHandler } from '../src/modules/command/handlers/info.handler';
import { GameCommandHandler } from '../src/modules/command/handlers/game-command.handler';
import { TutorialService } from '../src/modules/game/tutorial.service';
import { createGameServiceStub } from './helpers/game-service-stub.factory';

const TUTORIAL = '📖 引导文本';
const DIVIDER = '━━━━━━━━━━━━━━━';

describe('新手指引只追加不拦截（背包/地图/查看使魔）', () => {
  it('背包：正文照常输出，引导追加在正文之后', async () => {
    const gameService: any = { handleInventory: jest.fn(async () => '🎒 背包 (2种)\n1、石斧') };
    const taskService: any = { advance: jest.fn(async () => '') };
    const tutorialService: any = { consumeTutorial: jest.fn(async () => TUTORIAL) };
    const handler = new InventoryHandler(gameService, taskService, tutorialService);

    const result = await handler.handle(
      { userId: 42, rawMessage: '背包', source: 'web' } as any,
      [],
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('🎒 背包 (2种)');
    expect(result.content).toContain(DIVIDER);
    expect(result.content).toContain(TUTORIAL);
    // 顺序：正文在前、引导在后（旧拦截式实现会让正文彻底消失）
    expect(result.content.indexOf('🎒 背包')).toBeLessThan(result.content.indexOf(TUTORIAL));
    expect(tutorialService.consumeTutorial).toHaveBeenCalledWith(42, 'viewBag');
  });

  it('背包：带参数时推进「查看背包详细」，正文与引导同时返回', async () => {
    const gameService: any = { handleInventory: jest.fn(async () => '【石斧】攻击+3') };
    const taskService: any = { advance: jest.fn(async () => '') };
    const tutorialService: any = { consumeTutorial: jest.fn(async () => TUTORIAL) };
    const handler = new InventoryHandler(gameService, taskService, tutorialService);

    const result = await handler.handle(
      { userId: 42, rawMessage: '背包 1', source: 'web' } as any,
      ['1'],
    );

    expect(taskService.advance).toHaveBeenCalledWith(42, '查看背包详细');
    expect(result.content).toContain('【石斧】攻击+3');
    expect(result.content).toContain(TUTORIAL);
  });

  it('地图：正文照常输出，引导追加在正文之后', async () => {
    const gameService: any = { handleMap: jest.fn(async () => '📍 当前位置：新手村') };
    const tutorialService: any = { consumeTutorial: jest.fn(async () => TUTORIAL) };
    const handler = new MapHandler(gameService, tutorialService);

    const result = await handler.handle({ userId: 42, rawMessage: '地图', source: 'web' } as any);

    expect(result.content).toContain('📍 当前位置：新手村');
    expect(result.content.indexOf('📍')).toBeLessThan(result.content.indexOf(TUTORIAL));
    expect(tutorialService.consumeTutorial).toHaveBeenCalledWith(42, 'map');
  });

  it('信息：正文照常输出，引导追加在正文之后', async () => {
    const gameService: any = { handleInfo: jest.fn(async () => '【剑圣】Lv.5') };
    const tutorialService: any = { consumeTutorial: jest.fn(async () => TUTORIAL) };
    const handler = new InfoHandler(gameService, tutorialService);

    const result = await handler.handle({ userId: 42, rawMessage: '信息', source: 'web' } as any);

    expect(result.content).toContain('【剑圣】Lv.5');
    expect(result.content.indexOf('【剑圣】')).toBeLessThan(result.content.indexOf(TUTORIAL));
    expect(tutorialService.consumeTutorial).toHaveBeenCalledWith(42, 'info');
  });

  it('信息：带参数命中地图单位时只展示单位详情，不消费 info 引导', async () => {
    const gameService: any = {
      handleViewUnit: jest.fn(async () => '【史莱姆】HP 52/52'),
      handleInfo: jest.fn(async () => '【剑圣】Lv.5'),
    };
    const tutorialService: any = { consumeTutorial: jest.fn(async () => TUTORIAL) };
    const handler = new InfoHandler(gameService, tutorialService);

    const result = await handler.handle({ userId: 42, rawMessage: '查看 史莱姆', source: 'web' } as any);

    expect(result.content).toBe('【史莱姆】HP 52/52');
    expect(tutorialService.consumeTutorial).not.toHaveBeenCalled();
  });

  it('对话（特殊NPC）：talk 引导追加在对话正文之后，且标记已消费', async () => {
    // 复刻旧缺陷：talk 引导只写标记+落库、文本从未拼进正文（引导被消费却看不到）
    const player: any = { id: 1, userId: 42, name: '剑圣', mapId: 1, markers: {} };
    const tutorialText = '📖 你看到前方有个人影，看起来是个NPC。';
    const stub = createGameServiceStub({
      playerService: {
        getPlayerData: jest.fn(async () => ({ player, markers: player.markers })),
        savePlayer: jest.fn(async () => undefined),
      },
      mapService: {
        getMapById: jest.fn(async () => ({ id: 1, name: '新手村', npcs: '[]', summons: '[]' })),
        getMapMonsters: jest.fn(async () => []),
      },
      taskService: { advance: jest.fn(async () => '') },
      tutorialService: { getTutorial: jest.fn(() => tutorialText) },
      support: { buildNumberedMenu: jest.fn(async () => ['💡 发送编号数字(如 1)快速操作']) },
    });

    const result = await stub.handleTalk(42, '新手引导员');

    expect(result).toContain('新手引导员');
    expect(result).toContain(tutorialText);
    // 顺序：对话正文在前、引导在后
    expect(result.indexOf('新手引导员')).toBeLessThan(result.indexOf(tutorialText));
    expect(player.markers['指引_talk']).toBe(1);
  });

  it('查看使魔：正文照常输出，引导追加在正文之后', async () => {
    const gameService: any = { handleViewFamiliar: jest.fn(async () => '【伊卡洛斯】好感0') };
    const tutorialService: any = { consumeTutorial: jest.fn(async () => TUTORIAL) };
    const handler = new GameCommandHandler(
      gameService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      tutorialService,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await handler.handle(
      { userId: 42, rawMessage: '查看使魔', source: 'web' } as any,
      [],
    );

    expect(result.content).toContain('【伊卡洛斯】好感0');
    expect(result.content.indexOf('【伊卡洛斯】')).toBeLessThan(result.content.indexOf(TUTORIAL));
    expect(tutorialService.consumeTutorial).toHaveBeenCalledWith(42, 'familiarData');
  });

  it('引导消费：首次返回文本并写入「指引_x」标记，重复/关闭引导后不再返回', async () => {
    const markers: Record<string, any> = {};
    const playerService: any = {
      getPlayerData: jest.fn(async () => ({ markers })),
      patchPlayer: jest.fn(async () => undefined),
    };
    const service = new TutorialService(playerService);

    // 首次：返回真实引导文本，标记已消费并落库
    const first = await service.consumeTutorial(42, 'viewBag');
    expect(first).toContain('📖');
    expect(markers['指引_viewBag']).toBe(1);
    expect(playerService.patchPlayer).toHaveBeenCalledWith(42, { markers }, 'tutorial');

    // 第二次：同类引导已消费 → 空串且不再落库
    playerService.patchPlayer.mockClear();
    const second = await service.consumeTutorial(42, 'viewBag');
    expect(second).toBe('');
    expect(playerService.patchPlayer).not.toHaveBeenCalled();

    // 关闭引导（指引=1）：其它类型也不再返回
    markers['指引'] = 1;
    expect(await service.consumeTutorial(42, 'map')).toBe('');
  });
});
