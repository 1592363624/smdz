/**
 * 系统配置中心：导出 / 导入（merge / replace / dryRun）。
 *
 * 关键不变量：
 * - 导出 = 整表 dump，不维护键白名单 → 未来新增键自动包含
 * - 导入 = 按 key upsert，不校验「本代码是否认识该键」
 * - merge 保留目标库多出的键；replace 清空后全量写入
 */

import { SystemConfigService } from '../src/modules/system-config/system-config.service';

function makePrismaStub(initial: Array<Partial<{ key: string; value: string; type: string; group: string; label: string; description: string }>> = []) {
  const rows = new Map<string, any>();
  initial.forEach((row, idx) => {
    rows.set(row.key!, {
      id: idx + 1,
      value: '',
      type: 'string',
      group: 'system',
      label: row.key,
      description: '',
      ...row,
    });
  });
  let nextId = rows.size + 1;
  const prisma: any = {
    systemConfig: {
      findMany: jest.fn(async () =>
        [...rows.values()].sort((a, b) => a.id - b.id),
      ),
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.key) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.key);
        if (!row) throw new Error(`not found: ${where.key}`);
        Object.assign(row, data);
        return row;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (rows.has(data.key)) throw new Error(`duplicate: ${data.key}`);
        const row = { id: nextId++, ...data };
        rows.set(data.key, row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const keys: string[] = where?.key?.in ?? [];
        let count = 0;
        for (const k of keys) {
          if (rows.delete(k)) count++;
        }
        return { count };
      }),
    },
    _rows: rows,
  };
  return prisma;
}

function makeService(prisma: any): SystemConfigService {
  const svc = Object.create(SystemConfigService.prototype) as SystemConfigService;
  (svc as any).prisma = prisma;
  (svc as any).logger = { log: jest.fn(), warn: jest.fn() };
  (svc as any).cache = new Map();
  return svc;
}

describe('SystemConfigService 导出/导入', () => {
  const baseRows = [
    {
      key: 'command.prefixes',
      value: '["/","！"]',
      type: 'string-array',
      group: 'command',
      label: '指令前缀',
      description: '识别指令的前缀列表',
    },
    {
      key: 'game.expMultiplier',
      value: '2',
      type: 'number',
      group: 'game',
      label: '经验倍率',
      description: '',
    },
  ];

  it('exportAll 整表导出（含元数据），未来新键无需改代码即自动包含', async () => {
    const prisma = makePrismaStub([
      ...baseRows,
      {
        key: 'game.futureNewKey',
        value: '42',
        type: 'number',
        group: 'game',
        label: '未来新增项',
        description: '测试整表 dump',
      },
    ]);
    const svc = makeService(prisma);
    const payload = await svc.exportAll();

    expect(payload.format).toBe('system-config-export');
    expect(payload.version).toBe(1);
    expect(payload.configs.map((c) => c.key).sort()).toEqual([
      'command.prefixes',
      'game.expMultiplier',
      'game.futureNewKey',
    ]);
    const future = payload.configs.find((c) => c.key === 'game.futureNewKey')!;
    expect(future.value).toBe('42');
    expect(future.type).toBe('number');
    expect(future.group).toBe('game');
  });

  it('exportAll → import merge 回写：值一致，unchanged', async () => {
    const prisma = makePrismaStub(baseRows);
    const svc = makeService(prisma);
    const payload = await svc.exportAll();
    const result = await svc.importConfigs(payload, { mode: 'merge' });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(2);
    expect(prisma.systemConfig.update).not.toHaveBeenCalled();
    expect(prisma.systemConfig.create).not.toHaveBeenCalled();
  });

  it('import merge：改值、建新键、保留目标库多出的键', async () => {
    const prisma = makePrismaStub([
      ...baseRows,
      { key: 'local.onlyKey', value: 'keep-me', type: 'string', group: 'local' },
    ]);
    const svc = makeService(prisma);
    const result = await svc.importConfigs(
      {
        format: 'system-config-export',
        version: 1,
        configs: [
          { key: 'command.prefixes', value: '["/","!","?"]', type: 'string-array' },
          { key: 'game.brandNewKey', value: 'hello', type: 'string', group: 'game' },
          { key: 'game.expMultiplier', value: '2', type: 'number' },
        ],
      },
      { mode: 'merge' },
    );

    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(prisma._rows.get('command.prefixes').value).toBe('["/","!","?"]');
    expect(prisma._rows.get('game.brandNewKey').value).toBe('hello');
    expect(prisma._rows.get('local.onlyKey').value).toBe('keep-me');
    // 新键 label 回退为 key，group 用文件或 key 前缀
    expect(prisma._rows.get('game.brandNewKey').group).toBe('game');
  });

  it('import replace：清空目标库独有键，按文件全量写入', async () => {
    const prisma = makePrismaStub([
      ...baseRows,
      { key: 'local.onlyKey', value: 'will-be-deleted' },
    ]);
    const svc = makeService(prisma);
    const result = await svc.importConfigs(
      {
        format: 'system-config-export',
        version: 1,
        configs: [{ key: 'command.prefixes', value: '["/"]', type: 'string-array' }],
      },
      { mode: 'replace' },
    );

    expect(result.deleted).toBe(2); // game.expMultiplier + local.onlyKey
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(prisma._rows.has('local.onlyKey')).toBe(false);
    expect(prisma._rows.has('game.expMultiplier')).toBe(false);
    expect(prisma._rows.get('command.prefixes').value).toBe('["/"]');
  });

  it('dryRun 只预览不落库', async () => {
    const prisma = makePrismaStub(baseRows);
    const svc = makeService(prisma);
    const result = await svc.importConfigs(
      {
        format: 'system-config-export',
        version: 1,
        configs: [
          { key: 'command.prefixes', value: '["NEW"]' },
          { key: 'game.brandNewKey', value: '1', type: 'number' },
        ],
      },
      { mode: 'merge', dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.updated).toBe(1);
    expect(result.created).toBe(1);
    expect(prisma._rows.get('command.prefixes').value).toBe('["/","！"]');
    expect(prisma._rows.has('game.brandNewKey')).toBe(false);
    expect(prisma.systemConfig.update).not.toHaveBeenCalled();
    expect(prisma.systemConfig.create).not.toHaveBeenCalled();
    expect(prisma.systemConfig.deleteMany).not.toHaveBeenCalled();
  });

  it('拒绝 format 不匹配 / configs 缺失 / value 非字符串', async () => {
    const prisma = makePrismaStub(baseRows);
    const svc = makeService(prisma);

    await expect(
      svc.importConfigs({ format: 'other', version: 1, configs: [] } as any),
    ).rejects.toThrow(/format/);
    await expect(
      svc.importConfigs({ format: 'system-config-export', version: 1 } as any),
    ).rejects.toThrow(/configs/);
    await expect(
      svc.importConfigs(
        {
          format: 'system-config-export',
          version: 1,
          configs: [{ key: 'a.b', value: 123 as any }],
        },
        { mode: 'merge' },
      ),
    ).rejects.toThrow(/value/);
  });

  it('元数据：文件提供了 label/description 时 merge 一并更新', async () => {
    const prisma = makePrismaStub(baseRows);
    const svc = makeService(prisma);
    await svc.importConfigs(
      {
        format: 'system-config-export',
        version: 1,
        configs: [
          {
            key: 'game.expMultiplier',
            value: '2',
            type: 'number',
            group: 'game',
            label: '经验获取倍率',
            description: '全局经验加成',
          },
        ],
      },
      { mode: 'merge' },
    );
    const row = prisma._rows.get('game.expMultiplier');
    expect(row.label).toBe('经验获取倍率');
    expect(row.description).toBe('全局经验加成');
    expect(row.value).toBe('2');
  });
});

describe('SystemConfigService 启动清理废弃配置', () => {
  it('删除无读取方的运行时统计键，不再显示成可编辑配置', async () => {
    const prisma = makePrismaStub([
      { key: 'game.highestPlayerLevel', value: '162', type: 'number', group: 'game', label: '最高级玩家等级' },
    ]);
    const svc = makeService(prisma);
    await svc.onModuleInit();
    expect(prisma._rows.has('game.highestPlayerLevel')).toBe(false);
  });
});
