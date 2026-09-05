import { TaskService } from '../src/modules/game/task.service';
import { PlayerService } from '../src/modules/game/player.service';
import { parseJson } from './parse-json.util';

/**
 * 正式库事故回归：「主线-继续询问」任务在非 mutate 上下文结算（advance 自己读档
 * findUnique 原始行 → saveTaskState → getPlayerData 活态 → savePlayer）时，
 * 旧实现用 Object.assign 把「未物化货币条目的原始背包」整列写回活态，savePlayer
 * 提取货币因「权威快照（货币列存在）但背包条目缺失」把 钻石/召唤券 误清为 0。
 *
 * 修复后：
 *  - saveTaskState 对 backpack 走「保留活态独有条目 + 叠加流程增量」的合并；
 *  - 货币提取仅在对象经 getPlayerData 物化（_currencyMirror 存在）时才允许清零。
 */

function makePrisma(rows: any[]) {
  // 深拷贝：模拟真实 Prisma 每次 findUnique 都重新反序列化出全新对象/数组，
  // 流程读档的背包与活态物化的背包互不共享引用（共享引用会在 mock 里掩盖事故）。
  const cloneRow = (row: any) => JSON.parse(JSON.stringify(row));
  const prisma: any = {
    player: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) =>
          (where?.userId !== undefined && r.userId === where.userId)
          || (where?.id !== undefined && r.id === where.id));
        return row ? cloneRow(row) : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const cv = where?.id_version;
        if (!cv) {
          const rowById = rows.find((r) => r.id === where?.id);
          if (!rowById) {
            const err: any = new Error('not found'); err.code = 'P2025'; throw err;
          }
          Object.assign(rowById, data);
          return rowById;
        }
        const row = rows.find((r) => r.id === cv.id);
        if (!row || row.version !== cv.version) {
          const err: any = new Error('required but was not found.'); err.code = 'P2025'; throw err;
        }
        Object.assign(row, data);
        return { ...row };
      }),
    },
    gameMap: {
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => undefined),
    },
  };
  return prisma;
}

function makePlayerRow(): any {
  return {
    id: 1,
    userId: 42,
    version: 0,
    mapId: 1,
    level: 1,
    exp: 0,
    upgradeExp: 6,
    diamonds: 1055.75,
    tickets: 21.11,
    dataCores: 0,
    // 落库态背包不含物化货币条目（提取进独立列后的形态），股票 优秀武器补给箱 12.64
    backpack: JSON.stringify([
      { name: '优秀武器补给箱', type: '资源', count: 12.64, quantity: 12.64 },
    ]),
    markers: JSON.stringify({}),
    markers2: '[]',
    recipes: '[]',
    tasks: JSON.stringify([
      { name: '主线-继续询问', requirements: [{ name: '对话史莱姆', count: 3 }] },
    ]),
    hp: 52, maxHp: 52, shield: 22, maxShield: 22, armor: 32, maxArmor: 32,
    attack: 10, hit: 10, dodge: 10, speed: 10, crit: 3, critDmg: 150,
    regenHp: 0, regenShield: 0, regenArmor: 0, affinity: 0,
    lastOpTime: 0, readTime: 0, playTime: 0,
  };
}

function makePlayerService(prisma: any): PlayerService {
  const service = new PlayerService(prisma, { getEquipmentByName: () => undefined } as any, {} as any);
  (service as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return service;
}

function makeTaskService(prisma: any): { service: TaskService; rows: any[] } {
  const rows: any[] = [makePlayerRow()];
  const prismaMock = makePrisma(rows);

  const staticData: any = {
    getTaskByName: jest.fn((name: string) =>
      name === '主线-继续询问'
        ? {
            name,
            requirements: [{ name: '对话史莱姆', count: 3 }],
            rewards: [{ name: '主线补给箱', count: 10.61 }],
            nextTasks: '[]',
            restrictMarkers: '[]',
            level: 1,
            publisher: '',
            chance: 100,
          }
        : undefined),
    getAllTasks: jest.fn(() => []),
    getVehicleRecipeByName: jest.fn(() => undefined),
    getAllVehicleRecipes: jest.fn(() => []),
    getEquipmentByName: jest.fn(() => undefined),
  };
  const itemSystem: any = {
    generateRewardEquipment: jest.fn(async () => ({
      name: '装备', type: '装备', quantity: 1, durability: 0, data: 'e!bx0',
    })),
  };

  const service = new TaskService(
    prismaMock,
    makePlayerService(prismaMock),
    staticData,
    itemSystem,
  );
  (service as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return { service, rows };
}

describe('任务结算不误清货币（正式库「主线-继续询问」事故回归）', () => {
  it('非 mutate 上下文先后三次推进对话，完成任务后钻石/召唤券不被清零、奖励落包', async () => {
    const { service, rows } = makeTaskService(null as any);

    await service.advance(42, '对话史莱姆', 1);
    await service.advance(42, '对话史莱姆', 1);
    await service.advance(42, '对话史莱姆', 1);

    const row = rows[0];
    // 货币列保持原值（修复前这里会被误清为 0）
    expect(row.diamonds).toBeCloseTo(1055.75, 5);
    expect(row.tickets).toBeCloseTo(21.11, 5);

    // 落库背包提取货币条目后仍保留 优秀武器补给箱 与本次奖励 主线补给箱
    const bp = parseJson(row.backpack, []);
    const box = bp.find((i: any) => i.name === '优秀武器补给箱');
    expect(box).toBeDefined();
    expect(Number(box.count)).toBeCloseTo(12.64, 5);
    const reward = bp.find((i: any) => i.name === '主线补给箱');
    expect(reward).toBeDefined();
    // getRewardScale：任务熟练度0 → 等级1 → (1+1/100)=1.01 倍奖励
    expect(Number(reward.count)).toBeCloseTo(10.61 * 1.01, 5);
    expect(bp.some((i: any) => i.name === '钻石')).toBe(false);
    expect(bp.some((i: any) => i.name === '召唤券')).toBe(false);

    // 任务已完成并从列表移除
    const tasks = parseJson(row.tasks, []);
    expect(tasks.some((t: any) => t.name === '主线-继续询问')).toBe(false);
  });

  it('原始行（未物化 _currencyMirror）保存时不把缺失货币条目清零', async () => {
    const rows = [makePlayerRow()];
    const prisma = makePrisma(rows);
    const service = makePlayerService(prisma);

    // 模拟旧读档路径：拿到 findUnique 原始行直接改背包后 savePlayer
    const raw = await prisma.player.findUnique({ where: { userId: 42 } });
    const bp = parseJson(raw.backpack, []);
    bp.push({ name: '主线补给箱', type: '资源', count: 10.61, quantity: 10.61 });
    raw.backpack = JSON.stringify(bp);
    await service.savePlayer(raw);

    expect(rows[0].diamonds).toBeCloseTo(1055.75, 5); // 修复前被清 0
    expect(rows[0].tickets).toBeCloseTo(21.11, 5);
  });

  it('经 getPlayerData 物化后「背包条目被删=花光」仍正确落 0', async () => {
    const rows = [makePlayerRow()];
    const prisma = makePrisma(rows);
    const service = makePlayerService(prisma);

    const snap = await service.getPlayerData(42);
    const bp = snap.backpack.filter((i: any) => i.name !== '钻石');
    snap.player.backpack = JSON.stringify(bp);
    await service.savePlayer(snap.player);

    expect(rows[0].diamonds).toBe(0); // 花光语义不变
    expect(rows[0].tickets).toBeCloseTo(21.11, 5);
  });
});