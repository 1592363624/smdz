/**
 * 打开箱子 1:1 复刻端到端集成测试（真实远程 MySQL）
 *
 * 对应原版：物品操作.ecode L2220-2458 打开箱子
 * 验证：
 *   ① 装备箱产出走品质链路（生成装备带品质数据，非白板）
 *   ② 奶恢复三池 + 经验掉落
 *   ③ 凭证每日一次发放改良建筑箱
 *   ④ 蛋糕授予掉落率+50%增益（buffs 数组）
 *   ⑤ 排行财富命令可出数
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { GameService } from '../src/modules/game/game.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(180000);

describe('打开箱子端到端（真实远程库）', () => {
  let app: any;
  let prisma: PrismaService;
  let game: GameService;
  const createdUserIds: number[] = [];
  const stamp = () => Math.random().toString(36).slice(2, 8);

  async function makePlayer(backpack: any[]) {
    const username = `e2e_openbox_${stamp()}`;
    const user = await prisma.user.create({ data: { username, password: 'e2e_test', role: 'USER' } });
    createdUserIds.push(user.id);
    await prisma.player.create({
      data: {
        userId: user.id,
        mapId: 1,
        name: `开箱测试${stamp()}`,
        type: '花园猫',
        level: 12,
        hp: 100,
        maxHp: 2000,
        shield: 500,
        maxShield: 1500,
        armor: 300,
        maxArmor: 1200,
        backpack: JSON.stringify(backpack),
        markers: '{}',
        markers2: '[]',
        buffs: '[]',
      } as any,
    });
    return user.id;
  }

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    game = app.get(GameService);
  });

  afterAll(async () => {
    for (const uid of createdUserIds) {
      await prisma.player.deleteMany({ where: { userId: uid } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: uid } }).catch(() => undefined);
    }
    await app.close();
  });

  it('装备箱开出带品质数据的独立装备并按原版文本展示', async () => {
    const uid = await makePlayer([{ name: '普通装备补给箱', type: '资源', quantity: 3, count: 3 }]);
    const text = await game.handleUseItem(uid, '普通装备补给箱', 3);
    console.log('[装备箱]', text);
    expect(text).toContain('使用了3的普通装备补给箱');
    const player = await prisma.player.findUnique({ where: { userId: uid } });
    const pack = JSON.parse(player!.backpack || '[]');
    // 箱子消耗完毕
    expect(pack.find((it: any) => it.name === '普通装备补给箱')).toBeUndefined();
    // 三件独立品质装备入包，且数据串以品质字母开头（e/d/c/b/a/s/x），非白板 data:''
    const swords = pack.filter((it: any) => it.type === '装备');
    expect(swords.length).toBeGreaterThanOrEqual(1);
    for (const eq of swords) {
      expect(eq.data).not.toBe('');
      expect(/^[edcbasx]/.test(String(eq.data))).toBe(true);
      expect(eq.name.length).toBeGreaterThan(0);
    }
  });

  it('奶恢复三池并附带经验；死亡状态受120秒复活冷却限制', async () => {
    const uid = await makePlayer([
      { name: '奶', type: '资源', quantity: 5, count: 5 },
    ]);
    // 存活使用：三池各 + maxShield*0.1 = +150
    const t1 = await game.handleUseItem(uid, '奶', 1);
    console.log('[奶·存活]', t1);
    expect(t1).toContain('享用了1的奶，恢复了10%的状态');
    const p1 = await prisma.player.findUnique({ where: { userId: uid } });
    expect(p1!.hp).toBeCloseTo(250);
    expect(p1!.shield).toBeCloseTo(650);

    // 死亡状态复活成功
    await prisma.player.update({ where: { userId: uid }, data: { hp: 0 } });
    const t2 = await game.handleUseItem(uid, '奶', 1);
    expect(t2).toContain('使用了1的奶，恢复了10%的状态');

    // 冷却中：不复活但正常消耗并获得经验
    await prisma.player.update({ where: { userId: uid }, data: { hp: 0 } });
    const expBefore = (await prisma.player.findUnique({ where: { userId: uid } }))!.exp;
    const t3 = await game.handleUseItem(uid, '奶', 1);
    expect(t3).toContain('使用奶复活冷却');
    const p3 = await prisma.player.findUnique({ where: { userId: uid } });
    expect(p3!.hp).toBe(0); // 未复活
    expect(p3!.exp).toBe(expBefore + 10000); // 经验照常发放
  });

  it('凭证每日一次发放等级/2的改良建筑箱，同日再次使用进入冷却', async () => {
    const uid = await makePlayer([{ name: '凭证', type: '资源', quantity: 5, count: 5 }]);
    const t1 = await game.handleUseItem(uid, '凭证', 3);
    console.log('[凭证]', t1);
    expect(t1).toContain('得到了6的改良建筑箱'); // floor(12/2)=6
    const p1 = await prisma.player.findUnique({ where: { userId: uid } });
    const pack1 = JSON.parse(p1!.backpack);
    expect(pack1.find((it: any) => it.name === '凭证')?.quantity).toBe(4); // 消耗固定为1
    expect(pack1.find((it: any) => it.name === '改良建筑箱')?.quantity).toBe(6);
    expect(JSON.parse(p1!.markers)['凭证']).toBe(1);

    const t2 = await game.handleUseItem(uid, '凭证', 1);
    expect(t2).not.toContain('改良建筑箱'); // 不再发放
  });

  it('蛋糕授予掉落率+50%增益写入buffs数组', async () => {
    const uid = await makePlayer([{ name: '蛋糕', type: '资源', quantity: 2, count: 2 }]);
    const text = await game.handleUseItem(uid, '蛋糕', 2);
    console.log('[蛋糕]', text);
    expect(text).toContain('享用了2的蛋糕，掉落率+50%');
    const p = await prisma.player.findUnique({ where: { userId: uid } });
    const buffs = JSON.parse(p!.buffs || '[]');
    const cake = buffs.find((b: any) => (b.名称 ?? b.name) === '蛋糕');
    expect(cake).toBeTruthy();
    const expireMs = cake.有效期至 ?? cake.expireAt * 1000;
    expect(expireMs).toBeGreaterThan(Date.now());
  });

  it('排行财富命令可出数', async () => {
    const text = await game.handleRanking(createdUserIds[0], '财富');
    console.log('[排行财富]', text.split('\n').slice(0, 5).join('\n'));
    expect(text).toContain('游戏总财富排行');
  });
});
