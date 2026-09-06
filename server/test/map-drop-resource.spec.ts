/**
 * 掉落资源投放回归测试（2026-09-06 线上事故：货舱 / 能量元素编号点了没反应）
 *
 * 事故根因：定时任务把动态资源写成 {name,type,amount} 字面量塞进 GameMap.resources2，
 * ① 缺 gatherCmd → 观察附近给它编了号但 cmd 为空 → 编号不注册 → 发数字完全无反应；
 * ② 采集链路 getGatherResources 在 resources 非空时只读 resources → 永远采不到；
 * ③ 缺 outputs → 即便采到也是「什么都没有收集到」。
 *
 * 本套件锁定修复后的三条不变量：
 *   1) 投放落在 resources（采集可见集），不是 resources2；
 *   2) 投放的是全局资源表的完整定义（gatherCmd / outputs / timeScale 齐全）；
 *   3) 重复投放累加「次数」，不是新增条目、也不是累加 amount。
 */

import { MapService } from '../src/modules/game/map.service';

/** 全局资源表中的「货舱」定义（与 prisma/data/resources.json 口径一致） */
const CARGO_DEF = {
  name: '货舱',
  times: 1,
  gatherCmd: '打开货舱',
  timeScale: 6,
  renewable: false,
  gatherText: '【名称】【载具】正在破解货舱',
  marker: '',
  outputs: [{ name: '能量块', count: 1, chance: 50 }],
  outputs2: [],
};

const ENERGY_DEF = {
  name: '能量元素',
  times: 1,
  gatherCmd: '收集能量',
  timeScale: 6,
  renewable: false,
  outputs: [{ name: '能量块', count: 1, chance: 50 }],
  outputs2: [],
};

function createMapRow(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    name: '森林出口',
    // 地图固有资源非空 → getGatherResources 只会读 resources
    resources: [
      { name: '大树', times: 60, gatherCmd: '收集木头', outputs: [{ name: '木头', count: 3, chance: 100 }], outputs2: [] },
    ],
    resources2: [],
    markers2: [],
    ...overrides,
  };
}

function createService(row: any) {
  const updates: any[] = [];
  const prisma: any = {
    gameMap: {
      findUnique: jest.fn(async ({ where }: any) => (where?.id === row.id ? { ...row } : null)),
      update: jest.fn(async ({ data }: any) => {
        updates.push(data);
        Object.assign(row, data);
        return row;
      }),
    },
  };
  const staticData: any = {
    getMapByName: () => undefined, // 模拟"静态 JSON 中不存在 → 直接返回 DB 数据"分支
    getAllResources: () => [CARGO_DEF, ENERGY_DEF],
  };
  const service = new MapService(
    prisma,
    staticData,
    {} as any, // bonusService
    {} as any, // combatState
    {} as any, // changeBus
  );
  return { service, prisma, updates, row };
}

describe('MapService.dropResourceToMap — 掉落资源投放', () => {
  it('首次投放：写入 resources（采集可见集），并携带完整资源定义', async () => {
    const row = createMapRow();
    const { service, updates } = createService(row);

    const changed = await service.dropResourceToMap(row.id, '货舱', 1);

    expect(changed).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].resources).toBeDefined();
    expect(updates[0].resources2).toBeUndefined();

    const cargo = updates[0].resources.find((r: any) => r.name === '货舱');
    expect(cargo).toBeDefined();
    // 关键：必须有 gatherCmd，否则观察附近的编号会注册成空指令（点了没反应）
    expect(cargo.gatherCmd).toBe('打开货舱');
    expect(cargo.times).toBe(1);
    expect(cargo.outputs.length).toBeGreaterThan(0);
    // 地图固有资源不受影响
    expect(updates[0].resources.find((r: any) => r.name === '大树')).toBeDefined();
  });

  it('重复投放：累加次数而不是新增条目 / 累加 amount', async () => {
    const row = createMapRow();
    const { service, row: state } = createService(row);

    await service.dropResourceToMap(row.id, '货舱', 1);
    await service.dropResourceToMap(row.id, '货舱', 1);
    await service.dropResourceToMap(row.id, '货舱', 3);

    const cargos = state.resources.filter((r: any) => r.name === '货舱');
    expect(cargos).toHaveLength(1);
    expect(cargos[0].times).toBe(5);
    expect(cargos[0].amount).toBeUndefined();
  });

  it('多个资源各自独立计数', async () => {
    const row = createMapRow();
    const { service, row: state } = createService(row);

    await service.dropResourceToMap(row.id, '货舱', 1);
    await service.dropResourceToMap(row.id, '能量元素', 1);
    await service.dropResourceToMap(row.id, '能量元素', 1);

    expect(state.resources.find((r: any) => r.name === '货舱').times).toBe(1);
    expect(state.resources.find((r: any) => r.name === '能量元素').times).toBe(2);
    expect(state.resources.find((r: any) => r.name === '能量元素').gatherCmd).toBe('收集能量');
  });

  it('资源名不在全局资源表时：不改动地图，返回 false', async () => {
    const row = createMapRow();
    const { service, prisma } = createService(row);

    const changed = await service.dropResourceToMap(row.id, '不存在的资源', 1);

    expect(changed).toBe(false);
    expect(prisma.gameMap.update).not.toHaveBeenCalled();
  });

  it('空资源名 / 地图不存在：安全返回 false', async () => {
    const row = createMapRow();
    const { service } = createService(row);

    expect(await service.dropResourceToMap(row.id, '', 1)).toBe(false);
    expect(await service.dropResourceToMap(999, '货舱', 1)).toBe(false);
  });
});
