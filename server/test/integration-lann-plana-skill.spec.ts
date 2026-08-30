/**
 * 兰音 / 普拉娜 使魔技能 端到端实战测试（真实远程 MySQL）
 *
 * 对应原版：
 *   使魔技能.ecode
 *     - 形神合一 L1545（地图怪物麻醉 + 风月入墨地图增益）
 *     - 风月入墨 L1635（好感>=20，地图增益「风月月入墨」value=-expReduce，expReduce=15+技能等级*0.25）
 *     - 心无所扰 L1693（好感>=40，player.buffs 写「心无所扰·蓄势」{mustHitNext,mustHitChance}；模式2同步友方召唤物）
 *     - 梦倾天下 L1753（好感>=60，地图怪物麻醉）
 *     - 反转童话 L1804（好感>=80，player.buffs 写「反转童话·蓄势」{reverseResist}）
 *     - 月落寸光 L1857（好感>=100，player.buffs 写「月落寸光·蓄势」{nextPenetration,skillLevelForPen}；模式2同步友方召唤物）
 *     - 火力全开 L897（普拉娜专属，player.buffs 写「火力全开」{攻击:+60%*好感效果}）
 *
 * 测试策略：
 *   - 真实 Nest ApplicationContext 连真实 smdz 库。
 *   - 动态建兰音使魔玩家（type=兰音, specialSeq=23, affinity=100, markers 含「兰音好感」=100, 设「套装_兰音模式」=2）；
 *     在同图 GameMap.summons 放一个归属=玩家QQ的友方召唤物。
 *   - 逐一调用技能并断言：地图增益写入(map.mapBuffs)、player.buffs 含 nextAttack 蓄势、友方召唤物 buffs 同步。
 *   - 验证普拉娜火力全开攻击加成落地（buffs 含「火力全开」攻击属性）。
 *   - afterAll 清理账号与召唤物。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { FamiliarSkillsService } from '../src/modules/game/familiar-skills.service';
import { PlayerService } from '../src/modules/game/player.service';
import { MapService } from '../src/modules/game/map.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(180000);

describe('兰音/普拉娜 使魔技能 端到端实战（真实远程库）', () => {
  let app: any;
  let prisma: PrismaService;
  let familiarSkills: FamiliarSkillsService;
  let playerService: PlayerService;
  let mapService: MapService;

  const createdUserIds: number[] = [];
  const testMapId = 1;
  const stamp = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    familiarSkills = app.get(FamiliarSkillsService);
    playerService = app.get(PlayerService);
    mapService = app.get(MapService);
  });

  afterAll(async () => {
    for (const uid of createdUserIds) {
      try { await prisma.user.delete({ where: { id: uid } }); } catch { /* 已删 */ }
    }
    // 清理测试召唤物
    try {
      const map = await prisma.gameMap.findUnique({ where: { id: testMapId } });
      if (map) {
        // 召唤物 owner 是纯数字 userId，不带 e2e_lann_ 前缀；按写入时的 id 前缀识别测试数据
        const summons = JSON.parse(map.summons || '[]').filter(
          (s: any) => !String(s.id || '').startsWith('e2e_lann_'),
        );
        await prisma.gameMap.update({ where: { id: testMapId }, data: { summons: JSON.stringify(summons) } });
      }
    } catch { /* ignore */ }
    if (app) await app.close();
  });

  // 构造兰音使魔玩家：好感100 + 模式2 + 友方召唤物
  // 注意：getAllySummons 用 player.qq || String(userId) 作 ownerId 匹配，
  // 而 Prisma Player 无 qq 字段（真实QQ存于 User.qqNumber），故友方召唤物归属统一用 String(userId)。
  async function makeLannPlayer(tag: string) {
    const username = `e2e_lann_${tag}_${stamp()}`;
    const user = await prisma.user.create({ data: { username, password: 'e2e_test', role: 'USER' } });
    createdUserIds.push(user.id);
    const markers: any = {
      '兰音好感': 100,
      '套装_兰音模式': 2,
      '兰音技能熟练度': 81, // 平方阈值下 skillLevel=10
    };
    await prisma.player.create({
      data: {
        userId: user.id,
        mapId: testMapId,
        name: `兰音测试${tag}`,
        type: '兰音',
        specialSeq: 23,
        affinity: 100,
        hp: 10000, maxHp: 10000, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        level: 50, dodge: 10,
        markers: JSON.stringify(markers), markers2: '[]', buffs: '[]',
        backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
      },
    });
    return user;
  }

  // 在同图放入一个归属=玩家(=userId字符串)的友方召唤物
  async function addAllySummon(userId: number, name: string) {
    const map = await prisma.gameMap.findUnique({ where: { id: testMapId } });
    const summons = JSON.parse(map?.summons || '[]');
    const ownerId = String(userId);
    const baseHp = 500;
    summons.push({
      id: `e2e_lann_${name}_${Date.now()}`,
      name,
      type: name,
      owner: ownerId,
      归属: ownerId,
      基础: { 生命: baseHp },
      base: { hp: baseHp },
      hp: baseHp, maxHp: baseHp,
      attack: 50, defense: 10, speed: 100, dodge: 5, hit: 85,
      buffs: '[]', bonus: '{}',
    });
    await prisma.gameMap.update({ where: { id: testMapId }, data: { summons: JSON.stringify(summons) } });
    return name;
  }

  function findBuff(json: string, name: string) {
    try { return JSON.parse(json || '[]').find((b: any) => b.name === name); } catch { return undefined; }
  }
  function findMapBuff(json: string, name: string) {
    try { return JSON.parse(json || '[]').find((b: any) => b.name === name); } catch { return undefined; }
  }
  function findSummonBuff(json: string, name: string) {
    try {
      const b = JSON.parse(json || '[]').find((x: any) => x.name === name);
      return b;
    } catch { return undefined; }
  }

  async function refreshMap() {
    return prisma.gameMap.findUnique({ where: { id: testMapId } });
  }

  it('测试1 风月入墨：地图增益写入 + 好感门槛(20)通过', async () => {
    const user = await makeLannPlayer('moon');
    const w = await familiarSkills.executeSkill(user.id, '风月入墨');
    expect(w).toContain('风月入墨');
    const map = await refreshMap();
    if (!map) throw new Error('测试地图不存在');
    // 原版 expReduce=15+技能等级*0.25（skillLevel=10 → 17.5%）
    const mb = findMapBuff(map.mapBuffs, '风月入墨');
    expect(mb).toBeDefined();
    expect(mb.value).toBeCloseTo(-17.5, 1);
  });

  it('测试2 心无所扰：player.buffs 含「心无所扰·蓄势」+ 模式2同步友方召唤物', async () => {
    const user = await makeLannPlayer('calm');
    const p = await playerService.getPlayerData(user.id);
    const allyName = await addAllySummon(user.id, '兰音护卫');
    const w = await familiarSkills.executeSkill(user.id, '心无所扰');
    expect(w).toContain('心无所扰');
    expect(w).toContain(allyName); // 同步文本

    const p2 = await playerService.getPlayerData(user.id);
    const pb = findBuff(p2.player.buffs, '心无所扰·蓄势');
    expect(pb).toBeDefined();
    expect(pb.mustHitNext).toBe(true);

    // 验证友方召唤物 buffs 同步获得 mustHitNext
    const map = await refreshMap();
    if (!map) throw new Error('测试地图不存在');
    const summons = JSON.parse(map.summons || '[]');
    const ally = summons.find((s: any) => s.name === allyName);
    const sb = findSummonBuff(ally.buffs, '下次攻击·标记');
    expect(sb).toBeDefined();
    expect(sb.mustHitNext).toBe(true);
  });

  it('测试3 月落寸光：player.buffs 含「月落寸光·蓄势」+ 模式2同步友方召唤物', async () => {
    const user = await makeLannPlayer('moonlight');
    const p = await playerService.getPlayerData(user.id);
    const allyName = await addAllySummon(user.id, '兰音弓手');
    const w = await familiarSkills.executeSkill(user.id, '月落寸光');
    expect(w).toContain('月落寸光');
    expect(w).toContain(allyName);

    const p2 = await playerService.getPlayerData(user.id);
    const pb = findBuff(p2.player.buffs, '月落寸光·蓄势');
    expect(pb).toBeDefined();
    expect(pb.nextPenetration).toBe(true);
    expect(pb.skillLevelForPen).toBe(10);

    const map = await refreshMap();
    if (!map) throw new Error('测试地图不存在');
    const summons = JSON.parse(map.summons || '[]');
    const ally = summons.find((s: any) => s.name === allyName);
    const sb = findSummonBuff(ally.buffs, '下次攻击·标记');
    expect(sb).toBeDefined();
    expect(sb.nextPenetration).toBe(true);
  });

  it('测试4 形神合一：地图怪物麻醉 + 风月入墨地图增益 + 模式2友方同步', async () => {
    const user = await makeLannPlayer('union');
    const p = await playerService.getPlayerData(user.id);
    const allyName = await addAllySummon(user.id, '兰音卫');
    const w = await familiarSkills.executeSkill(user.id, '形神合一');
    expect(w).toContain('形神合一');
    expect(w).toContain(allyName);

    const map = await refreshMap();
    if (!map) throw new Error('测试地图不存在');
    const mb = findMapBuff(map.mapBuffs, '风月入墨');
    expect(mb).toBeDefined();

    const p2 = await playerService.getPlayerData(user.id);
    const markers = JSON.parse(p2.player.markers || '{}');
    expect(markers['兰音技能熟练度']).toBeGreaterThanOrEqual(91);
  });

  it('测试5 梦倾天下/反转童话：好感门槛(60/80)通过并写入蓄势标记', async () => {
    const u1 = await makeLannPlayer('dream');
    const w1 = await familiarSkills.executeSkill(u1.id, '梦倾天下');
    expect(w1).toContain('梦倾天下');

    const u2 = await makeLannPlayer('reverse');
    const w2 = await familiarSkills.executeSkill(u2.id, '反转童话');
    expect(w2).toContain('反转童话');
    const p2 = await playerService.getPlayerData(u2.id);
    const rb = findBuff(p2.player.buffs, '反转童话·蓄势');
    expect(rb).toBeDefined();
    expect(rb.reverseResist).toBe(true);
  });

  it('测试6 好感门槛拦截：好感<40 无法用心无所扰', async () => {
    const username = `e2e_lann_low_${stamp()}`;
    const user = await prisma.user.create({ data: { username, password: 'e2e_test', role: 'USER' } });
    createdUserIds.push(user.id);
    await prisma.player.create({
      data: {
        userId: user.id, mapId: testMapId, name: '兰音低好感',
        type: '兰音', specialSeq: 23, affinity: 10,
        hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        level: 1, dodge: 10,
        markers: JSON.stringify({ '兰音好感': 10, '兰音技能熟练度': 0 }),
        markers2: '[]', buffs: '[]',
        backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
      },
    });
    const w = await familiarSkills.executeSkill(user.id, '心无所扰');
    expect(w).toContain('需要兰音好感达到40');
  });

  it('测试7 普拉娜火力全开：player.buffs 含「火力全开」攻击加成', async () => {
    const username = `e2e_plana_${stamp()}`;
    const user = await prisma.user.create({ data: { username, password: 'e2e_test', role: 'USER' } });
    createdUserIds.push(user.id);
    const affinity = 100;
    await prisma.player.create({
      data: {
        userId: user.id, mapId: testMapId, name: '普拉娜测试',
        type: '普拉娜', specialSeq: 22, affinity,
        hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        level: 1, dodge: 10,
        markers: JSON.stringify({ '普拉娜好感': affinity, '普拉娜技能熟练度': 0 }),
        markers2: '[]', buffs: '[]',
        backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
      },
    });
    const w = await familiarSkills.executeSkill(user.id, '火力全开');
    expect(w).toContain('火力全开');
    const p = await playerService.getPlayerData(user.id);
    const fb = findBuff(p.player.buffs, '火力全开');
    expect(fb).toBeDefined();
    // 好感100 → effect = getSkillEffect(100)；攻击加成 = floor(60*effect)
    expect(fb['攻击']).toBeGreaterThan(0);
  });

  it('测试8 普拉娜火力全开 类型不匹配拦截（非普拉娜使魔）', async () => {
    const username = `e2e_plana_nope_${stamp()}`;
    const user = await prisma.user.create({ data: { username, password: 'e2e_test', role: 'USER' } });
    createdUserIds.push(user.id);
    await prisma.player.create({
      data: {
        userId: user.id, mapId: testMapId, name: '非普拉娜',
        type: '人类', specialSeq: 0, affinity: 0,
        hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        level: 1, dodge: 10,
        markers: '{}', markers2: '[]', buffs: '[]',
        backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
      },
    });
    const w = await familiarSkills.executeSkill(user.id, '火力全开');
    expect(w).toContain('需要普拉娜');
  });
});
