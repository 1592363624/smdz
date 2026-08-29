/**
 * 使魔选择 端到端集成测试（真实远程 MySQL）
 * 验证补全的普拉娜(22)/兰音(23) 使魔可被选择，specialSeq 正确写入，
 * 兰音初始好感=20（对齐原版 #兰音 常量）。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(120000);

describe('使魔选择 普拉娜/兰音（真实远程库端到端）', () => {
  let app: any;
  let prisma: PrismaService;
  let familiarSystem: FamiliarSystemService;
  let playerService: PlayerService;

  const createdUserIds: number[] = [];
  const stamp = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    familiarSystem = app.get(FamiliarSystemService);
    playerService = app.get(PlayerService);
  });

  afterAll(async () => {
    for (const uid of createdUserIds) {
      try { await prisma.user.delete({ where: { id: uid } }); } catch { /* 已删 */ }
    }
    if (app) await app.close();
  });

  async function newEmptyPlayer(tag: string) {
    const username = `e2e_sel_${tag}_${stamp()}`;
    const user = await prisma.user.create({ data: { username, password: 'e2e_test', role: 'USER' } });
    createdUserIds.push(user.id);
    await prisma.player.create({
      data: {
        userId: user.id, mapId: 1, name: `选择测试${tag}`,
        hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        level: 1, dodge: 10,
        markers: '{}', markers2: '[]', buffs: '[]',
        backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
      },
    });
    return user.id;
  }

  async function getPlayer(uid: number) {
    return playerService.getPlayerData(uid);
  }

  it('测试1 预览普拉娜：不选择，仅展示详情（对应原版 L786-792）', async () => {
    const uid = await newEmptyPlayer('plana_view');
    const w = await familiarSystem.selectFamiliar(uid, '普拉娜');
    // 预览包含 名称(好感0)、技能等级、说明2 与「1、选择 2、返回」菜单，但不改变玩家状态
    expect(w).toContain('普拉娜(好感0)');
    expect(w).toContain('技能等级:1(0/1)');
    expect(w).toContain('1、选择');
    expect(w).toContain('2、返回');
    const p = await getPlayer(uid);
    expect(p.player.type).toBeFalsy();
  });

  it('测试1 选择普拉娜：specialSeq=22 写入', async () => {
    const uid = await newEmptyPlayer('plana');
    const w = await familiarSystem.selectFamiliar(uid, '确认普拉娜');
    expect(w).toContain('选择为普拉娜开始游戏');
    const p = await getPlayer(uid);
    expect(p.player.specialSeq).toBe(22);
    expect(p.player.type).toBe('普拉娜');
  });

  it('测试2 选择兰音：specialSeq=23 且初始好感=20', async () => {
    const uid = await newEmptyPlayer('lanyin');
    const w = await familiarSystem.selectFamiliar(uid, '确认兰音');
    expect(w).toContain('选择为兰音开始游戏');
    const p = await getPlayer(uid);
    expect(p.player.specialSeq).toBe(23);
    expect(p.player.type).toBe('兰音');
    // 原版 #兰音 初始好感=20（selectFamiliar 对齐）
    expect(p.player.affinity).toBe(20);
    const markers = JSON.parse(p.player.markers || '{}');
    expect(markers['兰音好感']).toBe(20);
  });

  it('测试3 开局提示链：教程领取提示 + 选择为X开始游戏 + 1、查看任务', async () => {
    const uid = await newEmptyPlayer('onboard');
    const w = await familiarSystem.selectFamiliar(uid, '确认伊卡洛斯');
    // 教程领取提示（原版 L11686-11706，进阶在上、新手在下）
    expect(w).toContain('领取了进阶教程，可以发送“查看任务”来查看');
    expect(w).toContain('领取了新手教程，可以发送“查看任务”来查看');
    expect(w.indexOf('领取了进阶教程')).toBeLessThan(w.indexOf('领取了新手教程'));
    // 开局正文与「1、查看任务」编号菜单
    expect(w).toContain('选择为伊卡洛斯开始游戏');
    expect(w).toContain(' 1、查看任务');
    const p = await getPlayer(uid);
    expect(p.player.type).toBe('伊卡洛斯');
    const markers = JSON.parse(p.player.markers || '{}');
    // 教程标记置 3（原版 领取新手+进阶后 置成就熟练度("教程",3)）
    expect(Number(markers['教程'] || 0)).toBe(3);
  });

  it('测试4 伊卡洛斯预览：定位/专精/优点/操作难度 齐全（原版 说明2）', async () => {
    const uid = await newEmptyPlayer('ikaros_view');
    const w = await familiarSystem.selectFamiliar(uid, '伊卡洛斯');
    expect(w).toContain('伊卡洛斯(好感0)');
    expect(w).toContain('家用娱乐天使，伊卡洛斯');
    expect(w).toContain('定位:输出');
    expect(w).toContain('专精:冰冻');
    expect(w).toContain('优点:群体伤害、高命中、中断回血、高爆发');
    expect(w).toContain('操作难度:超高');
    expect(w).toContain('1、选择\t\t2、返回');
  });
});
