import { StaticDataService } from '../src/modules/game/static-data.service';

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

// eslint-disable-next-line import/first
import * as fs from 'fs';

/**
 * StaticDataService 启动校验 + name 索引回归（RVW04 P2-7）
 *
 * 覆盖三件事：
 * 1. **JSON 损坏 fail-fast**：旧实现 loadRaw 解析失败 catch 后 warn 并返回 []，
 *    整张表静默为空、服务照常启动——这是全库数据级 P0（悬空引用/异常值）无拦截点
 *    的根因。新实现：解析失败直接抛错（onModuleInit 全量预载 → 应用拒绝启动），
 *    且失败结果不进缓存（修复文件后立即可读回，无需 refresh/重启）。
 * 2. **内容校验告警不阻断**：重复名/空表/负数量汇总为一条告警日志，数据照常入缓存
 *    ——存量脏数据只暴露、不挡死整个服务；文件缺失维持旧行为（warn + 空数组），
 *    vehicle-recipes 等可选文件允许无配置。
 * 3. **findByKey Map 索引语义不变**：索引只做查找加速，命中返回缓存行**同一引用**
 *    （与旧 Array.find 完全一致，不 clone、不换对象），未命中 undefined，
 *    重复名取首条，refresh() 后索引失效重建。
 */

const mockedExists = fs.existsSync as unknown as jest.Mock;
const mockedRead = fs.readFileSync as unknown as jest.Mock;

/** 构造服务实例并替换私有 logger，捕获（同时静音）告警输出 */
function makeService(): { svc: StaticDataService; warn: jest.Mock; log: jest.Mock } {
  const svc = new StaticDataService();
  const warn = jest.fn();
  const log = jest.fn();
  (svc as any).logger = { warn, log, error: jest.fn() };
  return { svc, warn, log };
}

describe('StaticDataService 启动校验 + findByKey 索引（RVW04 P2-7）', () => {
  beforeEach(() => {
    mockedExists.mockReset();
    mockedRead.mockReset();
  });

  describe('JSON 损坏 → fail-fast 终止启动', () => {
    it('loadRaw 解析失败直接抛错，不再 warn + 静默空表；失败结果不进缓存', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockReturnValue('{"name": "木头", "quantity": 1,,}'); // 语法损坏
      const { svc, warn } = makeService();

      expect(() => svc.loadRaw('items')).toThrow(/items\.json.*解析失败/);
      // 旧实现此处是 warn + 返回 []，新实现绝不静默
      expect(warn).not.toHaveBeenCalled();

      // 失败结果不得进缓存：修复文件后立即可读回（无需 refresh/重启）
      mockedRead.mockReturnValue(JSON.stringify([{ name: '木头', quantity: 1 }]));
      expect(svc.loadRaw('items')).toEqual([{ name: '木头', quantity: 1 }]);
    });

    it('onModuleInit 全量预载：任一 JSON 损坏即抛错终止启动', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockImplementation((file: string) =>
        String(file).endsWith('monsters.json') ? '{ 损坏的 JSON' : '[]',
      );
      const { svc } = makeService();

      expect(() => svc.onModuleInit()).toThrow(/monsters\.json/);
    });

    it('读取失败（IO/权限）与语法损坏同级危险，同样 fail-fast', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      const { svc } = makeService();

      expect(() => svc.loadRaw('items')).toThrow(/读取失败/);
    });
  });

  describe('内容校验 → 告警列表，不阻断启动', () => {
    it('重复名：汇总为一条告警日志，数据照常入缓存（存量脏数据不挡死服务）', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockReturnValue(
        JSON.stringify([
          { name: '木头', quantity: 1 },
          { name: '石头', quantity: 2 },
          { name: '木头', quantity: 3 },
        ]),
      );
      const { svc, warn } = makeService();

      expect(() => svc.loadRaw('items')).not.toThrow();
      // 汇总为一条告警（而非逐条刷屏）
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('重复名'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('「木头」'));
      // 不阻断：三条全部入缓存
      expect(svc.getAllItems()).toHaveLength(3);
    });

    it('空表（文件存在但内容为空数组）告警；文件缺失维持旧行为不叠加空表告警', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockReturnValue('[]');
      const exists = makeService();
      expect(() => exists.svc.loadRaw('items')).not.toThrow();
      expect(exists.warn).toHaveBeenCalledWith(expect.stringContaining('空表'));

      // 文件缺失（vehicle-recipes 等可选文件允许无配置）：只有既有的「文件缺失」告警
      mockedExists.mockReturnValue(false);
      const missing = makeService();
      expect(missing.svc.loadRaw('vehicleRecipes')).toEqual([]);
      expect(missing.warn).toHaveBeenCalledTimes(1);
      expect(missing.warn).toHaveBeenCalledWith(expect.stringContaining('文件缺失'));
    });

    it('负数量（quantity/count/数量 任一为负）触发告警，不抛错', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockReturnValue(
        JSON.stringify([
          { name: '正常物品', quantity: 3 },
          { name: '负数量物品', count: -2 },
        ]),
      );
      const { svc, warn } = makeService();

      expect(() => svc.loadRaw('items')).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('负数量'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('-2'));
    });

    it('数据干净时不产生任何内容校验告警', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockReturnValue(
        JSON.stringify([
          { name: '甲', quantity: 1 },
          { name: '乙', count: 2 },
        ]),
      );
      const { svc, warn } = makeService();

      svc.loadRaw('items');
      expect(warn).not.toHaveBeenCalled();
    });

    it('非数组顶层（seed-items.json 单对象形状）跳过通用校验，不误报', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockReturnValue(JSON.stringify({ items: ['种子', '种子'] }));
      const { svc, warn } = makeService();

      expect(svc.loadRaw('seedItems')).toEqual({ items: ['种子', '种子'] });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('findByKey Map 索引：返回语义与旧线性扫描完全一致', () => {
    it('命中返回缓存行的同一引用（不 clone、不换对象），未命中返回 undefined', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockReturnValue(
        JSON.stringify([
          { name: '木头', quantity: 1 },
          { name: '石头', quantity: 2 },
        ]),
      );
      const { svc } = makeService();
      const cached = svc.loadRaw('items');

      // 与旧实现一致：返回缓存数组内的原始行引用（项目红线：对外不额外 clone）
      expect(svc.getItemByName('石头')).toBe(cached[1]);
      expect(svc.getItemByName('不存在')).toBeUndefined();
    });

    it('重复名返回首条（与旧 Array.find 语义一致）', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockReturnValue(
        JSON.stringify([
          { name: '木头', quantity: 1 },
          { name: '石头', quantity: 2 },
          { name: '木头', quantity: 3 },
        ]),
      );
      const { svc } = makeService();
      const cached = svc.loadRaw('items');

      expect(svc.getItemByName('木头')).toBe(cached[0]);
    });

    it('索引查找与线性扫描逐一比对完全一致（含全部行与未命中）', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockReturnValue(
        JSON.stringify([
          { name: '甲', quantity: 1 },
          { name: '乙', quantity: 2 },
          { name: '丙', specialSeq: -3 },
          { name: '丁', 数量: 4 },
        ]),
      );
      const { svc } = makeService();
      const cached = svc.loadRaw('items');

      for (const row of cached) {
        const expected = cached.find((r) => r?.name === row.name);
        expect(svc.getItemByName(row.name)).toBe(expected);
      }
      expect(svc.getItemByName('不存在')).toBeUndefined();
      expect(svc.getItemByName('')).toBeUndefined(); // 空串名不误命中
    });

    it('refresh() 后索引失效重建：旧数据查不到，新数据立即可查', () => {
      mockedExists.mockReturnValue(true);
      mockedRead.mockReturnValue(JSON.stringify([{ name: '木头', quantity: 1 }]));
      const { svc } = makeService();

      svc.getItemByName('木头'); // 触发索引构建
      svc.refresh(); // 热更新：缓存 + 索引全部清空

      mockedRead.mockReturnValue(JSON.stringify([{ name: '石头', quantity: 1 }]));
      expect(svc.getItemByName('木头')).toBeUndefined(); // 不残留旧索引
      const fresh = svc.loadRaw('items');
      expect(svc.getItemByName('石头')).toBe(fresh[0]);
    });
  });
});
