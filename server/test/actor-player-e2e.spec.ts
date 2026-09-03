/**
 * 玩家 Actor 运行时 —— 真实远程 MySQL 端到端集成测试
 *
 * 目标：在「真起 App + 真库」下验证 hardening 后的关键不变量：
 *  1. 经 enqueueUserWrite（= actor.runtime.run）改背包，落库后 DB 背包 JSON 含改动
 *     —— 验证「只落 player 子对象会丢背包」(风险 #2) 已修复：新路径持久化整份 PlayerData。
 *  2. 串行不变量：50 个并发 enqueueUserWrite 各自 push 一个物品，最终背包恰好 +50
 *     （无 interleaving、无快照覆盖）。
 *  3. all-or-nothing：fn 中途抛错，DB 背包不变（风险 #3）。
 *  4. 只读 getPlayerData 返回克隆，外部改它不污染 DB（风险 #1，真库侧佐证）。
 *
 * 测试创建独立的 User + Player（player.userId 是 User 外键），afterAll 级联删除，
 * 完全不污染真实玩家数据。
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { parseJson } from './parse-json.util';

jest.setTimeout(180000);

const MARK = '__actor_e2e__';
let TEST_USER_ID = 0;

describe('玩家 Actor 运行时（真实远程库端到端）', () => {
  let app: any;
  let prisma: PrismaService;
  let playerService: PlayerService;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    playerService = app.get(PlayerService);
    // 建一个独立测试账号（player.userId 是 User 外键），级联删除时不污染真实玩家
    const u = await prisma.user.create({
      data: { username: `actor_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, password: 'x' },
    });
    TEST_USER_ID = u.id;
    await playerService.getOrCreatePlayer(TEST_USER_ID);
  });

  afterAll(async () => {
    // 删 User 级联删 Player（onDelete: Cascade），忽略不存在
    await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => undefined);
    await app.close();
  });

  it('经 Actor 改背包会落库到 player 表（风险#2 修复）', async () => {
    const before = (await prisma.player.findUnique({ where: { userId: TEST_USER_ID } })) as any;
    expect(before).toBeTruthy();
    const beforeBp = parseJson(before.backpack, []);

    await playerService.enqueueUserWrite(TEST_USER_ID, async () => {
      const d = await playerService.getPlayerData(TEST_USER_ID);
      d.backpack.push({ name: MARK, type: '消耗品', quantity: 1, durability: 0, data: '' });
      await playerService.savePlayer(d.player);
    });

    const after = (await prisma.player.findUnique({ where: { userId: TEST_USER_ID } })) as any;
    const afterBp = parseJson(after.backpack, []);
    const hit = afterBp.find((i: any) => i?.name === MARK);
    expect(hit).toBeTruthy();
    expect(afterBp.length).toBe(beforeBp.length + 1);
  });

  it('50 个并发 enqueueUserWrite 各自 push，背包恰好 +50（串行不变量）', async () => {
    const before = (await prisma.player.findUnique({ where: { userId: TEST_USER_ID } })) as any;
    const startLen = parseJson(before.backpack, []).length;

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        playerService.enqueueUserWrite(TEST_USER_ID, async () => {
          const d = await playerService.getPlayerData(TEST_USER_ID);
          d.backpack.push({ name: `${MARK}_${i}`, type: '消耗品', quantity: 1, durability: 0, data: '' });
          await playerService.savePlayer(d.player);
        }),
      ),
    );

    const after = (await prisma.player.findUnique({ where: { userId: TEST_USER_ID } })) as any;
    const afterBp = parseJson(after.backpack, []);
    const added = afterBp.filter((i: any) => typeof i?.name === 'string' && i.name.startsWith(MARK + '_'));
    expect(added.length).toBe(50);
    expect(afterBp.length).toBe(startLen + 50);
  });

  it('fn 中途抛错不落库（all-or-nothing，风险#3）', async () => {
    const before = (await prisma.player.findUnique({ where: { userId: TEST_USER_ID } })) as any;
    const beforeLen = parseJson(before.backpack, []).length;

    await expect(
      playerService.enqueueUserWrite(TEST_USER_ID, async () => {
        const d = await playerService.getPlayerData(TEST_USER_ID);
        d.backpack.push({ name: `${MARK}_err`, type: '消耗品', quantity: 1, durability: 0, data: '' });
        await playerService.savePlayer(d.player);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = (await prisma.player.findUnique({ where: { userId: TEST_USER_ID } })) as any;
    const afterBp = parseJson(after.backpack, []);
    expect(afterBp.find((i: any) => i?.name === `${MARK}_err`)).toBeFalsy();
    expect(afterBp.length).toBe(beforeLen);
  });

  it('只读 getPlayerData 返回克隆，外部改它不污染 DB（风险#1 真库佐证）', async () => {
    const d1 = await playerService.getPlayerData(TEST_USER_ID);
    const d2 = await playerService.getPlayerData(TEST_USER_ID);
    expect(d1).not.toBe(d2); // 只读快照是克隆（引用不同）
    const len1 = d1.backpack.length;
    d1.backpack.push({ name: `${MARK}_clone`, type: '消耗品', quantity: 1, durability: 0, data: '' });
    expect(d2.backpack.length).toBe(len1); // d2 不受 d1 篡改影响
    // 且不触发落库：直接读库，背包长度 == len1
    const dbNow = (await prisma.player.findUnique({ where: { userId: TEST_USER_ID } })) as any;
    expect(parseJson(dbNow.backpack, []).length).toBe(len1);
  });
});
