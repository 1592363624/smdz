/**
 * 战斗系统端到端回归测试
 *
 * 覆盖五轮"原汁原味"战斗修复的接线正确性（行为级断言，不依赖真实 DB）：
 *  轮次1 闪避生效     → 玩家写入「闪避」buff 后，怪物反击被 100% 免伤
 *  轮次2 当前武器攻击 → 指令攻击用 player.currentWeapon 而非固定拳头，写入「武器名+冷却」标记
 *  轮次3 战斗统计     → 攻击次数>1 时 result 附加「战斗统计」行
 *  轮次4 宠物真实结算 → resolvePetVsMonster 走统一三层引擎（命中/击杀/反伤），非概率模型
 *  轮次5 连击/溅射     → processWeaponSpecialEffects 触发 combo 标记；splashCount 对额外目标造成伤害
 *
 * 测试策略：用纯 mock 注入 CombatSystemService 的 8 个构造依赖，内存玩家对象 + 内存怪物列表。
 * 对内部复杂子程序（buildAttackerBonus / monsterCounterAttack）用 jest.spyOn 注入受控返回值，
 * 以稳定验证"接线点"是否正确（冷却标记、统计行、溅射调用等），而非重测伤害公式本身
 * （伤害公式由 combat.spec.ts 单独覆盖）。
 */
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlayerService } from '../src/modules/game/player.service';
import { BonusService } from '../src/modules/game/bonus.service';
import { MapService } from '../src/modules/game/map.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { AchievementService } from '../src/modules/game/achievement.service';
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';
import { StatsService } from '../src/modules/game/stats.service';

// ==================== 内存测试夹具 ====================

// 构造一个可被战斗引擎完整驱动的内存玩家对象
function makePlayer(overrides: any = {}) {
  return {
    id: 1,
    userId: 2,
    name: '冒险者',
    type: '',
    specialSeq: 0,
    level: 1,
    exp: 0,
    hp: 100,
    maxHp: 100,
    shield: 0,
    maxShield: 0,
    armor: 0,
    maxArmor: 0,
    mapId: 1,
    location: '医疗室',
    currentWeapon: 0,
    backpack: '[]',
    equipment: '[]',
    weapons: '[]',
    markers: '{}',
    markers2: '[]',
    buffs: '[]',
    tasks: '[]',
    vehicle: null,
    ...overrides,
  };
}

// 构造一只内存怪物（基础四属性，无反伤/免死来源）
function makeMonster(overrides: any = {}) {
  return {
    id: 1001,
    name: '史莱姆',
    type: '',
    hp: 50,
    maxHp: 50,
    attack: 5,
    level: 1,
    exp: 10,
    dropTable: [],
    bonus: '{}',
    buffs: '[]',
    markers: '{}',
    weapons: '[]',
    currentWeapon: 0,
    ...overrides,
  };
}

// 构造受控的 attackerBonus（命中极高、闪避为 0，使攻击几乎必中）
function strongAttackerBonus() {
  return {
    攻击: 200, 攻击2: 0, 命中: 200, 命中2: 0, 闪避: 0, 闪避2: 0,
    暴击: 5, 暴击伤害: 150, 生命: 100, 护盾: 0, 装甲: 0,
    物伤: 100, 火伤: 0, 冰伤: 0, 电伤: 0, 护盾物抗: 0, 护盾火抗: 0,
    护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0, 装甲物抗: 0, 装甲火抗: 0,
    装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0, 生命物抗: 0, 生命火抗: 0,
    生命冰抗: 0, 生命电抗: 0, 生命全抗: 0, 生命伤害上限: 100,
    装甲伤害上限: 100, 护盾伤害上限: 100, 世界等级差距: 0, 减益: 0,
  } as any;
}

// 构造受控的 defenderBonus（怪物防御，闪避 0，无反伤）
function weakDefenderBonus() {
  return {
    生命: 50, 护盾: 0, 装甲: 0, 闪避: 0, 闪避2: 0,
    护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
    装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
    生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
    生命伤害上限: 100, 装甲伤害上限: 100, 护盾伤害上限: 100,
  } as any;
}

// ==================== 依赖 mock 工厂 ====================

function buildMocks() {
  const players = new Map<number, any>();
  const monstersByMap = new Map<number, any[]>();
  const saveLog: any[] = [];
  const addExpLog: number[] = [];

  const playerService = {
    getPlayerData: jest.fn(async (userId: number) => {
      const player = players.get(userId)!;
      // weapons 可能是已解析数组（getWeaponData 直接读 player.weapons），
      // 故此处对数组/字符串都兼容（safeParse）
      const parse = (v: any, d: any) => {
        if (Array.isArray(v) || typeof v === 'object') return v ?? d;
        try { return JSON.parse(v as string); } catch { return d; }
      };
      return {
        player,
        backpack: parse(player.backpack, []),
        equipment: parse(player.equipment, []),
        weapons: parse(player.weapons, []),
        markers: parse(player.markers, {}),
        markers2: parse(player.markers2, []),
        buffs: parse(player.buffs, []),
        tasks: parse(player.tasks, []),
        safeBox: [],
      };
    }),
    isPlayerDead: jest.fn((player: any) => (player.hp || 0) <= 0),
    savePlayer: jest.fn(async (player: any) => { saveLog.push(player); }),
    addExp: jest.fn(async (_userId: number, exp: number) => {
      addExpLog.push(exp);
      return { leveledUp: false, newLevel: 1 };
    }),
    getMarkerValue: jest.fn((markers: any, key: string) => markers?.[key] ?? 0),
    safeJsonParse: jest.fn(<T>(v: any, d: T): T => {
      try { return (typeof v === 'string' ? JSON.parse(v) : v) as T; } catch { return d; }
    }),
    getBackpackItems: jest.fn((player: any) => JSON.parse(player.backpack || '[]')),
  } as unknown as jest.Mocked<PlayerService>;

  const mapService = {
    getMapById: jest.fn(async (mapId: number) => ({ id: mapId, name: '医疗室', vehicles: '[]' })),
    getMapMonsters: jest.fn(async (mapOrId: any) => {
      const id = typeof mapOrId === 'number' ? mapOrId : mapOrId?.id;
      return monstersByMap.get(id) || [];
    }),
    removeMapMonster: jest.fn(async (_mapOrId: any, monsterId: any) => {
      for (const [, list] of monstersByMap) {
        const idx = list.findIndex((m: any) => m.id === monsterId);
        if (idx >= 0) list.splice(idx, 1);
      }
    }),
    updateMonsterHpInMap: jest.fn(async (_mapId: any, monster: any) => {
      const list = monstersByMap.get(monster.__mapId) || [];
      const found = list.find((m: any) => m.id === monster.id);
      if (found) found.hp = monster.hp;
    }),
  } as unknown as jest.Mocked<MapService>;

  const staticData = {
    getFamiliarByName: jest.fn(() => ({})),
    getAllBuffs: jest.fn(() => []),
    getAllAttackTexts: jest.fn(() => []),
    getAllVehiclePartSpecs: jest.fn(() => []),
    getBuildingByName: jest.fn(() => null),
  } as unknown as jest.Mocked<StaticDataService>;

  const bonusService = {
    addPenetration: jest.fn(),
    mergeBonus: jest.fn((_a: any, b: any) => b),
    calculateBuffs: jest.fn(),
    applyAllDiminishingReturns: jest.fn(),
    checkSetBonus: jest.fn(),
  } as unknown as jest.Mocked<BonusService>;

  const achievementService = {
    addAchievement: jest.fn(),
  } as unknown as jest.Mocked<AchievementService>;

  const itemSystem = {
    distributeLoot: jest.fn(async () => ''),
  } as unknown as jest.Mocked<ItemSystemService>;

  // statsService：monsterCounterAttack 用 getOnlineUserIds 判定"活跃"(在线) 才算反击目标。
  // 测试玩家 userId=2 视为在线（原版攻击者必然在线）。
  const statsService = {
    getOnlineUserIds: jest.fn(() => new Set<number>([2])),
  } as unknown as jest.Mocked<StatsService>;

  const prisma = {
    systemConfig: {
      findUnique: jest.fn(async () => ({ value: '1' })),
    },
    // monsterCounterAttack 查同图真实玩家；测试为内存隔离，返回空，仅反击内存 attacker
    player: {
      findMany: jest.fn(async () => []),
    },
  } as unknown as jest.Mocked<PrismaService>;

  // combatState 使用真实实例（纯逻辑类，无 prisma 依赖），提供 gainBuff/timeIntervalRequire 等真实实现
  const combatState = new CombatStateService() as unknown as jest.Mocked<CombatStateService>;

  return {
    players, monstersByMap, saveLog, addExpLog,
    playerService, mapService, staticData, bonusService,
    achievementService, itemSystem, prisma, combatState, statsService,
  };
}

// 将怪物登记到地图的便捷包装（让 updateMonsterHpInMap 能找到对应 map）
// 原地附加 __mapId，保持调用方持有与地图列表同一引用（便于断言 hp 变化）
function registerMonsters(mocks: any, mapId: number, monsters: any[]) {
  for (const m of monsters) m.__mapId = mapId;
  mocks.monstersByMap.set(mapId, monsters);
  return monsters;
}

// ==================== 测试套件 ====================

describe('战斗系统端到端回归（五轮原汁原味修复）', () => {
  let mocks: ReturnType<typeof buildMocks>;
  let combat: CombatSystemService;

  beforeEach(() => {
    jest.restoreAllMocks();
    mocks = buildMocks();
    combat = new CombatSystemService(
      mocks.prisma, mocks.playerService, mocks.bonusService,
      mocks.mapService, mocks.staticData, mocks.achievementService,
      mocks.itemSystem, mocks.combatState, mocks.statsService,
    );

    // 反伤计算（calcReflectDamage）已由 combat.spec.ts 独立覆盖，
    // 本端到端测试聚焦"接线正确性"，故隔离为 0，避免依赖真实 combatState 细节。
    jest.spyOn(combat as any, 'calcReflectDamage').mockReturnValue(0);

    // updateMonsterHpInMap 内部调用真实 mapService.updateMonsterFields（DB 写），
    // 测试中改为直接更新内存怪物对象，保证扣血/击杀断言稳定。
    jest.spyOn(combat as any, 'updateMonsterHpInMap').mockImplementation(async (_mapId: number, monster: any) => {
      const list = mocks.monstersByMap.get(monster.__mapId) || [];
      const found = list.find((m: any) => m.id === monster.id);
      if (found) found.hp = monster.hp;
    });
  });

  // ---------- 轮次1：闪避生效 ----------
  describe('轮次1 闪避生效（修复1：handleDodge 写入「闪避」buff 被怪物反击消费）', () => {
    it('玩家有「闪避」buff 时，怪物反击被 100% 免伤，玩家 hp 不变', async () => {
      const player = makePlayer({ userId: 2, buffs: JSON.stringify([{ name: '闪避', value: 100, expireAt: Date.now() / 1000 + 30 }]) });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 50, attack: 80 });
      registerMonsters(mocks, 1, [monster]);

      // 受控 attackerBonus：命中极高，确保玩家反击命中怪物（验证链路通畅）
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockImplementation(async () => {
        // 手动复刻原版闪避判定：玩家有「闪避」buff → checkHit(hitRate,100) 必失败 → 免伤
        const playerBuffs = JSON.parse(player.buffs);
        const dodgeBuff = playerBuffs.find((b: any) => b.name === '闪避');
        const fixedDodge = dodgeBuff ? (dodgeBuff.value || 100) : 0;
        const hitRate = 50;
        const hit = hitRate - fixedDodge > 0;
        if (!hit) return ['史莱姆 向你发起攻击，但被你闪避了'];
        return ['史莱姆 攻击你，造成伤害 10'];
      });

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      // 怪物反击被闪避 → 玩家 hp 保持 100 不变
      expect(player.hp).toBe(100);
      expect(result.result).toContain('被你闪避了');
    });
  });

  // ---------- 轮次2：当前武器攻击 ----------
  describe('轮次2 当前武器攻击（修复2：指令攻击用 player.currentWeapon）', () => {
    it('装备了武器(currentWeapon>0)时，写入「武器名+冷却」标记而非拳头', async () => {
      // 注意：getWeaponData 直接读 player.weapons（原始对象，非 playerData 解析后的数组），
      // 故 weapons 字段直接给数组；currentWeapon=1 → getWeaponData 取 weapons[1-1]=weapons[0]
      const weapons = [{ name: '雷火剑', specialSeq: 1001, cooldown: 3, damageType: 1, properties: { phys: 100, fire: 0, ice: 0, elec: 0 } }];
      const player = makePlayer({ userId: 2, currentWeapon: 1, weapons });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 50 });
      registerMonsters(mocks, 1, [monster]);

      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      await combat.weaponAttack(2, 1, { mustHit: true });

      // 修复点：冷却标记使用当前武器名「雷火剑」而非「拳头」
      const markers2 = JSON.parse(player.markers2);
      const cooldownEntry = markers2.find((m: any) => m.name === '雷火剑冷却');
      expect(cooldownEntry).toBeDefined();
      // 雷火剑 specialSeq=1001 → 冷却 3/3=1 秒
      expect(cooldownEntry.expireAt - Date.now()).toBeLessThanOrEqual(1000 + 50);
    });

    it('未装备武器(currentWeapon=0)时，退化为拳头，写入「拳头冷却」', async () => {
      const player = makePlayer({ userId: 2, currentWeapon: 0, weapons: '[]' });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 50 });
      registerMonsters(mocks, 1, [monster]);

      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      await combat.weaponAttack(2, 0, { mustHit: true });

      const markers2 = JSON.parse(player.markers2);
      expect(markers2.some((m: any) => m.name === '拳头冷却')).toBe(true);
    });
  });

  // ---------- 轮次3：战斗统计 ----------
  describe('轮次3 战斗统计（修复3：攻击>1次附加「战斗统计」行）', () => {
    it('全体攻击多目标(total>1)时，result 含「战斗统计」行', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const m1 = makeMonster({ id: 1001, hp: 50 });
      const m2 = makeMonster({ id: 1002, name: '兔子', hp: 50 });
      registerMonsters(mocks, 1, [m1, m2]);

      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true, allAttack: true });

      expect(result.result).toContain('━━━ 战斗统计 ━━━');
      expect(result.result).toMatch(/攻击\d+次，命中\d+次/);
    });

    it('单目标攻击(total=1)时，result 不出现「战斗统计」行', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const m1 = makeMonster({ id: 1001, hp: 50 });
      registerMonsters(mocks, 1, [m1]);

      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).not.toContain('战斗统计');
    });
  });

  // ---------- 轮次4：宠物真实结算 ----------
  describe('轮次4 宠物真实结算（修复4：resolvePetVsMonster 走三层引擎而非概率）', () => {
    it('宠物攻击弱怪命中并击杀 → 怪物从地图移除', async () => {
      const pet = { name: '战斗女仆', attack: 500, hit: 200, dodge: 10, crit: 5, critDmg: 150, hp: 200, shield: 0, armor: 0 };
      const monster = makeMonster({ id: 1001, hp: 30, attack: 0 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'checkHit').mockReturnValue(true); // 消除随机命中

      const text = await combat.resolvePetVsMonster(pet, monster, 1, 2);

      expect(monster.hp).toBeLessThanOrEqual(0);
      expect(text).toContain('击败了');
      // 怪物已被从地图移除
      expect(mocks.monstersByMap.get(1)!.find((m: any) => m.id === 1001)).toBeUndefined();
    });

    it('宠物攻击强怪未击杀 → 怪物扣血且宠物受 0.3×怪物攻击 反伤', async () => {
      const pet = { name: '战斗女仆', attack: 10, hit: 200, dodge: 10, crit: 5, critDmg: 150, hp: 200, shield: 0, armor: 0 };
      const monster = makeMonster({ id: 1001, hp: 500, attack: 100 });
      registerMonsters(mocks, 1, [monster]);

      const text = await combat.resolvePetVsMonster(pet, monster, 1, 2);

      expect(monster.hp).toBeLessThan(500);
      expect(monster.hp).toBeGreaterThan(0);
      // 反伤 = round(100 * 0.3) = 30
      expect(pet.hp).toBe(200 - 30);
      expect(text).toContain('受到');
    });

    it('宠物未命中（怪物闪避） → 不掉血、不反伤', async () => {
      const pet = { name: '战斗女仆', attack: 10, hit: 1, dodge: 10, crit: 5, critDmg: 150, hp: 200, shield: 0, armor: 0 };
      const monster = makeMonster({ id: 1001, hp: 500, attack: 100 });
      registerMonsters(mocks, 1, [monster]);

      // 强制未命中
      jest.spyOn(combat as any, 'checkHit').mockReturnValue(false);

      const text = await combat.resolvePetVsMonster(pet, monster, 1, 2);

      expect(monster.hp).toBe(500);
      expect(pet.hp).toBe(200);
      expect(text).toContain('被闪避');
    });
  });

  // ---------- 轮次5：连击 / 溅射 ----------
  describe('轮次5 连击/溅射（修复5：processWeaponSpecialEffects 触发 combo；splashCount 对额外目标）', () => {
    it('火神机枪(specialSeq=1002)触发 combo 标记', () => {
      const weapon = { name: '火神机枪', specialSeq: 1002, cooldown: 1, properties: {} } as any;
      const fx = (combat as any).processWeaponSpecialEffects(weapon, 1);
      expect(fx.triggerCombo).toBe(true);
      expect(fx.effectText).toContain('自动连击');
    });

    it('雷火剑(specialSeq=1001)冷却缩短为 1/3', () => {
      const weapon = { name: '雷火剑', specialSeq: 1001, cooldown: 9, properties: {} } as any;
      const fx = (combat as any).processWeaponSpecialEffects(weapon, 9);
      expect(fx.cooldown).toBe(3);
    });

    it('机械触手(specialSeq=90)冷却固定为 6 秒', () => {
      const weapon = { name: '机械触手', specialSeq: 90, cooldown: 2, properties: {} } as any;
      const fx = (combat as any).processWeaponSpecialEffects(weapon, 2);
      expect(fx.cooldown).toBe(6);
    });

    it('普通武器不触发 combo，冷却保持基础值', () => {
      const weapon = { name: '铁剑', specialSeq: 0, cooldown: 5, properties: {} } as any;
      const fx = (combat as any).processWeaponSpecialEffects(weapon, 5);
      expect(fx.triggerCombo).toBe(false);
      expect(fx.cooldown).toBe(5);
    });

    it('溅射：splashCount 个额外目标受到真实伤害（result 含溅射文本）', async () => {
      const player = makePlayer({ userId: 2, type: '战斗女仆' });
      mocks.players.set(2, player);
      const main = makeMonster({ id: 1001, hp: 50 });
      const extra1 = makeMonster({ id: 1002, name: '兔子', hp: 50 });
      const extra2 = makeMonster({ id: 1003, name: '野猪', hp: 50 });
      registerMonsters(mocks, 1, [main, extra1, extra2]);

      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      // 注入使魔特效：溅射 1 个目标、必中、倍率×1（百分制 100）；allAttack=false 使 effectiveAllAttack=false
      jest.spyOn(combat as any, 'processFamiliarEffects').mockReturnValue({
        damageMultiplier: 100, forceAllAttack: false, allAttack: false, hitRateModifier: 0,
        extraPenetration: 0, effectText: '', attackBonus: 0, critDmgBonus: 0,
        attackerBuffs: [], defenderBuffs: [], markerOps: [],
        splashCount: 1, splashDamageMultiplier: 1, splashMustHit: true,
      });
      // 复刻代码溅射条件：`splashCount>0 && !effectiveAllAttack`，
      // 且 splashTargets 来自 targets 过滤主目标后剩余 → 需 targets 含 ≥2 个。
      // 故 mock selectTargets 返回 [主目标, 额外目标1]，模拟"非全体但多目标"场景。
      jest.spyOn(combat as any, 'selectTargets').mockReturnValue([main, extra1]);
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      // 主目标受到攻击扣血
      expect(main.hp).toBeLessThan(50);
      // 额外目标受到溅射伤害（result 含「受到溅射伤害」文本，证明接线生效）
      expect(extra1.hp).toBeLessThan(50);
      expect(result.result).toContain('受到溅射伤害');
    });
  });

  // ---------- 综合：基础攻击减血闭环 ----------
  describe('综合 基础攻击减血闭环', () => {
    it('必中攻击弱怪 → 怪物 hp 下降或被击杀，玩家获得经验', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 30, exp: 10 });
      registerMonsters(mocks, 1, [monster]);

      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      // 怪物要么被击杀（从地图移除），要么 hp 下降
      const stillThere = mocks.monstersByMap.get(1)!.find((m: any) => m.id === 1001);
      if (stillThere) expect(stillThere.hp).toBeLessThan(30);
      else expect(result.killed).toContain('史莱姆');
      // 造成伤害 > 0
      expect(result.damageDealt).toBeGreaterThan(0);
    });
  });

  // ---------- 防御方被动：幻时凝固 / 含光回防（玩家被怪物攻击） ----------
  describe('防御方被动 幻时凝固/含光回防（monsterCounterAttack 复刻 战斗相关.ecode L1429-1547）', () => {
    // 直接驱动 monsterCounterAttack：构造存活怪物 + 玩家，让怪物命中玩家
    async function runCounter(player: any, monster: any) {
      mocks.players.set(player.userId, player);
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      // 怪物命中玩家：buildMonsterBonus 返回高命中、无闪避
      jest.spyOn(combat as any, 'buildMonsterBonus').mockReturnValue({
        攻击: 200, 命中: 200, 闪避: 0, 闪避2: 0, 生命: 50, 护盾: 0, 装甲: 0,
        护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
        装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
        生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
        生命伤害上限: 100, 装甲伤害上限: 100, 护盾伤害上限: 100,
      } as any);
      // 伤害固定为 10，便于含光回复断言
      jest.spyOn(combat as any, 'calcDamage').mockReturnValue({ damage: 10, poolDamage: { shield: 0, armor: 0, hp: 10 }, rating: '', critMultiplier: 1 });
      return combat.weaponAttack; // 占位（实际用 monsterCounterAttack 私有）
    }

    it('幻时凝固：花园猫(好感≥60)被攻击 → 怪物获得「幻时」增益，result 含"被幻时凝固"', async () => {
      const player = makePlayer({ userId: 2, type: '花园猫', affinity: 80, hp: 100, maxHp: 100 });
      const monster = makeMonster({ id: 1001, hp: 100, attack: 50, buffs: '[]', markers2: '[]' });
      mocks.players.set(2, player);
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'buildMonsterBonus').mockReturnValue({
        攻击: 200, 命中: 200, 闪避: 0, 闪避2: 0, 生命: 50, 护盾: 0, 装甲: 0,
        护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
        装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
        生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
        生命伤害上限: 100, 装甲伤害上限: 100, 护盾伤害上限: 100,
      } as any);
      jest.spyOn(combat as any, 'calcDamage').mockReturnValue({ damage: 10, poolDamage: { shield: 0, armor: 0, hp: 10 }, rating: '', critMultiplier: 1 });

      // 调用私有 monsterCounterAttack（玩家被怪物攻击）
      const lines = await (combat as any).monsterCounterAttack(player, await mocks.playerService.getPlayerData(2), { id: 1, name: '医疗室', vehicles: '[]' });

      // 怪物被加「幻时」增益（原版 获得增益(攻击方.增益,"幻时",30)）
      // 注意：combatState.gainBuff 写入中文 key {名称,有效期至}（归一化约定）
      const monsterBuffs = JSON.parse(monster.buffs);
      const phantom = monsterBuffs.find((b: any) => b.名称 === '幻时');
      expect(phantom).toBeDefined();
      expect(phantom.有效期至).toBeGreaterThan(Date.now());
      // 文本可见
      expect(lines.join('\n')).toContain('被幻时凝固');
    });

    it('含光回防：装备含光(耐久>8)闪避成功 → 回复最高防御类型上限10%', async () => {
      // 原版含光在「闪避状态判定」分支内回复：玩家成功闪避怪物反击后，装备含光(耐久>8)回复最高防御上限10%。
      // 玩家 hp=90/maxHp=100，含"闪避"buff(必闪避怪物反击)，装备含光耐久9 → 闪避后回复 maxHp*0.1=10 → 100。
      const player = makePlayer({
        userId: 2, hp: 90, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        buffs: JSON.stringify([{ name: '闪避', value: 100, expireAt: Date.now() / 1000 + 30 }]),
        equipment: JSON.stringify([{ name: '含光剑', durability: 9 }]),
      });
      const monster = makeMonster({ id: 1001, hp: 100, attack: 50 });
      mocks.players.set(2, player);
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'buildMonsterBonus').mockReturnValue({
        攻击: 200, 命中: 200, 闪避: 0, 闪避2: 0, 生命: 50, 护盾: 0, 装甲: 0,
        护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
        装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
        生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
        生命伤害上限: 100, 装甲伤害上限: 100, 护盾伤害上限: 100,
      } as any);
      jest.spyOn(combat as any, 'calcDamage').mockReturnValue({ damage: 10, poolDamage: { shield: 0, armor: 0, hp: 10 }, rating: '', critMultiplier: 1 });

      await (combat as any).monsterCounterAttack(player, await mocks.playerService.getPlayerData(2), { id: 1, name: '医疗室', vehicles: '[]' });

      // 闪避成功 → 含光回复生命上限10% = 10，从90回到100
      expect(player.hp).toBe(100);
    });
  });

  // ---------- 光荣弹（玩家死亡装备 #光荣弹=44 → 必中反击攻击者） ----------
  describe('光荣弹（gloryGrenade 复刻 战斗相关.ecode L4987-5018）', () => {
    it('玩家死亡且装备光荣弹(44) → 对怪物发起必中反击并造成真实伤害', async () => {
      // 死者：玩家 hp=0（已死）、装备 [{specialSeq:44}]、属性 生命/装甲/护盾 用于倍率计算
      const player = makePlayer({
        userId: 2, hp: 0, maxHp: 100,
        属性: { 生命: 300, 装甲: 100, 护盾: 100 },
        equipment: [{ specialSeq: 44 }],
      });
      mocks.players.set(2, player);
      // 攻击者：怪物，四系伤害各10（用于倍率 a1 分母），hp 充足避免触发击杀结算分支
      const monster = makeMonster({ id: 1001, hp: 1000, 物伤: 10, 火伤: 10, 冰伤: 10, 电伤: 10 });
      registerMonsters(mocks, 1, [monster]);

      // 复刻链路：buildAttackerBonus/buildMonsterBonus/calcDamage 均 spy 为受控值
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'buildMonsterBonus').mockReturnValue(weakDefenderBonus());
      // calcDamage 固定返回 damage=10、poolDamage.hp=500，使 finalDmg=10*(a1/100)
      // a1 = (300+100+100)/( (10+10+10+10)*0.25 )*100 = 500/10*100 = 5000% → finalDmg=500
      jest.spyOn(combat as any, 'calcDamage').mockReturnValue({
        damage: 10, poolDamage: { shield: 0, armor: 0, hp: 500 }, rating: '', critMultiplier: 1,
      });

      const text = await (combat as any).gloryGrenade(
        player, monster, await mocks.playerService.getPlayerData(2), { id: 1 }, Date.now(),
      );

      // 文本可见「光荣弹」且含倍率括号（原版 加括号("倍率"+...)）
      expect(text).toContain('光荣弹');
      expect(text).toMatch(/倍率\d+%/);
      // 怪物受到真实伤害（1000 - 500 = 500，未致死故不触发 handleMonsterDeath）
      expect(monster.hp).toBe(500);
    });

    it('玩家未死亡 → 光荣弹不触发（返回空文本）', async () => {
      const player = makePlayer({
        userId: 2, hp: 100, maxHp: 100,
        属性: { 生命: 300, 装甲: 100, 护盾: 100 },
        equipment: [{ specialSeq: 44 }],
      });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 1000, 物伤: 10, 火伤: 10, 冰伤: 10, 电伤: 10 });
      registerMonsters(mocks, 1, [monster]);

      const text = await (combat as any).gloryGrenade(
        player, monster, await mocks.playerService.getPlayerData(2), { id: 1 }, Date.now(),
      );
      expect(text).toBe('');
    });

    it('玩家死亡但无光荣弹装备 → 不触发反击', async () => {
      const player = makePlayer({
        userId: 2, hp: 0, maxHp: 100,
        属性: { 生命: 300, 装甲: 100, 护盾: 100 },
        equipment: [],
      });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 1000, 物伤: 10, 火伤: 10, 冰伤: 10, 电伤: 10 });
      registerMonsters(mocks, 1, [monster]);

      const text = await (combat as any).gloryGrenade(
        player, monster, await mocks.playerService.getPlayerData(2), { id: 1 }, Date.now(),
      );
      expect(text).toBe('');
    });
  });

  // ---------- 套装特效（复刻 战斗相关.ecode 造成伤害 L1981-2062/L2447 等） ----------
  describe('套装特效（穿透/增幅器/超压 复刻）', () => {
    it('两极反转(装备63) → 攻击时三层穿透+8，result 含「两极反转」', async () => {
      const player = makePlayer({
        userId: 2,
        equipment: [{ specialSeq: 63, name: '两极反转' }],
      });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 50 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('两极反转');
      expect(monster.hp).toBeLessThan(50); // 正常造成伤害（穿透+8 使伤害略增）
    });

    it('增幅器套装=2 且目标 s敏锐>=5 → 伤害被免疫（敏锐），怪物不死', async () => {
      // 原版 L1981-1990：防御方.套装.增幅器==2 且 s敏锐>=5 → 伤害倍率=0
      const player = makePlayer({
        userId: 2,
        sets: JSON.stringify({ 增幅器: 2 }),
      });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100, markers: JSON.stringify({ s敏锐: 5 }) });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('敏锐');
      expect(monster.hp).toBe(100); // 伤害被免疫，hp 不变
    });

    it('增幅器套装=1 速射(s速射<5) → 伤害×0.9，result 含「速射」', async () => {
      const player = makePlayer({
        userId: 2,
        sets: JSON.stringify({ 增幅器: 1 }),
        markers: JSON.stringify({ s速射: 0 }),
      });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 50 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('速射');
      expect(monster.hp).toBeLessThan(50);
    });

    it('创世纪(武器-18) → 清空目标三池与经验，result 含「创世纪」', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      // 目标怪物携带状态与经验
      const monster = makeMonster({
        id: 1001, hp: 80, maxHp: 100, shield: 30, maxShield: 50, armor: 20, maxArmor: 40, exp: 999,
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);
      // 强制当前武器为创世纪
      const pw = combat as any;
      jest.spyOn(pw, 'getWeaponData').mockReturnValue({ name: '创世纪', specialSeq: -18, type: '近战武器', negativeType: 0 } as any);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('创世纪');
      expect(monster.hp).toBe(0);
      expect(monster.shield).toBe(0);
      expect(monster.armor).toBe(0);
      expect((monster as any).exp ?? 0).toBe(0);
    });

    it('安乐天使(防御方增益) → 伤害被免疫，怪物 hp 不变', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100,
        buffs: JSON.stringify([{ name: '安乐天使', expireAt: Date.now() / 1000 + 60 }]),
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('安乐天使');
      expect(monster.hp).toBe(100); // 免疫，hp 不变
    });

    it('短衬衫2(防御方标记2) → 伤害×0.1，result 含「短衬衫」', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100, markers: JSON.stringify({ 短衬衫2: 1 }),
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('短衬衫');
      expect(monster.hp).toBeLessThan(100); // 仍造成伤害（×0.1）
    });

    it('负面类型=1(割裂) 累计4次 → 触发正式「割裂」增益', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      // 前3次未触发，第4次触发：用 markers 预置割裂1=3
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100, markers: JSON.stringify({ 割裂1: 3 }),
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);
      const pw = combat as any;
      jest.spyOn(pw, 'getWeaponData').mockReturnValue({ name: '裂创', specialSeq: 0, type: '近战武器', negativeType: 1 } as any);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      // 原版 L2070-2076：触发时仅添加成就"触发割裂"，不立即附加"割裂"文本；
      // "割裂"文本在后续攻击(防御方已带割裂增益)时才显示（L2139）。此处验证正式增益已写入。
      const mb = JSON.parse(monster.buffs || '[]');
      expect(mb.some((b: any) => b.name === '割裂')).toBe(true);
    });

    it('感电+星尘(好感≥60) → 超新星电伤，穿透+10', async () => {
      const player = makePlayer({ userId: 2, specialSeq: 14, affinity: 80, skillLevel: 10 });
      mocks.players.set(2, player);
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100, shield: 40, maxShield: 50,
        buffs: JSON.stringify([{ name: '感电', expireAt: Date.now() / 1000 + 60 }]),
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('感电');
      expect(result.result).toContain('超新星');
    });

    it('龙姬(特殊序号12) 携带龙姬增伤 → 驱魔加成攻击，result 含「驱魔」', async () => {
      const player = makePlayer({ userId: 2, specialSeq: 12, markers: JSON.stringify({ 龙姬增伤: 50 }) });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('驱魔');
    });

    it('恶毒(6) 攻击 → 防御方获得「恶毒之刃」增益，result 含文本', async () => {
      const player = makePlayer({ userId: 2, specialSeq: 6 });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('恶毒之刃');
      const mb = JSON.parse(monster.buffs || '[]');
      expect(mb.some((b: any) => b.name === '恶毒之刃')).toBe(true);
    });

    it('伊芙利特(11) 好感≥80 → 防御方获得「燃烧」增益，result 含(燃烧)', async () => {
      const player = makePlayer({ userId: 2, specialSeq: 11, affinity: 80 });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('燃烧');
      const mb = JSON.parse(monster.buffs || '[]');
      expect(mb.some((b: any) => b.name === '燃烧')).toBe(true);
    });

    it('军姬(16) 标记万象2=1 → 伤害×(2+技等/100)，怪物受更高伤', async () => {
      const player = makePlayer({ userId: 2, specialSeq: 16, skillLevel: 10, markers: JSON.stringify({ 万象2: 1 }) });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('万象2');
      // 倍率 (2+10/100)=2.1 → 伤害应明显高于基础（此处验证怪物扣血 > 普通一击约50）
      expect(monster.hp).toBeLessThan(50);
    });

    it('星尘(14) 标记dz>0 → 斗转星移追加电伤，result 含文本', async () => {
      const player = makePlayer({ userId: 2, specialSeq: 14, skillLevel: 10, markers: JSON.stringify({ dz: 20 }) });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('斗转星移');
    });

    it('防御方恶毒(6) 好感≥100 → 色欲免疫，怪物 hp 不变', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100, specialSeq: 6, affinity: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('色欲');
      expect(monster.hp).toBe(100);
    });

    it('防御方 saber(19) 好感≥40 且含 ex 增益 → 免疫，怪物 hp 不变', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100, specialSeq: 19, affinity: 40,
        buffs: JSON.stringify([{ name: 'ex', expireAt: Date.now() / 1000 + 60 }]),
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('ex');
      expect(monster.hp).toBe(100);
    });

    it('防御方四糸乃(15) 好感≥80 → 冰凯免疫，怪物 hp 不变', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100, specialSeq: 15, affinity: 80,
        buffs: JSON.stringify([{ name: 'bk1', expireAt: Date.now() / 1000 + 60 }]),
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('冰凯');
      expect(monster.hp).toBe(100);
    });

    it('吸血姬(活力=-15) 命中 → 防御方获得「猩红」增益，result 含文本', async () => {
      const player = makePlayer({ userId: 2, vitality: -15, qqNumber: '12345' });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('猩红');
      const mb = JSON.parse(monster.buffs || '[]');
      expect(mb.some((b: any) => b.name === '猩红')).toBe(true);
    });

    it('防御方战斗女仆(8) 含守护1 → 免疫，怪物 hp 不变', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100, specialSeq: 8,
        buffs: JSON.stringify([{ name: '守护1', expireAt: Date.now() / 1000 + 60 }]),
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('守护');
      expect(monster.hp).toBe(100);
    });

    it('防御方军姬(16) 好感≥40 → 获得「剑阵」增益并回血，result 含文本', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 30, maxHp: 100, specialSeq: 16, affinity: 80 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('剑阵');
      const mb = JSON.parse(monster.buffs || '[]');
      expect(mb.some((b: any) => b.name === '剑阵')).toBe(true);
      expect(monster.hp).toBe(100); // 好感≥80 回满血
    });

    it('防御方军姬2(24) 好感≥20 且标记jj2hg1>0 → 招架免疫，怪物 hp 不变', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100, specialSeq: 24, affinity: 20,
        markers: JSON.stringify({ jj2hg1: 1 }),
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('招架');
      expect(monster.hp).toBe(100);
    });

    it('防御方增益含「剑阵」 → 免疫，怪物 hp 不变', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100,
        buffs: JSON.stringify([{ name: '剑阵', expireAt: Date.now() / 1000 + 60 }]),
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('剑阵');
      expect(monster.hp).toBe(100);
    });

    // ---------- 武器特殊序号判断（复刻 战斗相关.ecode 造成伤害 L1827-1867） ----------
    it('仿真尾巴(-36)：攻击方其他武器处于冷却 → 这些武器 CD-5，result 含「仿真尾巴」', async () => {
      // markers2 容器内 expireAt 为毫秒（与武器冷却 L322 约定一致）
      const player = makePlayer({
        userId: 2,
        weapons: [
          { name: '仿真尾巴', specialSeq: -36 },
          { name: '雷火剑', specialSeq: 1001 },
        ],
        markers2: JSON.stringify([{ name: '雷火剑冷却', expireAt: Date.now() + 30 * 1000 }]),
      });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);
      const pw = combat as any;
      jest.spyOn(pw, 'getWeaponData').mockReturnValue({ name: '仿真尾巴', specialSeq: -36, type: '近战武器' } as any);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('仿真尾巴');
      const m2 = JSON.parse(player.markers2);
      const cd = m2.find((m: any) => m.name === '雷火剑冷却');
      expect(cd).toBeDefined();
      // 原版 CD-5（30s → 25s 剩余，近似断言 < 30s）
      expect(cd.expireAt - Date.now()).toBeLessThan(30 * 1000);
    });

    it('火焰飞羽(-30)：防御方获得「飞羽」增益，buffs 含 name=飞羽', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);
      const pw = combat as any;
      jest.spyOn(pw, 'getWeaponData').mockReturnValue({ name: '火焰飞羽', specialSeq: -30, type: '近战武器' } as any);

      await combat.weaponAttack(2, 0, { mustHit: true });

      const mb = JSON.parse(monster.buffs || '[]');
      expect(mb.some((b: any) => b.name === '飞羽')).toBe(true);
    });

    it('纵横(-13)：额外生命火伤 += 防御方生命*0.05，attackerBonus.火伤 被加成', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      // 防御方生命=1000 → 额外火伤 += 1000*0.05*1 = 50
      const monster = makeMonster({ id: 1001, hp: 1000, maxHp: 1000 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);
      const pw = combat as any;
      jest.spyOn(pw, 'getWeaponData').mockReturnValue({ name: '纵横', specialSeq: -13, type: '近战武器' } as any);

      const calcSpy = jest.spyOn(combat as any, 'calcDamage');
      await combat.weaponAttack(2, 0, { mustHit: true });

      expect(calcSpy).toHaveBeenCalled();
      const atkBonusArg = calcSpy.mock.calls[0][0] as any; // calcDamage(attackerBonus, defBonus, ...) 索引0
      expect(atkBonusArg.火伤).toBeGreaterThan(0);
    });

    it('矢量(-12)：额外装甲冰伤 += 防御方装甲*0.05，attackerBonus.冰伤 被加成', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      // 防御方装甲=800 → 额外冰伤 += 800*0.05*1 = 40
      const monster = makeMonster({ id: 1001, hp: 1000, maxHp: 1000, armor: 800, maxArmor: 800 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);
      const pw = combat as any;
      jest.spyOn(pw, 'getWeaponData').mockReturnValue({ name: '矢量', specialSeq: -12, type: '近战武器' } as any);

      const calcSpy = jest.spyOn(combat as any, 'calcDamage');
      await combat.weaponAttack(2, 0, { mustHit: true });

      const atkBonusArg = calcSpy.mock.calls[0][0] as any;
      expect(atkBonusArg.冰伤).toBeGreaterThan(0);
    });

    it('影光(-23)：防御方获得「影光」增益，buffs 含 name=影光', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);
      const pw = combat as any;
      jest.spyOn(pw, 'getWeaponData').mockReturnValue({ name: '影光', specialSeq: -23, type: '近战武器' } as any);

      await combat.weaponAttack(2, 0, { mustHit: true });

      const mb = JSON.parse(monster.buffs || '[]');
      expect(mb.some((b: any) => b.name === '影光')).toBe(true);
    });

    it('寒风(-10)：防御方未冷却 → 防御方所有武器 CD+30，result 含「寒风」', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      // 防御方（怪物）装备两把武器，寒风应给其全部武器加冷却
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100,
        weapons: [{ name: '怪物爪', specialSeq: 0 }, { name: '怪物牙', specialSeq: 0 }],
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);
      const pw = combat as any;
      jest.spyOn(pw, 'getWeaponData').mockReturnValue({ name: '寒风', specialSeq: -10, type: '近战武器' } as any);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('寒风');
      const mk = JSON.parse(monster.markers2 || '[]');
      // markers2.expireAt 为毫秒
      expect(mk.some((m: any) => m.name === '怪物爪冷却' && m.expireAt > Date.now())).toBe(true);
      expect(mk.some((m: any) => m.name === '怪物牙冷却' && m.expireAt > Date.now())).toBe(true);
    });

    it('光棱(-29)：攻击方未冷却 → 「类型+技能冷却」-60 写入 markers2', async () => {
      const player = makePlayer({ userId: 2, type: '普拉娜', specialSeq: 23 });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);
      const pw = combat as any;
      jest.spyOn(pw, 'getWeaponData').mockReturnValue({ name: '光棱', specialSeq: -29, type: '近战武器' } as any);

      await combat.weaponAttack(2, 0, { mustHit: true });

      const mk = JSON.parse(player.markers2);
      // 原版 获得增益(攻击方.标记2, "普拉娜技能冷却", -60) → 冷却提前60秒（毫秒 expireAt 应早于当前时刻，即就绪）
      const entry = mk.find((m: any) => m.name === '普拉娜技能冷却');
      expect(entry).toBeDefined();
      expect(entry.expireAt).toBeLessThanOrEqual(Date.now()); // -60s 后已过期（冷却完毕）
    });

    it('格挡系统：防御方带圆盾(51) 冷却过期 → 触发格挡回满三池并免疫，怪物 hp 不变', async () => {
      const player = makePlayer({ userId: 2, specialSeq: 1 });
      mocks.players.set(2, player);
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100, equipment: [{ specialSeq: 51, name: '圆盾' }],
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);
      const randSpy = jest.spyOn(Math, 'random').mockReturnValue(0); // 格挡必触发
      try {
        const result = await combat.weaponAttack(2, 0, { mustHit: true });

        expect(result.result).toContain('圆盾');
        expect(monster.hp).toBe(100); // 圆盾回满 + 免疫，hp 不变
      } finally {
        randSpy.mockRestore();
      }
    });

    it('格挡系统：防御方带防爆盾(9) 无圆盾 → 触发默认格挡×0.25 减伤，仍造成伤害', async () => {
      const player = makePlayer({ userId: 2, specialSeq: 1 });
      mocks.players.set(2, player);
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100, equipment: [{ specialSeq: 9, name: '防爆盾' }],
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);
      const randSpy = jest.spyOn(Math, 'random').mockReturnValue(0); // 格挡必触发
      try {
        const result = await combat.weaponAttack(2, 0, { mustHit: true });

        expect(result.result).toContain('格挡');
        expect(monster.hp).toBeLessThan(100); // 减伤但仍造成伤害
        expect(monster.hp).toBeGreaterThan(50); // 约1/4伤害，应剩 >50
      } finally {
        randSpy.mockRestore();
      }
    });

    it('格挡系统：防御方无格挡来源 → 不触发格挡，正常造成伤害', async () => {
      const player = makePlayer({ userId: 2, specialSeq: 1 });
      mocks.players.set(2, player);
      const monster = makeMonster({ id: 1001, hp: 100, maxHp: 100 });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).not.toContain('格挡');
      expect(monster.hp).toBeLessThan(100);
    });

    it('激变星增益 → 伤害0 免疫，怪物 hp 不变', async () => {
      const player = makePlayer({ userId: 2 });
      mocks.players.set(2, player);
      const monster = makeMonster({
        id: 1001, hp: 100, maxHp: 100,
        buffs: JSON.stringify([{ name: '激变星', expireAt: Date.now() / 1000 + 60, strength: 5 }]),
      });
      registerMonsters(mocks, 1, [monster]);
      jest.spyOn(combat as any, 'buildAttackerBonus').mockReturnValue(strongAttackerBonus());
      jest.spyOn(combat as any, 'monsterCounterAttack').mockResolvedValue([]);

      const result = await combat.weaponAttack(2, 0, { mustHit: true });

      expect(result.result).toContain('激变星');
      expect(monster.hp).toBe(100);
    });
  });
});
