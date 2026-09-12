/**
 * 使魔排行十子榜复刻门禁（对应原版 _主程序.ecode L9562-9745）
 *
 * 覆盖：
 * ① 无参 → 十项编号菜单并注册临时输入替换（红线：编号菜单必须注册）
 * ② 未知子榜 → 「不是可以查看的排行榜」（原版 L9731）
 * ③ 玩家子榜过滤：老玩家(已选使魔)且等级>10（原版 L9571 等）
 * ④ 战斗力/等级/最高伤害/击杀/在线时间 数据源与格式（在线时间用 时间格式，原版 数字到时间）
 * ⑤ 理论输出公式：四系伤害 ×(1+暴击/100×(暴伤-100)/100)（原版 L9593）
 * ⑥ 宠物榜：存活过滤 + 复制品屏蔽 + 最高伤害 0 不入榜 + 名称(主人) 格式
 * ⑦ 财富榜保留原「排行 财富」入口且同样带玩家过滤
 * ⑧ recordRankingStats：在线时间累计（单次上限 180，原版 加成计算.ecode L1588-1605）
 *    与 战斗力历史最高记录（原版 L2474-2477）
 * ⑨ 战斗内 最高伤害/战斗力 记录（原版 战斗相关.ecode L3652-3663 / 加成计算 L3032-3034）
 */
import { GameService } from '../src/modules/game/game.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { BonusService } from '../src/modules/game/bonus.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { createGameServiceStub } from './helpers/game-service-stub.factory';

function parseValue<T>(value: any, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return (JSON.parse(value) ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function makeService(options: { players?: any[]; maps?: any[] } = {}) {
  const players = options.players || [];
  const maps = options.maps || [];
  const requester = players[0] || null;
  const savedPlayers: any[] = [];
  const tempInputs: string[] = [];

  const prisma: any = {
    player: {
      findUnique: jest.fn(async () => requester),
      findMany: jest.fn(async () => players),
    },
    gameMap: { findMany: jest.fn(async () => maps) },
  };

  const playerService: any = {
    // mutatePlayer 回退路径（无 playerMutate 注入时）
    enqueueUserWrite: jest.fn(async (_uid: number, fn: any) => fn()),
    getPlayerData: jest.fn(async (uid: number) => {
      const row = players.find((p) => p.userId === uid) || {};
      // 直接引用行对象（模拟落库后行状态随保存推进），而非副本
      const player = row;
      return {
        player,
        markers: parseValue<Record<string, number>>(row.markers, {}),
        backpack: parseValue(row.backpack, []),
        equipment: [],
        weapons: [],
        markers2: [],
        buffs: [],
        tasks: [],
        safeBox: [],
        sets: {},
      };
    }),
    savePlayer: jest.fn(async (value: any) => { savedPlayers.push(value); }),
    getMarkerValue: (_m: any, _k: string) => 0,
    isPlayerDead: (p: any) => (p.hp || 0) <= 0,
  };

  const shortcutService: any = { setTempInput: jest.fn(async (_uid: number, groups: string) => { tempInputs.push(groups); }) };
  const combatState = new CombatStateService();
  const bonusService = new BonusService();

  // 理论输出/战斗力记录用：默认给一套可预期的属性
  const combatSystem: any = {
    buildAttackerBonus: jest.fn((_p: any, _d: any) => ({
      物伤: 100, 冰伤: 50, 电伤: 0, 火伤: 0, 暴击: 20, 暴击伤害: 150,
      生命: 1000, 装甲: 100, 护盾: 200, 速度: 10, 攻击: 50, 命中: 100, 闪避: 10,
    })),
  };

  const service = createGameServiceStub({
      prisma: prisma,
      playerService: playerService,
      bonusService: bonusService,
      combatSystem: combatSystem,
      itemService: {} as any,
      mapService:     {} as any,
      familiarService:     {} as any,
      dungeonService: {} as any,
      adminService: {} as any,
      achievementService:     {} as any,
      itemSystemService:     {} as any,
      homeService:     {} as any,
      familiarSystemService:     {} as any,
      familiarSkillsService:     {} as any,
      tutorialService:     {} as any,
      staticData:     new StaticDataService(),
      systemConfigService: {} as any,
      chatService:     {} as any,
      feedbackService:     {} as any,
      taskService:     {} as any,
      shortcutService:     shortcutService,
      statsService: {} as any,
      combatState:     combatState,
    });

  return { service, prisma, players, maps, savedPlayers, tempInputs, combatSystem, bonusService, shortcutService, combatState };
}

/** 只挂原型方法的最小 CombatSystemService 桩（测两个私有记录助手） */
function makeCombatHelperStub() {
  const cs: any = Object.create(CombatSystemService.prototype);
  cs.bonusService = new BonusService();
  return cs;
}

describe('使魔排行十子榜复刻（原版 _主程序.ecode L9562-9745）', () => {
  const basePlayer = (over: any = {}) => ({
    userId: 1, name: '甲', type: '花园猫', level: 12, markers: JSON.stringify({}), ...over,
  });

  it('无参输出十项编号菜单并注册临时输入替换', async () => {
    const { service, tempInputs } = makeService({ players: [basePlayer()] });
    const text = await (service as any).handleFamiliarRank(1, '');
    for (const t of ['战斗力', '等级', '理论输出', '最高伤害', '击杀', '在线时间', '财富', '宠物战斗力', '宠物最高伤害', '载具']) {
      expect(text).toContain(`使魔排行${t}`);
    }
    expect(tempInputs).toHaveLength(1);
    expect(tempInputs[0]).toContain('1@使魔排行战斗力');
    expect(tempInputs[0]).toContain('10@使魔排行载具');
  });

  it('未知子榜返回原版兜底文案', async () => {
    const { service } = makeService({ players: [basePlayer()] });
    const text = await (service as any).handleFamiliarRank(1, '不存在');
    expect(text).toBe('甲不是可以查看的排行榜');
  });

  it('玩家子榜过滤：未选使魔/等级≤10 不入榜，并按数值降序', async () => {
    const { service } = makeService({
      players: [
        basePlayer({ userId: 1, name: '甲', markers: JSON.stringify({ 战斗力: 100 }) }),
        basePlayer({ userId: 2, name: '乙', type: '', markers: JSON.stringify({ 战斗力: 999 }) }), // 未选使魔
        basePlayer({ userId: 3, name: '丙', level: 10, markers: JSON.stringify({ 战斗力: 888 }) }), // 等级不足
        basePlayer({ userId: 4, name: '丁', level: 11, markers: JSON.stringify({ 战斗力: 50 }) }),
      ],
    });
    const text = await (service as any).handleFamiliarRank(1, '战斗力');
    expect(text).toContain('曾经达到的最高战斗力排行');
    expect(text).toContain('1、甲(100)');
    expect(text).toContain('2、丁(50)');
    expect(text).not.toContain('乙');
    expect(text).not.toContain('丙');
  });

  it('最高伤害/击杀 为 0 不入榜；在线时间用时间格式', async () => {
    const { service } = makeService({
      players: [
        basePlayer({ userId: 1, name: '观察者', markers: JSON.stringify({}) }),
        basePlayer({ userId: 2, name: '甲', markers: JSON.stringify({ 最高伤害: 0, 击败怪物: 0, 在线时间: 3661 }) }),
        basePlayer({ userId: 3, name: '乙', markers: JSON.stringify({ 最高伤害: 77, 击败怪物: 3, 在线时间: 59 }) }),
      ],
    });
    const dmg = await (service as any).handleFamiliarRank(1, '最高伤害');
    expect(dmg).toContain('1、乙(77)');
    expect(dmg).not.toContain('甲(');
    const kill = await (service as any).handleFamiliarRank(1, '击杀');
    expect(kill).toContain('1、乙(3)');
    const online = await (service as any).handleFamiliarRank(1, '在线时间');
    expect(online).toContain('1、甲(1小时1分)');
    expect(online).toContain('2、乙(59秒)');
  });

  it('理论输出公式：四系和×(1+暴击/100×(暴伤-100)/100)', async () => {
    const { service } = makeService({ players: [basePlayer()] });
    const text = await (service as any).handleFamiliarRank(1, '理论输出');
    // element=150; value = 150 + 150*0.2*0.5 = 165
    expect(text).toContain('理论输出排行');
    expect(text).toContain('1、甲(165)');
  });

  it('宠物榜：死亡不入榜、复制品屏蔽、最高伤害0不入榜、名称带主人', async () => {
    const { service } = makeService({
      players: [basePlayer({ userId: 9, name: '主人' })],
      maps: [
        { summons: [
          { name: '白', qq: '100g', hp: 10, 归属: '9', markers: { 战斗力: 500, 最高伤害: 80 } },
          { name: '白复制品', qq: '100g', hp: 10, 归属: '9', markers: { 战斗力: 9999 } },
          { name: '亡灵猫', qq: '101g', hp: 0, 归属: '9', markers: { 战斗力: 800 } },
          { name: '新手猫', qq: '102g', hp: 5, 归属: '9', markers: { 战斗力: 60, 最高伤害: 0 } },
        ] },
      ],
    });
    const power = await (service as any).handleFamiliarRank(1, '宠物战斗力');
    expect(power).toContain('宠物曾经达到的最高战斗力排行');
    expect(power).toContain('1、白(主人)(500)');
    expect(power).toContain('2、新手猫(主人)(60)');
    expect(power).not.toContain('白复制品');
    expect(power).not.toContain('亡灵猫');
    const petDmg = await (service as any).handleFamiliarRank(1, '宠物最高伤害');
    expect(petDmg).toContain('1、白(主人)(80)');
    expect(petDmg).not.toContain('新手猫'); // 最高伤害 0 不入榜
  });

  it('排行 财富 保留独立入口且同样带玩家过滤', async () => {
    const { service } = makeService({
      players: [
        basePlayer({ userId: 1, name: '甲', backpack: JSON.stringify([{ name: '铁矿', type: '资源', quantity: 1 }]) }),
        basePlayer({ userId: 2, name: '丙', type: '', level: 99 }),
      ],
    });
    const text = await (service as any).handleRanking(1, '财富');
    expect(text).toContain('游戏总财富排行');
    expect(text).toContain('甲');
    expect(text).not.toContain('丙');
  });

  it('recordRankingStats：在线时间累计(单次上限180) + 战斗力取历史最高', async () => {
    const { service, savedPlayers } = makeService({ players: [basePlayer()] });
    // 首条指令：不累计在线时间，但记录战斗力
    await (service as any).recordRankingStats(1);
    const afterFirst = parseValue<Record<string, number>>(savedPlayers[0].markers, {});
    expect(afterFirst['在线时间']).toBeUndefined();
    expect(afterFirst['战斗力']).toBeGreaterThan(0);

    // 手动回拨上次指令时间 120 秒 → 第二条累计 120
    (service as any).rankingService.lastCalcAtByUser.set(1, Date.now() - 120_000);
    await (service as any).recordRankingStats(1);
    const afterSecond = parseValue<Record<string, number>>(savedPlayers[savedPlayers.length - 1].markers, {});
    expect(afterSecond['在线时间']).toBe(120);

    // 超长离线（>180s）只记 180
    (service as any).rankingService.lastCalcAtByUser.set(1, Date.now() - 10 * 60_000);
    await (service as any).recordRankingStats(1);
    const afterThird = parseValue<Record<string, number>>(savedPlayers[savedPlayers.length - 1].markers, {});
    expect(afterThird['在线时间']).toBe(300);

    // 历史最高战斗力不被更低值覆盖
    const high = afterThird['战斗力'];
    (service as any).combatSystem.buildAttackerBonus = jest.fn(() => ({ 物伤: 0, 生命: 1 }));
    (service as any).rankingService.lastCalcAtByUser.set(1, Date.now() - 5_000);
    await (service as any).recordRankingStats(1);
    const afterFourth = parseValue<Record<string, number>>(savedPlayers[savedPlayers.length - 1].markers, {});
    expect(afterFourth['战斗力']).toBe(high);
  });

  it('战斗记录助手：玩家最高伤害/战斗力取max，敌对怪物不记录', () => {
    const cs = makeCombatHelperStub();
    const bonus = { 物伤: 100, 生命: 1000, 装甲: 100, 护盾: 200, 速度: 10, 攻击: 50, 命中: 100, 闪避: 10, 暴击: 5, 暴击伤害: 150 } as any;

    const playerData: any = { markers: {} };
    const player: any = { specialSeq: 22, markers: {} };
    (cs as any).recordMaxDamageDealt(player, playerData, 123.456, false);
    (cs as any).recordMaxDamageDealt(player, playerData, 50, false);
    expect(playerData.markers['最高伤害']).toBe(123.46);
    expect(player.markers['最高伤害']).toBe(123.46);

    (cs as any).recordCombatPowerSnapshot(player, playerData, bonus, false);
    const power = Number(playerData.markers['战斗力']);
    expect(power).toBeGreaterThan(0);
    (cs as any).recordCombatPowerSnapshot(player, playerData, { 生命: 1 } as any, false);
    expect(Number(playerData.markers['战斗力'])).toBe(power);

    // 使魔（运行时攻击方）：写自身标记
    const pet: any = { specialSeq: -2, markers: {} };
    (cs as any).recordMaxDamageDealt(pet, null, 66, true);
    expect(pet.markers['最高伤害']).toBe(66);
    (cs as any).recordCombatPowerSnapshot(pet, null, bonus, true);
    expect(Number(pet.markers['战斗力'])).toBeGreaterThan(0);

    // 敌对怪物（特殊序号=-1）不记录
    const monster: any = { specialSeq: -1, markers: {} };
    (cs as any).recordMaxDamageDealt(monster, null, 999, true);
    (cs as any).recordCombatPowerSnapshot(monster, null, bonus, true);
    expect(monster.markers['最高伤害']).toBeUndefined();
    expect(monster.markers['战斗力']).toBeUndefined();
  });
});
