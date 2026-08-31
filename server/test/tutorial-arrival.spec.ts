/**
 * 教程到达与白NPC交互回归（对齐原版）：
 * 1. 到达“森林出口”延时结算 → 回复前插“完成了任务:教程-苏醒，得到了:优秀武器补给箱x1.02
 *    并领取了新的任务:教程-背包”块（原版 来倒目的 + 发放奖励 前插）；
 * 2. 对话白 → 原版菜单（查看/领取任务/不要跟着我了/救助/挤奶/控制终端）；
 * 3. 领取任务 白 → 从白对话任务池随机接取；
 * 4. TaskService 完成消息原版格式（含后续任务提示）。
 */
import { GameService } from '../src/modules/game/game.service';
import { TaskService } from '../src/modules/game/task.service';

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

describe('教程到达与白NPC交互（原版对齐）', () => {
  afterEach(() => jest.restoreAllMocks());

  function makeGameService(options: {
    player?: any;
    map?: any;
    taskService?: any;
  } = {}) {
    const player = options.player || {
      id: 1,
      userId: 42,
      name: '伊卡洛斯',
      mapId: 3,
      markers: '{}',
      markers2: '[]',
      equipment: '[]',
      weapons: '[]',
      sets: '{}',
      vehicle: '',
      hp: 100,
      backpack: '[]',
      tasks: '[]',
    };
    const map = options.map || {
      id: 3,
      name: '森林出口',
      description: '森林的出口',
      noTeleport: false,
      isFrontier: false,
      connections: JSON.stringify([{ name: '城镇出口', distance: 10 }, { name: '森林深处', distance: 10 }]),
      resources: '[]',
      resources2: '[]',
      items: '[]',
      npcs: '[]',
      summons: '[]',
      vehicles: '[]',
      buildings: '[]',
    };
    const taskService = options.taskService || {
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
      acceptTask: jest.fn(async () => '接受了任务'),
      getAvailableTasks: jest.fn(async () => []),
    };
    const gameMapUpdates: any[] = [];
    const service: any = Object.create(GameService.prototype);
    Object.assign(service, {
      prisma: {
        user: { findUnique: jest.fn(async () => ({ id: 42, nickname: '伊卡洛斯' })) },
        gameMap: { update: jest.fn(async (args: any) => { gameMapUpdates.push(args); return {}; }) },
      },
      playerService: {
        getPlayerData: jest.fn(async () => ({
          player,
          markers: parseJson(player.markers, {}),
          markers2: parseJson(player.markers2, []),
          equipment: parseJson(player.equipment, []),
          weapons: parseJson(player.weapons, []),
        })),
        safeJsonParse: jest.fn(parseJson),
        isPlayerDead: jest.fn(() => false),
        savePlayer: jest.fn(async () => undefined),
        getBackpackItems: jest.fn(() => []),
        enqueueUserWrite: jest.fn((_userId: number, fn: () => any) => fn()),
      },
      mapService: {
        getMapById: jest.fn(async () => map),
        getAllMaps: jest.fn(async () => [map]),
        getConnections: jest.fn((m: any) => parseJson(m?.connections, [])),
        getMapMonsters: jest.fn(async () => []),
      },
      combatSystem: { applyMapBuffs: jest.fn(async () => undefined) },
      achievementService: { addAchievement: jest.fn(async () => undefined), setAchievement: jest.fn() },
      taskService,
      shortcutService: { setTempInput: jest.fn(async () => undefined) },
      systemConfigService: { get: jest.fn(async () => true) },
      chatService: { broadcastSystem: jest.fn(async () => undefined), emitToUser: jest.fn() },
      staticData: {
        getDialogue: jest.fn(() => ''),
        getNpcByName: jest.fn((name: string) => name === '白对话'
          ? { name: '白对话', taskId: '聊天，套娃2' }
          : undefined),
        getTaskByName: jest.fn((name: string) => (['聊天', '套娃2'].includes(name)
          ? { name, requirements: JSON.stringify([{ name: '对话', count: 3 }]) }
          : undefined)),
        getAllTasks: jest.fn(() => []),
      },
      tutorialService: { getTutorial: jest.fn(() => '') },
      familiarSystemService: { checkAndUpdateGrowth: jest.fn() },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    return { service, player, map, taskService, gameMapUpdates };
  }

  it('到达森林出口：回复前插任务完成块与后续任务提示（原版格式）', async () => {
    const completion = '完成了任务:教程-苏醒，得到了:优秀武器补给箱x1.02\n并领取了新的任务:教程-背包';
    const taskService = {
      advance: jest.fn(async () => completion),
      consumeNotifications: jest.fn(() => completion),
    };
    const fixture = makeGameService({ taskService });
    fixture.player.markers = JSON.stringify({
      移动中: JSON.stringify({ targetMapId: 3, targetName: '森林出口', arriveAt: Date.now() - 1 }),
    });

    const result = await fixture.service.performArrival(42, 3, '森林出口');

    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '前往森林出口');
    expect(result).toContain('完成了任务:教程-苏醒，得到了:优秀武器补给箱x1.02');
    expect(result).toContain('并领取了新的任务:教程-背包');
    expect(result).toContain('————————');
    expect(result).toContain('伊卡洛斯来到了森林出口');
    // 到达附观察附近列表（原版 来倒目的 = 来到文本 + 观察附近），目的地可直达
    expect(result).toContain('城镇出口');
    expect(fixture.service.shortcutService.setTempInput).toHaveBeenCalled();
  });

  it('对话白（已唤醒）：菜单含 查看/领取任务/不要跟着我了/救助/挤奶/控制终端', async () => {
    const fixture = makeGameService({});
    fixture.player.markers = JSON.stringify({ 召唤白: 1 });
    fixture.map.summons = JSON.stringify([{
      name: '白',
      type: '白',
      qq: '召唤物1000',
      ownerQQ: '42',
      归属: '42',
      hp: 100,
      maxHp: 100,
      markers: { '好感42': 30, '跟随': 0 },
    }]);

    const result = await fixture.service.handleTalk(42, '白');

    expect(result).toContain('【白】');
    expect(result).toContain('1、查看');
    expect(result).toContain('2、领取任务');
    expect(result).toContain('3、不要跟着我了');
    expect(result).toContain('4、救助');
    expect(result).toContain('5、挤奶');
    expect(result).toContain('6、控制终端');
    const tempInput = fixture.service.shortcutService.setTempInput.mock.calls[0][1] as string;
    expect(tempInput).toContain('2@领取任务 白');
    expect(tempInput).toContain('不要跟着我了@设置跟随 白');
  });

  it('领取任务 白：从白对话任务池随机接取并带上发布人', async () => {
    const taskService = {
      getAvailableTasks: jest.fn(async () => [{ name: '聊天', level: 1 }]),
      acceptTask: jest.fn(async () => '接受了任务聊天'),
    };
    const fixture = makeGameService({ taskService });
    fixture.player.markers = JSON.stringify({ 召唤白: 1 });
    fixture.map.summons = JSON.stringify([{
      name: '白',
      type: '白',
      qq: '召唤物1000',
      ownerQQ: '42',
      markers: { '好感42': 30 },
    }]);

    await fixture.service.handleAcceptQuest(42, '白');

    expect(taskService.acceptTask).toHaveBeenCalledWith(
      42,
      '聊天',
      '召唤物1000',
      '白',
    );
  });

  it('任务完成消息为原版格式：得到了+并领取了新的任务', async () => {
    const prisma = {
      player: { findUnique: jest.fn() },
      gameMap: { findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) },
    };
    const playerService: any = {
      enqueueUserWrite: jest.fn((_userId: number, fn: () => any) => fn()),
      getPlayerData: jest.fn(async () => ({ player })),
      markPlayerDirty: jest.fn(),
      savePlayer: jest.fn(async () => undefined),
    };
    const staticData: any = {
      getTaskByName: (name: string) => ({
        '教程-苏醒': {
          name: '教程-苏醒',
          description: '离开医疗室。',
          requirements: '[{"name":"前往森林出口","count":1}]',
          rewards: '[{"name":"优秀武器补给箱","count":1}]',
          nextTasks: '["教程-背包"]',
        },
        '教程-背包': {
          name: '教程-背包',
          description: '查看背包。',
          requirements: '[{"name":"发送“查看背包”","count":1}]',
          rewards: '[]',
          nextTasks: '[]',
        },
      }[name]),
      getAllTasks: () => [],
    };
    const itemSystem: any = { generateRewardEquipment: jest.fn() };
    const taskService: any = new TaskService(
      prisma as any,
      playerService,
      staticData,
      itemSystem,
      undefined,
      undefined,
    );

    const player: any = {
      userId: 42,
      name: '伊卡洛斯',
      type: '伊卡洛斯',
      markers: JSON.stringify({ '任务熟练度': 1, '完成任务': 1 }),
      backpack: '[]',
      tasks: JSON.stringify([{ name: '教程-苏醒', requirements: [] }]),
      recipes: '[]',
      vitality: 0,
      affinity: 0,
    };
    prisma.player.findUnique.mockResolvedValue(player);
    jest.spyOn(taskService as any, 'getRewardScale').mockReturnValue(1.02);

    const message = await taskService.advance(42, '前往森林出口');

    expect(message).toContain('完成了任务:教程-苏醒，得到了:优秀武器补给箱x1.02');
    expect(message).toContain('并领取了新的任务:教程-背包');
    // 任务已结算删除、后续任务入列
    const tasks = JSON.parse(player.tasks);
    expect(tasks.some((t: any) => t.name === '教程-苏醒')).toBe(false);
    expect(tasks.some((t: any) => t.name === '教程-背包')).toBe(true);
  });

  it('森林出口对话史莱姆：无NPC/召唤物时怪物仍可对谈，并推进对话史莱姆任务', async () => {
    const taskService = {
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const fixture = makeGameService({ taskService });
    // 用户复现场景：森林出口无 npcs、无 summons，但地图上有史莱姆怪物。
    // 修复前 handleTalk 会因“npcs+summons 为空”前置门禁返回“当前地图没有可对话的NPC”，
    // 导致“主线-继续询问”要求的“对话史莱姆3”永远无法推进。
    fixture.map.npcs = '[]';
    fixture.map.summons = '[]';
    fixture.service.mapService.getMapMonsters = jest.fn(async () => [
      { id: 1, name: '史莱姆', 名称: '史莱姆', type: '史莱姆', level: 1, hp: 52, maxHp: 52, qq: '怪物1', markers: {} },
    ]);

    const result = await fixture.service.handleTalk(42, '史莱姆');

    expect(result).not.toContain('当前地图没有可对话的NPC');
    expect(result).toContain('【史莱姆】');
    // 推进通用「对话」与具体「对话史莱姆」，主线任务才能结算
    expect(taskService.advance).toHaveBeenCalledWith(42, '对话');
    expect(taskService.advance).toHaveBeenCalledWith(42, '对话史莱姆');
  });
});
