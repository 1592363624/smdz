/**
 * 地图怪物自动攻击循环 单元测试
 *
 * 对应原版：_主程序.ecode L200-535 覅攻击pd 延时递归驱动
 *   - 新建延时("覅攻击pd"+地图, N秒) 拉起回合，后台延时线程按 (命令,qq) 去重
 *   - 回合有目标 → 4秒后自动续回合（L504，"gwlq" 2秒节流 L503）
 *   - 防御方为空（"#没有目标"，战斗相关.ecode L47）→ 修复载具并终止循环（L507-529）
 *   - 玩家活跃（后台运作.ecode L399-411）刷新地图"活动"120秒（循环存活窗口）
 *
 * 测试策略：
 *   - MapBattleLoopService：jest fake timers 驱动延时，combatSystem/chatService 为桩。
 *   - adminAttackMap 续回合判定：真实 CombatStateService + IO 桩，
 *     以桩 loop 服务断言 scheduleRound(mapId, 4) 的调用与终止分支。
 */

import { jest } from '@jest/globals';
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';
import { MapBattleLoopService } from '../src/modules/game/map-battle-loop.service';
import { PlayerService } from '../src/modules/game/player.service';
import { StatsService } from '../src/modules/game/stats.service';

function makePlayer(overrides: Record<string, any> = {}): any {
  return {
    id: 10, userId: 2, name: '勇者', type: '', level: 30,
    mapId: 1, hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
    buffs: '[]', markers: '{}', markers2: '[]', backpack: '[]',
    ...overrides,
  };
}

function makeMonster(overrides: Record<string, any> = {}): any {
  return {
    id: 1001, mapId: 1, name: '史莱姆', type: '史莱姆', hp: 100, shield: 0, armor: 0,
    bonus: '{}', buffs: '[]', markers: '{}', markers2: '[]',
    ...overrides,
  };
}

function buildLoopService(overrides: {
  combatSystem?: any; online?: Set<number>; playersByMap?: Map<number, any[]>;
} = {}) {
  const mapService = {
    getMapById: jest.fn(async (mapId: number) => ({
      id: mapId, mapIndex: mapId, name: `地图${mapId}`,
      markers2: '[]', summons: '[]', vehicles: '[]',
    })),
    updateDynamicFields: jest.fn(async () => undefined),
  };
  const combatState = new CombatStateService();
  const statsService = {
    getOnlineUserIds: jest.fn(() => overrides.online ?? new Set<number>([2])),
  } as unknown as jest.Mocked<StatsService>;
  const prisma = {
    player: {
      findUnique: jest.fn(async ({ where }: any) => (where?.userId === 2 ? makePlayer() : null)),
      findMany: jest.fn(async ({ where }: any) => overrides.playersByMap?.get(where?.mapId) ?? [{ userId: 2 }]),
      findFirst: jest.fn(async () => null),
    },
  };
  const chatService = { broadcastSystem: jest.fn(async () => undefined) };
  const combatSystem = overrides.combatSystem ?? { adminAttackMap: jest.fn(async () => '怪物攻击了') };

  const loop = new MapBattleLoopService(
    prisma as any,
    mapService as any,
    combatState as any,
    statsService as any,
    chatService as any,
    combatSystem as any,
  );
  return { loop, mapService, chatService, combatSystem, prisma, combatState };
}

describe('MapBattleLoopService：原版 覅攻击pd 延时递归驱动', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('scheduleRound：同一地图重复登记只保留一个待执行回合（原版延时去重）', async () => {
    const { loop, combatSystem } = buildLoopService();
    loop.scheduleRound(1, 3);
    loop.scheduleRound(1, 3);
    loop.scheduleRound(1, 3);
    expect(loop.hasPendingRound(1)).toBe(true);

    await jest.advanceTimersByTimeAsync(3100);
    expect((combatSystem.adminAttackMap as jest.Mock).mock.calls.length).toBe(1);
    expect(loop.hasPendingRound(1)).toBe(false);
  });

  it('runRound：以同图在线玩家为名义执行回合并广播回合文本（原版发送群消息）', async () => {
    const { loop, combatSystem, chatService } = buildLoopService();
    loop.scheduleRound(1, 3);
    await jest.advanceTimersByTimeAsync(3100);

    expect((combatSystem.adminAttackMap as jest.Mock).mock.calls[0][0]).toBe(2);
    expect((combatSystem.adminAttackMap as jest.Mock).mock.calls[0][1]).toBe('1');
    expect(chatService.broadcastSystem).toHaveBeenCalledWith('世界频道', '怪物攻击了');
  });

  it('runRound：同图无人在线时以 0 进入（怪物仍攻击地图召唤物），空文本不广播', async () => {
    const { loop, combatSystem, chatService } = buildLoopService({
      online: new Set<number>([99]),
      combatSystem: { adminAttackMap: jest.fn(async () => '') },
    });
    loop.scheduleRound(1, 3);
    await jest.advanceTimersByTimeAsync(3100);

    expect((combatSystem.adminAttackMap as jest.Mock).mock.calls[0][0]).toBe(0);
    expect(chatService.broadcastSystem).not.toHaveBeenCalled();
  });

  it('triggerByPlayerAction：刷新地图"活动"120秒（玩家活跃）并延时拉起回合', async () => {
    const { loop, mapService, combatSystem } = buildLoopService();
    const map = { id: 1, mapIndex: 1, markers2: '[]' };
    await loop.triggerByPlayerAction(2, 3, { player: makePlayer(), map });

    const markers2 = JSON.parse(map.markers2);
    const active = markers2.find((item: any) => (item.名称 ?? item.name) === '活动');
    expect(active).toBeTruthy();
    expect(active.有效期至).toBeGreaterThan(Date.now() + 60_000);
    expect(mapService.updateDynamicFields).toHaveBeenCalledWith(1, expect.objectContaining({ markers2: map.markers2 }));
    expect((combatSystem.adminAttackMap as jest.Mock).mock.calls.length).toBe(0);
    expect(loop.hasPendingRound(1)).toBe(true);

    await jest.advanceTimersByTimeAsync(3100);
    expect((combatSystem.adminAttackMap as jest.Mock).mock.calls.length).toBe(1);
  });

  it('triggerByPlayerAction：隐匿模式玩家不惊动怪物（原版 L160 隐匿攻击豁免）', async () => {
    const { loop, combatSystem } = buildLoopService();
    const player = makePlayer({
      buffs: JSON.stringify([{ 名称: '隐匿模式', 有效期至: Date.now() + 60_000 }]),
    });
    const map = { id: 1, mapIndex: 1, markers2: '[]' };
    await loop.triggerByPlayerAction(2, 3, { player, map });

    expect(loop.hasPendingRound(1)).toBe(false);
    expect((combatSystem.adminAttackMap as jest.Mock).mock.calls.length).toBe(0);
  });

  it('triggerByPlayerAction：轻量路径（仅userId）从库读玩家并拉起；不存在的玩家忽略', async () => {
    const { loop, prisma } = buildLoopService();
    await loop.triggerByPlayerAction(2, 3);
    expect(loop.hasPendingRound(1)).toBe(true);
    expect(prisma.player.findUnique).toHaveBeenCalled();

    await loop.triggerByPlayerAction(42, 3);
    expect(loop.hasPendingRound(42)).toBe(false);
  });

  it('onApplicationShutdown：丢弃全部待执行回合', async () => {
    const { loop, combatSystem } = buildLoopService();
    loop.scheduleRound(1, 10);
    loop.scheduleRound(2, 10);
    loop.onApplicationShutdown();
    expect(loop.hasPendingRound(1)).toBe(false);
    await jest.advanceTimersByTimeAsync(11000);
    expect((combatSystem.adminAttackMap as jest.Mock).mock.calls.length).toBe(0);
  });
});

describe('adminAttackMap 续回合判定（原版 L502-530）', () => {
  function buildCombat(overrides: {
    online?: Set<number>; mapPlayers?: any[]; mapSummons?: string; monsters?: any[];
    loop?: any; vehicles?: string;
  } = {}) {
    const players = new Map<number, any>([[2, makePlayer()]]);
    const monstersByMap = new Map<number, any[]>([[1, overrides.monsters ?? [makeMonster()]]]);
    const savedFields: any[] = [];

    const playerService = {
      getPlayerData: jest.fn(async (userId: number) => ({ player: players.get(userId) ?? makePlayer({ userId }) })),
      isPlayerDead: jest.fn((player: any) => (player?.hp ?? 0) <= 0),
      savePlayer: jest.fn(async () => undefined),
      getMarkerValue: jest.fn((markers: any, key: string) => markers?.[key] ?? 0),
      safeJsonParse: jest.fn(<T,>(v: any, d: T): T => {
        if (v === null || v === undefined) return d;
        try { return (typeof v === 'string' ? JSON.parse(v) : v) as T; } catch { return d; }
      }),
    };
    const mapService = {
      getAllMaps: jest.fn(async () => [{
        id: 1, mapIndex: 1, name: '平原', isInstance: false,
        markers2: JSON.stringify([{ 名称: '活动', 有效期至: Date.now() + 3_600_000 }]),
        summons: overrides.mapSummons ?? '[]',
        vehicles: overrides.vehicles ?? '[]',
      }]),
      getMapById: jest.fn(async () => null),
      getMapMonsters: jest.fn(async () => monstersByMap.get(1)!),
      updateDynamicFields: jest.fn(async (_mapId: number, data: any) => { savedFields.push(data); }),
      updateMonsterFields: jest.fn(async () => undefined),
      saveGameMonster: jest.fn(async () => undefined),
      removeMapMonster: jest.fn(async () => undefined),
    };
    const prisma = {
      player: {
        findMany: jest.fn(async () => overrides.mapPlayers ?? [{ userId: 2 }]),
        findFirst: jest.fn(async () => null),
        update: jest.fn(async () => undefined),
      },
      gameMonster: { update: jest.fn(async () => undefined) },
    };
    const statsService = {
      getOnlineUserIds: jest.fn(() => overrides.online ?? new Set<number>([2])),
    };
    // loop 传 null 表示"未注入循环服务"（存量直构 CombatSystemService 的测试场景）
    const loop = overrides.loop === null ? undefined : (overrides.loop ?? { scheduleRound: jest.fn() });

    const combat = new CombatSystemService(
      prisma as any,
      playerService as unknown as jest.Mocked<PlayerService>,
      {} as any,
      mapService as any,
      {} as any,
      {} as any,
      {} as any,
      new CombatStateService(),
      statsService as unknown as StatsService,
      undefined,
      undefined,
      undefined,
      undefined,
      loop as any,
    );
    return { combat, mapService, prisma, statsService, loop, players, monstersByMap };
  }

  it('有目标：回合产生攻击文本 → gwlq 节流后 4秒续回合（scheduleRound(mapId,4)）', async () => {
    const { combat, loop } = buildCombat();
    jest.spyOn(combat as any, 'runMapMonsterAttack').mockImplementation(async (_m: any, _map: any, _u: any, _t: any, noTarget?: { value: boolean }) => {
      if (noTarget) noTarget.value = false;
      return ['史莱姆 攻击你，造成伤害 10'];
    });
    const out = await (combat as any).adminAttackMap(2, '1');
    expect(out).toContain('史莱姆');
    expect(loop.scheduleRound).toHaveBeenCalledWith(1, 4);
  });

  it('无目标（防御方为空）：终止循环、不续回合，并修复载具（原版 "#没有目标" 分支）', async () => {
    const { combat, loop } = buildCombat({
      online: new Set<number>(),           // 无人在线
      mapPlayers: [],                      // 地图无玩家
      mapSummons: '[]',                    // 无召唤物
      vehicles: JSON.stringify([{ id: 7, name: '破车', currentHp: 3, 生命: 10, 列表编号: 2, 上限: 1 }]),
      monsters: [makeMonster({ vehicle: '7' })], // 怪物挂载的损毁载具
    });
    const out = await (combat as any).adminAttackMap(0, '1');
    expect(out).toContain('修好了破车');
    expect(loop.scheduleRound).not.toHaveBeenCalled();
  });

  it('无地图战斗循环服务（存量直构场景）：正常结算且不调度', async () => {
    const { combat } = buildCombat({ loop: null });
    jest.spyOn(combat as any, 'runMapMonsterAttack').mockResolvedValue(['史莱姆 攻击你']);
    expect((combat as any).mapBattleLoop).toBeUndefined();
    const out = await (combat as any).adminAttackMap(2, '1');
    expect(out).toContain('史莱姆');
  });
});
