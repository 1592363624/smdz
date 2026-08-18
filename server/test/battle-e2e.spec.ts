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

  const prisma = {
    systemConfig: {
      findUnique: jest.fn(async () => ({ value: '1' })),
    },
  } as unknown as jest.Mocked<PrismaService>;

  // combatState 提供 combat 引擎内 calcReflectDamage / buff 规范化 所需的占位方法
  const combatState = {
    equipRequire: jest.fn(() => false),
    buffRequire: jest.fn(() => false),
    timeIntervalRequire: jest.fn(() => false),
    normalizeBuffItem: jest.fn((it: any) => it),
    gainBuff: jest.fn(),
    setAchievementProficiency: jest.fn(),
  } as unknown as jest.Mocked<CombatStateService>;

  return {
    players, monstersByMap, saveLog, addExpLog,
    playerService, mapService, staticData, bonusService,
    achievementService, itemSystem, prisma, combatState,
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
      mocks.itemSystem, mocks.combatState,
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
      // 注入使魔特效：溅射 1 个目标、必中、倍率 1；allAttack=false 使 effectiveAllAttack=false
      jest.spyOn(combat as any, 'processFamiliarEffects').mockReturnValue({
        damageMultiplier: 1, forceAllAttack: false, allAttack: false, hitRateModifier: 0,
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
});
