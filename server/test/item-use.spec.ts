import { ItemService } from '../src/modules/game/item.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';
import { PlayerService } from '../src/modules/game/player.service';
import { MapService } from '../src/modules/game/map.service';
import { parseJson } from './parse-json.util';

/**
 * 打开箱子 1:1 复刻自检（物品操作.ecode L2220-2458）
 */

function buildCombatStateStub() {
  const combatState = new CombatStateService();
  return combatState;
}

describe('打开箱子（使用物品）', () => {
  function buildPlayer(overrides: Record<string, any> = {}) {
    return {
      id: 1,
      userId: 42,
      name: '测试玩家',
      level: 10,
      hp: 100,
      maxHp: 1000,
      shield: 500,
      maxShield: 500,
      armor: 300,
      maxArmor: 300,
      exp: 0,
      backpack: JSON.stringify([]),
      markers: {},
      markers2: [],
      buffs: [],
      houseName: '',
      ...overrides,
    } as any;
  }

  function buildHarness(player: any, staticItems: Record<string, any>, equipmentNames: string[] = []) {
    const prisma: any = {
      player: {
        findUnique: jest.fn(async () => player),
        update: jest.fn(async ({ data }: any) => {
          Object.assign(player, data);
          return player;
        }),
      },
      gameMap: {
        update: jest.fn(async () => ({})),
      },
    };
    const savedPlayers: any[] = [];
    const playerService: any = {
      safeJsonParse: <T>(json: any, fallback: T): T => {
        if (typeof json !== 'string') return (json === undefined || json === null ? fallback : json) as T;
        try { return JSON.parse(json) as T; } catch { return fallback; }
      },
      getBackpackItems: (p: any) => {
        if (!Array.isArray(p.backpack)) p.backpack = JSON.parse(p.backpack || '[]');
        return p.backpack;
      },
      getPlayerData: async () => ({
        player,
        backpack: typeof player.backpack === 'string' ? JSON.parse(player.backpack) : player.backpack,
        markers: player.markers,
        markers2: player.markers2,
        buffs: player.buffs,
      }),
      savePlayer: async (p: any) => {
        savedPlayers.push(JSON.parse(JSON.stringify({
          backpack: typeof p.backpack === 'string' ? p.backpack : JSON.stringify(p.backpack),
          markers: p.markers,
          markers2: p.markers2,
          buffs: p.buffs,
          hp: p.hp,
          shield: p.shield,
          armor: p.armor,
          exp: p.exp,
        })));
      },
    };
    const staticData: any = {
      getItemByName: jest.fn((name: string) => staticItems[name]),
      getEquipmentByName: jest.fn((name: string) =>
        equipmentNames.includes(name) ? { name } : undefined),
      getAllEffects: jest.fn(() => []),
      getEffectById: jest.fn(() => undefined),
    };
    const mapService: any = {
      getMapByName: jest.fn(async () => null),
    };

    /** 模拟真实 distributeLoot：装备生成品质数据入包，经验直接累加，资源叠加 */
    const itemSystem: any = {
      distributeLoot: async (_playerData: any, drops: any[]) => {
        const parts: string[] = [];
        for (const drop of drops) {
          if (equipmentNames.includes(drop.name)) {
            const p = playerService.getBackpackItems(player);
            for (let i = 0; i < Math.max(1, Math.floor(drop.quantity)); i++) {
              p.push({ name: drop.name, type: '装备', quantity: 1, count: 1, durability: 0, data: 'c' });
              parts.push(`${drop.name}×1`);
            }
            player.backpack = JSON.stringify(p);
          } else if (drop.name === '经验') {
            player.exp = (player.exp || 0) + Math.floor(drop.quantity);
            parts.push(`经验${Math.floor(drop.quantity)}`);
          } else {
            const p = playerService.getBackpackItems(player);
            const existing = p.find((it: any) => it.name === drop.name && it.type !== '装备');
            if (existing) {
              existing.quantity += drop.quantity;
              existing.count = existing.quantity;
            } else {
              p.push({ name: drop.name, type: '资源', quantity: drop.quantity, count: drop.quantity });
            }
            player.backpack = JSON.stringify(p);
            parts.push(`${drop.name}x${drop.quantity}`);
          }
        }
        return parts.join('、');
      },
    };

    const service = new ItemService(
      prisma as PrismaService,
      staticData as StaticDataService,
      buildCombatStateStub(),
      playerService as unknown as PlayerService,
      mapService as unknown as MapService,
      itemSystem,
    );
    return { service, prisma, playerService, savedPlayers };
  }

  it('装备箱产出走品质链路：生成带品质数据的独立装备并按原版文本展示', async () => {
    const player = buildPlayer({
      backpack: JSON.stringify([{ name: '普通装备箱', type: '资源', quantity: 2, count: 2 }]),
    });
    const { service } = buildHarness(
      player,
      { '普通装备箱': { name: '普通装备箱', useEffects: JSON.stringify(['铁剑1']), useMarkers: '[]' } },
      ['铁剑'],
    );

    const text = await service.useItem(42, '普通装备箱', 2);
    const backpack = typeof player.backpack === 'string' ? JSON.parse(player.backpack) : player.backpack;

    expect(text).toContain('测试玩家使用了2个普通装备箱');
    expect(text).toContain('[1]铁剑C');
    // 箱子已消耗
    expect(backpack.find((it: any) => it.name === '普通装备箱')).toBeUndefined();
    // 两件独立品质装备入包
    const swords = backpack.filter((it: any) => it.name === '铁剑');
    expect(swords.length).toBe(2);
    expect(swords[0].data).toBe('c');
    // 使用物品成就按装备件数累计（原版 L2453）
    expect(player.markers['使用物品']).toBe(2);
    expect(player.markers['使用普通装备箱']).toBe(2);
  });

  it('碎数量（<1）不可使用：拒绝并保留原数量，不产生任何产出（2026-09-04 收紧）', async () => {
    const player = buildPlayer({
      backpack: JSON.stringify([{ name: '优秀装备补给箱', type: '资源', quantity: 0.10624999999999996, count: 0.10624999999999996 }]),
    });
    const { service } = buildHarness(
      player,
      { '优秀装备补给箱': { name: '优秀装备补给箱', useEffects: JSON.stringify(['动力臂甲D1']), useMarkers: '[]' } },
      ['动力臂甲D'],
    );

    // 指定数量（默认1）与 使用全部 两条路径都必须拒绝
    const text1 = await service.useItem(42, '优秀装备补给箱', 1);
    expect(text1).toContain('剩余不足1个，无法使用');
    const text2 = await service.useItem(42, '优秀装备补给箱', -1);
    expect(text2).toContain('剩余不足1个，无法使用');

    const backpack = typeof player.backpack === 'string' ? JSON.parse(player.backpack) : player.backpack;
    // 碎数量原样保留，未被吞掉；也没有装备产出
    expect(backpack.find((it: any) => it.name === '优秀装备补给箱')?.quantity).toBeCloseTo(0.10624999999999996, 12);
    expect(backpack.filter((it: any) => it.name === '动力臂甲D').length).toBe(0);
    expect(player.markers['使用物品']).toBeUndefined();
  });

  it('种子箱多候选池随机发放资源并消耗箱子（原 L2407-2410）', async () => {
    const player = buildPlayer({
      backpack: JSON.stringify([{ name: '种子箱', type: '资源', quantity: 10, count: 10 }]),
    });
    const { service } = buildHarness(
      player,
      { '种子箱': { name: '种子箱', useEffects: JSON.stringify(['椰树种子1，椰树种子1，金龙果种子1']), useMarkers: '[]' } },
    );
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const text = await service.useItem(42, '种子箱', 10);
      const backpack = parseJson(player.backpack, []);
      expect(text).toContain('椰树种子x10');
      expect(backpack.find((it: any) => it.name === '种子箱')).toBeUndefined();
      expect(backpack.find((it: any) => it.name === '椰树种子')?.quantity).toBe(10);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('奶恢复三池并附带经验掉落；死亡状态受120秒复活冷却限制', async () => {
    const player = buildPlayer({
      backpack: JSON.stringify([{ name: '奶', type: '资源', quantity: 5, count: 5 }]),
    });
    const { service } = buildHarness(
      player,
      { '奶': { name: '奶', useEffects: JSON.stringify(['经验10000']), useMarkers: '[]' } },
    );

    // 存活状态：享用了
    let text = await service.useItem(42, '奶', 1);
    expect(text).toContain('享用了1的奶，恢复了10%的状态');
    expect(player.hp).toBeCloseTo(150); // 100 + 500*0.1
    expect(player.exp).toBe(10000);

    // 死亡状态复活成功
    player.hp = 0;
    text = await service.useItem(42, '奶', 1);
    expect(text).toContain('使用了1的奶，恢复了10%的状态');
    expect(player.hp).toBeGreaterThan(0);

    // 冷却中（死亡状态）：不复活不回复，但仍正常消耗并获得经验掉落（原版 L2286-2287 仅跳过回复）
    const backpackBefore = parseJson(player.backpack, []).length;
    player.hp = 0; // 复活冷却仅对死亡状态生效，需再次处于死亡状态
    const beforeExp = player.exp;
    text = await service.useItem(42, '奶', 1);
    expect(text).toContain('使用奶复活冷却');
    expect(player.exp).toBe(beforeExp + 10000);
    const afterPack = parseJson(player.backpack, []);
    expect(afterPack.find((it: any) => it.name === '奶')?.quantity).toBe(2); // 5-1-1-1
  });

  it('凭证每日一次发放等级/2的改良建筑箱，冷却中不消耗凭证', async () => {
    const player = buildPlayer({
      level: 11,
      backpack: JSON.stringify([{ name: '凭证', type: '资源', quantity: 5, count: 5 }]),
    });
    const { service } = buildHarness(
      player,
      { '凭证': { name: '凭证', useEffects: JSON.stringify(['经验1']), useMarkers: '[]' } },
    );

    const text = await service.useItem(42, '凭证', 3);
    expect(text).toContain('得到了5的改良建筑箱'); // floor(11/2)=5
    const backpack = parseJson(player.backpack, []);
    // 实际消耗固定为 1（原版 使用数量=1）
    expect(backpack.find((it: any) => it.name === '凭证')?.quantity).toBe(4);
    expect(backpack.find((it: any) => it.name === '改良建筑箱')?.quantity).toBe(5);
    expect(player.markers['凭证']).toBe(1);

    // 同日再次使用：进入冷却且不消耗
    const text2 = await service.useItem(42, '凭证', 1);
    expect(text2).not.toContain('改良建筑箱');
    expect(text2).toMatch(/\d+分|\d+秒|\d+小时/); // 剩余冷却时间文本
    expect(parseJson(player.backpack, []).find((it: any) => it.name === '凭证')?.quantity).toBe(4);
  });

  it('蛋糕授予掉落率+50%增益并显示剩余时间', async () => {
    const player = buildPlayer({
      backpack: JSON.stringify([{ name: '蛋糕', type: '资源', quantity: 2, count: 2 }]),
    });
    const { service } = buildHarness(
      player,
      { '蛋糕': { name: '蛋糕', useEffects: JSON.stringify(['经验40000']), useMarkers: '[]' } },
    );

    const text = await service.useItem(42, '蛋糕', 2);
    expect(text).toContain('享用了2的蛋糕，掉落率+50%');
    expect(text).toMatch(/\(\d+分\d+秒\)/);
    const cakeBuff = player.buffs.find((b: any) => b.名称 === '蛋糕');
    expect(cakeBuff).toBeTruthy();
    expect(cakeBuff.有效期至).toBeGreaterThan(Date.now());
  });

  it('至纯圣水无家园时提前返回不消耗；有家园时加速观测时间', async () => {
    const playerNoHome = buildPlayer({
      backpack: JSON.stringify([{ name: '至纯圣水', type: '资源', quantity: 3, count: 3 }]),
    });
    const noHome = buildHarness(
      playerNoHome,
      { '至纯圣水': { name: '至纯圣水', useEffects: JSON.stringify(['经验4000']), useMarkers: '[]' } },
    );
    const text1 = await noHome.service.useItem(42, '至纯圣水', 1);
    expect(text1).toContain('你还没有家园，无法使用这个');
    expect(parseJson(playerNoHome.backpack, []).find((it: any) => it.name === '至纯圣水')?.quantity).toBe(3);

    // 有家园
    const homeMap: any = { id: 9, markers: JSON.stringify({ 观测时间: Date.now() / 1000 }) };
    const playerWithHome = buildPlayer({
      houseName: '测试屋',
      backpack: JSON.stringify([{ name: '至纯圣水', type: '资源', quantity: 6, count: 6 }]),
    });
    const prisma: any = {
      player: { findUnique: jest.fn(async () => playerWithHome), update: jest.fn() },
      gameMap: { update: jest.fn(async ({ data }: any) => { homeMap.markers = data.markers; return {}; }) },
    };
    const harness = buildHarness(playerWithHome, {
      '至纯圣水': { name: '至纯圣水', useEffects: JSON.stringify(['经验4000']), useMarkers: '[]' },
    });
    (harness.service as any).mapService.getMapByName = jest.fn(async () => homeMap);
    // 模拟生产 mutateMapFields 闭环：重读最新字段 → 跑 mutator → 把改动写回 homeMap
    (harness.service as any).mapService.mutateMapFields = jest.fn(
      async (_mapId: number, fields: string[], mutator: (f: any) => any) => {
        const f: any = {};
        for (const field of fields) {
          const raw = homeMap[field];
          f[field] = parseJson(raw, field === 'markers' ? {} : []);
        }
        const result = await mutator(f);
        for (const field of fields) homeMap[field] = f[field];
        return result ?? {};
      },
    );
    (harness.service as any).prisma = prisma;

    const text2 = await harness.service.useItem(42, '至纯圣水', 5);
    expect(text2).toContain('测试屋的时间加速了5分钟');
    const markers = parseJson(homeMap.markers, {});
    // 加速后观测时间应比当前时间早约 300 秒
    expect(Date.now() / 1000 - markers['观测时间']).toBeGreaterThanOrEqual(295);
  });

  it('普通战利品：小数数量(0.03334)不显示，且无装备时不挂悬空「和」', async () => {
    // 复刻 items.json 的普通战利品：合金6.66666 + 普通武器补给箱0.03334
    const player = buildPlayer({
      backpack: JSON.stringify([{ name: '普通战利品', type: '资源', quantity: 1, count: 1 }]),
    });
    const { service } = buildHarness(
      player,
      { '普通战利品': { name: '普通战利品', useEffects: JSON.stringify(['合金6.66666', '普通武器补给箱0.03334']), useMarkers: '[]' } },
    );

    const text = await service.useItem(42, '普通战利品', 1);
    console.log('[普通战利品]', text);

    // 合金 6.66666 → 四舍五入保留2位去尾零 = 6.67，应显示
    expect(text).toContain('合金x6.67');
    // 普通武器补给箱 0.03334 → 取整≈0.03 <1 → 不显示（对照原版 显示物品「不显示小于1」）
    expect(text).not.toContain('普通武器补给箱');
    // 无装备产出：不应有悬空的「和」收尾
    expect(text).not.toMatch(/得到了[^，。]*和\s*$/);
    expect(text.endsWith('和')).toBe(false);
    // 物品被正确消耗
    const backpack = parseJson(player.backpack, []);
    expect(backpack.find((it: any) => it.name === '普通战利品')).toBeUndefined();
    expect(backpack.find((it: any) => it.name === '合金')?.quantity).toBeCloseTo(6.67, 2);
  });

  it('使用全部箱：模糊匹配全部箱类物品倒序逐一开箱，种子被屏蔽，装备只显示件数（_主程序.ecode L4517-4540）', async () => {
    const player = buildPlayer({
      backpack: JSON.stringify([
        { name: '精良装备补给箱', type: '资源', quantity: 2, count: 2 },
        { name: '资源箱', type: '资源', quantity: 3, count: 3 },
        { name: '苹果树种子', type: '资源', quantity: 5, count: 5 }, // 种子：使用可得单池命中资源 → 屏蔽
        { name: '铁剑', type: '装备', quantity: 1, count: 1 },       // 名字含“剑”不含“箱”，不受影响
      ]),
    });
    const { service } = buildHarness(
      player,
      {
        '精良装备补给箱': { name: '精良装备补给箱', useEffects: JSON.stringify(['铁剑', '改良建筑箱0.2']), useMarkers: '[]' },
        '资源箱': { name: '资源箱', useEffects: JSON.stringify(['木头7', '石头6']), useMarkers: '[]' },
        '苹果树种子': { name: '苹果树种子', useEffects: JSON.stringify(['苹果树']), useMarkers: '[]' },
      },
      ['铁剑', '苹果树'],
    );
    // 资源列表：苹果树是资源（因此 苹果树种子 被判为种子）；改良建筑箱不是装备（资源箱）
    (service as any).staticData.getAllResources = jest.fn(() => [{ name: '苹果树' }, { name: '木头' }, { name: '石头' }]);
    (service as any).staticData.getEquipmentByName = jest.fn((name: string) => (name === '铁剑' ? { name } : undefined));

    const text = await service.useAllItems(42, '箱');
    console.log('[使用全部箱]', text);

    // 每箱类型一行，各开全部数量（量词已优化为「个」）
    expect(text).toContain('测试玩家使用了2个精良装备补给箱');
    expect(text).toContain('测试玩家使用了3个资源箱');
    // 装备数量少时展开具体名称（含品质前缀），不再只显示件数
    expect(text).toContain('[1]铁剑');
    expect(text).not.toMatch(/,得到了和\d+件装备/);
    expect(text).not.toMatch(/,得到了和\s*$/);
    // 资源箱资源列出
    expect(text).toContain('木头x21');
    expect(text).toContain('石头x18');
    // 种子被屏蔽：苹果树种子原样保留
    const backpack = parseJson(player.backpack, []);
    expect(backpack.find((it: any) => it.name === '苹果树种子')?.quantity).toBe(5);
    // 全部箱子已消耗
    expect(backpack.find((it: any) => it.name === '精良装备补给箱')).toBeUndefined();
    expect(backpack.find((it: any) => it.name === '资源箱')).toBeUndefined();
    // 开箱新产出的改良建筑箱不被本轮重复开箱（数量为产物本身）
    expect(backpack.find((it: any) => it.name === '改良建筑箱')?.quantity).toBeCloseTo(0.4, 2);
  });

  it('使用全部：无匹配时返回“没有匹配的物品”，无关键词时返回用法提示', async () => {
    const player = buildPlayer({
      backpack: JSON.stringify([{ name: '苹果树种子', type: '资源', quantity: 5, count: 5 }]),
    });
    const { service } = buildHarness(
      player,
      { '苹果树种子': { name: '苹果树种子', useEffects: JSON.stringify(['苹果树']), useMarkers: '[]' } },
    );
    (service as any).staticData.getAllResources = jest.fn(() => [{ name: '苹果树' }]);

    const noMatch = await service.useAllItems(42, '补给箱');
    expect(noMatch).toBe('测试玩家没有匹配的物品');

    const noKeyword = await service.useAllItems(42, '');
    expect(noKeyword).toContain('“使用全部补给箱”来全部使用名字中包含[补给箱]的物品');
  });

  it('使用全部：小数数量箱子只使用整数部分（原版 L2246 取整）；未定义物品 #错误 按原版覆盖已累积文本', async () => {
    const player = buildPlayer({
      backpack: JSON.stringify([
        { name: '优秀武器补给箱', type: '资源', quantity: 1.0352999999999999, count: 1.0352999999999999 },
        { name: '主线补给箱', type: '资源', quantity: 2, count: 2 }, // harness 的 mock 目录未定义该物品 → #错误（验证未定义物品分支）
        { name: '挑战资源箱', type: '资源', quantity: 2, count: 2 },
      ]),
    });
    const { service } = buildHarness(
      player,
      {
        '优秀武器补给箱': { name: '优秀武器补给箱', useEffects: JSON.stringify(['特斯拉,纵横,矢量,特斯拉,纵横,矢量,特斯拉,纵横,矢量']), useMarkers: '[]' },
        '挑战资源箱': { name: '挑战资源箱', useEffects: JSON.stringify(['水晶10', '能量块5', '合金20']), useMarkers: '[]' },
      },
      ['特斯拉', '纵横', '矢量'],
    );
    (service as any).staticData.getAllResources = jest.fn(() => []);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const text = await service.useAllItems(42, '箱');
      console.log('[使用全部-小数+错误]', text);

      // 优秀武器补给箱只使用整数部分 1（原版 L2246 取整），文本不出现小数
      expect(text).toContain('测试玩家使用了1个优秀武器补给箱');
      expect(text).not.toContain('1.03');
      // 余量 0.0353 保留在背包
      const backpack = parseJson(player.backpack, []);
      expect(backpack.find((it: any) => it.name === '优秀武器补给箱')?.quantity).toBeCloseTo(0.0353, 4);
      // 挑战资源箱已消耗
      expect(backpack.find((it: any) => it.name === '挑战资源箱')).toBeUndefined();
      // 倒序处理：挑战资源箱(末尾)先成功 → 主线补给箱 #错误 → 优秀武器补给箱(队首)最后成功
      // 优化后不再互相覆盖，三箱各一行完整保留
      const splited = text.split('\n');
      expect(splited[0]).toContain('测试玩家使用了2个挑战资源箱');
      expect(splited[1]).toBe('#错误：主线补给箱在物品列表不存在(必须先在物品列表里面定义才可以被使用)');
      expect(splited[2]).toMatch(/^测试玩家使用了1个优秀武器补给箱,得到了/);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('使用巧克力加好感不丢增量（Issue #10）：distributeLoot 内 addAchievement 写入的 markers 增量不被旧快照回写覆盖', async () => {
    const player = buildPlayer({
      type: '花园猫',
      markers: { '花园猫好感': 6 },
      backpack: JSON.stringify([{ name: '巧克力', type: '资源', quantity: 20, count: 20 }]),
    });
    const { service, playerService } = buildHarness(
      player,
      { '巧克力': { name: '巧克力', useEffects: JSON.stringify(['好感1']), useMarkers: '[]' } },
    );
    // 模拟真实 distributeLoot 的「好感」分支：addAchievement 增量改写 player.markers 并立即 savePlayer
    (service as any).itemSystem = {
      distributeLoot: async (_playerData: any, drops: any[]) => {
        for (const drop of drops) {
          if (drop.name === '好感') {
            const qty = Number(drop.quantity) || 0;
            for (const key of ['花园猫好感', '好感']) {
              const next = (Number(player.markers[key]) || 0) + qty;
              if (next > 0) player.markers[key] = next;
              else delete player.markers[key];
            }
          }
        }
        await playerService.savePlayer(player);
        return '好感';
      },
    };

    const text = await service.useItem(42, '巧克力', 20);

    expect(text).toContain('测试玩家使用了20个巧克力');
    // 好感增量存活：6 + 20×1 = 26（修复前被 1120 行旧快照回写覆盖回 6）
    expect(player.markers['花园猫好感']).toBe(26);
    expect(player.markers['好感']).toBe(20);
    // 使用计数照常累加（旧快照上新增的键不受合并影响）
    expect(player.markers['使用巧克力']).toBe(20);
    // 巧克力已消耗
    expect(parseJson(player.backpack, []).find((it: any) => it.name === '巧克力')).toBeUndefined();
  });
});
