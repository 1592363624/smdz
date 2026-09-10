/**
 * 使魔契约引导页接口 端到端集成测试（真实远程 MySQL）
 *
 * 覆盖 Web 全屏引导页的两个入口（GameController → FamiliarSystemService）：
 *   - 只读 GET /game/familiar/gate  → getFirstFamiliarGateDetail
 *   - 写入 POST /game/familiar/choose → chooseFirstFamiliar（内部即「选择使魔确认<名称>」）
 *
 * 核心断言是「单源」：引导页可选集合必须与文本门禁同一过滤（!noSummon）、同一原始序，
 * 且写入路径必须等价于指令侧 selectFamiliar 的首次选择分支（而不是另写一份落库逻辑）。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';
import { GameService } from '../src/modules/game/game.service';
import { PlayerService } from '../src/modules/game/player.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { parseJson } from './parse-json.util';

jest.setTimeout(120000);

describe('使魔契约引导页 API（真实远程库端到端）', () => {
  let app: any;
  let prisma: PrismaService;
  let familiarSystem: FamiliarSystemService;
  let gameService: GameService;
  let playerService: PlayerService;
  let staticData: StaticDataService;

  const createdUserIds: number[] = [];
  const stamp = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    familiarSystem = app.get(FamiliarSystemService);
    gameService = app.get(GameService);
    playerService = app.get(PlayerService);
    staticData = app.get(StaticDataService);
  });

  afterAll(async () => {
    for (const uid of createdUserIds) {
      try { await prisma.user.delete({ where: { id: uid } }); } catch { /* 已删 */ }
    }
    if (app) await app.close();
  });

  async function newEmptyPlayer(tag: string) {
    const username = `e2e_gate_${tag}_${stamp()}`;
    const user = await prisma.user.create({ data: { username, password: 'e2e_test', role: 'USER' } });
    createdUserIds.push(user.id);
    await prisma.player.create({
      data: {
        userId: user.id, mapId: 1, name: `契约测试${tag}`,
        hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        level: 1, dodge: 10,
        markers: '{}', markers2: '[]', buffs: '[]',
        backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
      },
    });
    return user.id;
  }

  it('未开局玩家：needsSelection=true，可选集合与文本门禁同源同序', async () => {
    const uid = await newEmptyPlayer('gate');
    const gate = await familiarSystem.getFirstFamiliarGateDetail(uid);

    expect(gate.needsSelection).toBe(true);
    expect(gate.currentType).toBe('');

    // 单源校验：与静态定义 !noSummon 过滤结果逐项一致（含顺序）
    const expected = staticData.getAllFamiliars().filter((f: any) => !f.noSummon);
    expect(gate.familiars.map((f) => f.name)).toEqual(expected.map((f: any) => f.name));

    // 与文本门禁的编号顺序一致：文本菜单首行为第 1 位使魔名
    const gateText = await gameService.getFirstFamiliarGate(uid);
    expect(gateText).toContain(` 1、${expected[0].name}`);
  });

  it('契约写入：等价于「选择使魔确认<名称>」，角色/序号/好感全部落库', async () => {
    const uid = await newEmptyPlayer('choose');
    const result = await familiarSystem.chooseFirstFamiliar(uid, '花园猫');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('选择为花园猫开始游戏');

    const p = await playerService.getPlayerData(uid);
    expect(p.player.type).toBe('花园猫');
    expect(p.player.baseName).toBe('花园猫');
    expect(p.player.specialSeq).toBe(1);
    const markers = parseJson(p.player.markers, {});
    expect(Number(markers['花园猫好感'])).toBe(1);
    expect(p.player.affinity).toBe(1);
  });

  it('兰音走同一分支：初始好感=20（复用 selectFamiliar 首次选择，不另写逻辑）', async () => {
    const uid = await newEmptyPlayer('lanyin');
    const result = await familiarSystem.chooseFirstFamiliar(uid, '兰音');
    expect(result.ok).toBe(true);
    const p = await playerService.getPlayerData(uid);
    expect(p.player.type).toBe('兰音');
    expect(p.player.specialSeq).toBe(23);
    expect(p.player.affinity).toBe(20);
  });

  it('契约成立后：needsSelection 变为 false，且重复选择的请求被拒绝（不覆盖既有角色）', async () => {
    const uid = await newEmptyPlayer('repeat');
    await familiarSystem.chooseFirstFamiliar(uid, '剑圣');

    const gate = await familiarSystem.getFirstFamiliarGateDetail(uid);
    expect(gate.needsSelection).toBe(false);
    expect(gate.currentType).toBe('剑圣');

    const again = await familiarSystem.chooseFirstFamiliar(uid, '恶毒');
    expect(again.ok).toBe(false);
    expect(again.message).toContain('更换使魔');

    const p = await playerService.getPlayerData(uid);
    expect(p.player.type).toBe('剑圣');
  });

  it('参数校验：空名称与不存在的使魔均被拒绝，不写入任何角色', async () => {
    const uid = await newEmptyPlayer('invalid');
    const empty = await familiarSystem.chooseFirstFamiliar(uid, '   ');
    expect(empty.ok).toBe(false);

    const notExist = await familiarSystem.chooseFirstFamiliar(uid, '不存在的使魔甲');
    expect(notExist.ok).toBe(false);
    expect(notExist.message).toContain('不存在的使魔');

    const p = await playerService.getPlayerData(uid);
    expect(p.player.type).toBeFalsy();
  });

  it('卡片 DTO 字段完备：21 位使魔均有定位/专精/难度/特性（前端渲染不出现空档）', async () => {
    const uid = await newEmptyPlayer('dto');
    const gate = await familiarSystem.getFirstFamiliarGateDetail(uid);
    expect(gate.familiars.length).toBe(21);
    for (const f of gate.familiars) {
      expect(f.name).toBeTruthy();
      expect(f.trait).toBeTruthy();
      expect(f.difficulty).toBeTruthy();
      expect(f.roleTags.length).toBeGreaterThan(0);
      expect(f.difficultyLevel).toBeGreaterThanOrEqual(1);
      expect(f.difficultyLevel).toBeLessThanOrEqual(5);
    }
  });
});
