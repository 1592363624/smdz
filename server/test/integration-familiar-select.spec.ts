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

  it('测试1 选择普拉娜：specialSeq=22 写入', async () => {
    const uid = await newEmptyPlayer('plana');
    const w = await familiarSystem.selectFamiliar(uid, '普拉娜');
    expect(w).toContain('普拉娜');
    const p = await getPlayer(uid);
    expect(p.player.specialSeq).toBe(22);
    expect(p.player.type).toBe('普拉娜');
  });

  it('测试2 选择兰音：specialSeq=23 且初始好感=20', async () => {
    const uid = await newEmptyPlayer('lanyin');
    const w = await familiarSystem.selectFamiliar(uid, '兰音');
    expect(w).toContain('兰音');
    const p = await getPlayer(uid);
    expect(p.player.specialSeq).toBe(23);
    expect(p.player.type).toBe('兰音');
    // 原版 #兰音 初始好感=20（selectFamiliar 对齐）
    expect(p.player.affinity).toBe(20);
    const markers = JSON.parse(p.player.markers || '{}');
    expect(markers['兰音好感']).toBe(20);
  });
});
