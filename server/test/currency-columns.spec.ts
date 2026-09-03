import { PlayerService } from '../src/modules/game/player.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { parseJson } from './parse-json.util';

/**
 * P1 货币列化回归：钻石/召唤券/数据核心的真相源是 Player 独立列，
 * 读取时物化回背包数组（业务透明），保存时从背包提取回列并移除 JSON 条目。
 */

function makePrisma(rows: any[]) {
  const prisma: any = {
    player: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => r.userId === where?.userId);
        return row ? { ...row } : null;
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
  };
  return prisma;
}

function makeService(prisma: any): PlayerService {
  const service = new PlayerService(
    prisma,
    { getEquipmentByName: () => undefined } as unknown as StaticDataService,
    {} as any,
  );
  (service as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return service;
}

describe('货币列化（P1）透明转换', () => {
  it('读取时把列物化为背包物品', async () => {
    const rows = [{
      id: 1, userId: 42, version: 0, mapId: 1,
      diamonds: 1053.6, tickets: 0.012, dataCores: 7,
      backpack: '[]', markers: '{}',
    }];
    const service = makeService(makePrisma(rows));

    const snap = await service.getPlayerData(42);
    const bp = snap.backpack;
    expect(bp.find((i: any) => i.name === '钻石').quantity).toBeCloseTo(1053.6, 5);
    expect(bp.find((i: any) => i.name === '召唤券').count).toBeCloseTo(0.012, 9);
    expect(bp.find((i: any) => i.name === '数据核心').quantity).toBe(7);
  });

  it('兑换式修改后保存：货币进列、JSON 中无货币条目', async () => {
    const rows = [{
      id: 1, userId: 42, version: 0, mapId: 1,
      diamonds: 100, tickets: 20, dataCores: 0,
      backpack: '[]', markers: '{}',
    }];
    const prisma = makePrisma(rows);
    const service = makeService(prisma);

    // 业务视角：像 exchange 一样改背包里的货币
    const snap = await service.getPlayerData(42);
    const bp = snap.backpack;
    bp.find((i: any) => i.name === '钻石').quantity -= 40;   // 扣 40 钻
    bp.find((i: any) => i.name === '召唤券').count += 2;     // 加 2 券
    snap.player.backpack = JSON.stringify(bp);
    await service.savePlayer(snap.player);

    const row = rows[0];
    expect(row.diamonds).toBeCloseTo(60, 5);
    expect(row.tickets).toBeCloseTo(22, 5);
    const stored = parseJson(row.backpack, []);
    expect(stored.find((i: any) => i.name === '钻石')).toBeUndefined();
    expect(stored.find((i: any) => i.name === '召唤券')).toBeUndefined();
  });

  it('背包中无货币条目（如全部花光）正确落为 0，且不误清未加载的列', async () => {
    const rows = [{
      id: 1, userId: 42, version: 0, mapId: 1,
      diamonds: 50, tickets: 3, dataCores: 9,
      backpack: '[]', markers: '{}',
    }];
    const service = makeService(makePrisma(rows));

    const snap = await service.getPlayerData(42);
    // 花光钻石：背包物化后有条目（数量>0 时创建）；直接把它删掉模拟花光
    const bp = snap.backpack.filter((i: any) => i.name !== '钻石');
    snap.player.backpack = JSON.stringify(bp);
    await service.savePlayer(snap.player);

    const row = rows[0];
    expect(row.diamonds).toBe(0);       // 条目被删 → 落 0
    expect(row.tickets).toBeCloseTo(3, 5);
    expect(row.dataCores).toBe(9);
  });

  it('部分更新（不含 backpack）不触碰货币列', async () => {
    const rows = [{
      id: 1, userId: 42, version: 0, mapId: 1,
      diamonds: 50, tickets: 3, dataCores: 9,
      backpack: '[]', markers: '{}',
    }];
    const service = makeService(makePrisma(rows));

    await service.savePlayer({ id: 1, markers: JSON.stringify({ x: 1 }) } as any);

    const row = rows[0];
    expect(row.diamonds).toBe(50);
    expect(row.tickets).toBe(3);
    expect(parseJson(row.markers, {})).toEqual({ x: 1 });
  });
});
