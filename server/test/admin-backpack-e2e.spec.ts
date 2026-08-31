/**
 * GM 后台「背包管理」真实数据库集成测试
 *
 * 目标：在「真起 App + 真库」下验证运营后台编辑背包的完整闭环：
 *  1. gmGetBackpack 能解析出玩家背包的全部物品；
 *  2. gmSaveBackpack（编辑数量 / 增删 / 同名合并 / 数量0删除）落库后，
 *     玩家侧 getBackpackItems 能读到与 GM 提交一致的数据 —— 即 GM 改动真实生效且兼容游戏读取。
 *  3. 未创建角色的用户抛 NotFound。
 *
 * 测试创建独立 User + Player，afterAll 级联删除，不污染真实玩家数据。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AdminService } from '../src/modules/admin/admin.service';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(120000);

describe('AdminService 背包管理（真实库端到端）', () => {
  let app: any;
  let admin: AdminService;
  let prisma: PrismaService;
  let playerService: PlayerService;
  let TEST_USER_ID = 0;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    admin = app.get(AdminService);
    prisma = app.get(PrismaService);
    playerService = app.get(PlayerService);

    // 独立测试账号：player.userId 是 User 外键，级联删除不污染真实玩家
    const u = await prisma.user.create({
      data: { username: `gm_bp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, password: 'x' },
    });
    TEST_USER_ID = u.id;
    await playerService.getOrCreatePlayer(TEST_USER_ID);
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => undefined);
    await app.close();
  });

  it('GM 保存背包→玩家读回闭环（编辑/增删/合并/删除）', async () => {
    // 清空初始背包，构造可控起点
    await admin.gmSaveBackpack(TEST_USER_ID, []);

    // 1) 新增 + 同名合并 + 数量0删除
    await admin.gmSaveBackpack(TEST_USER_ID, [
      { name: '水晶', quantity: 5 },
      { name: '水晶', quantity: 5 }, // 合并 → 10
      { name: '木头', count: 3 },
      { name: '面包', quantity: 0 }, // 删除
      { name: '石制工具', quantity: 1, type: '装备', durability: 0, data: 'e' },
    ]);

    // 2) 通过 GM 读回，应包含 3 种物品
    const items = await admin.gmGetBackpack(TEST_USER_ID);
    expect(items).toHaveLength(3);
    expect(items).toContainEqual(expect.objectContaining({ name: '水晶', count: 10 }));
    expect(items).toContainEqual(expect.objectContaining({ name: '木头', count: 3 }));
    expect(items).toContainEqual(
      expect.objectContaining({ name: '石制工具', count: 1, type: '装备', durability: 0, data: 'e' }),
    );

    // 3) 玩家侧读取（业务读路径）与 GM 提交一致 → GM 改动真实生效
    const player = await prisma.player.findUnique({ where: { userId: TEST_USER_ID } });
    const readBack = playerService.getBackpackItems(player as any);
    expect(readBack).toHaveLength(3);
    expect(readBack).toContainEqual(expect.objectContaining({ name: '水晶', count: 10 }));
    // 无 quantity 歧义字段（统一为 count）
    expect(readBack.some((i: any) => i.quantity !== undefined)).toBe(false);

    // 4) 编辑数量：把水晶改为 1，则背包只剩 3 种（数量保留）
    await admin.gmSaveBackpack(TEST_USER_ID, [
      { name: '水晶', quantity: 1 },
      { name: '木头', count: 3 },
      { name: '石制工具', quantity: 1, type: '装备', durability: 0, data: 'e' },
    ]);
    const after = await admin.gmGetBackpack(TEST_USER_ID);
    const crystal = after.find((i: any) => i.name === '水晶');
    expect(crystal.count).toBe(1);
  });

  it('对未创建角色的用户 gmGetBackpack / gmSaveBackpack 抛 NotFound', async () => {
    const u = await prisma.user.create({
      data: { username: `gm_bp_np_${Date.now()}`, password: 'x' }, // 不建 Player
    });
    try {
      await expect(admin.gmGetBackpack(u.id)).rejects.toThrow();
      await expect(admin.gmSaveBackpack(u.id, [{ name: '水晶', quantity: 1 }])).rejects.toThrow();
    } finally {
      await prisma.user.delete({ where: { id: u.id } }).catch(() => undefined);
    }
  });
});