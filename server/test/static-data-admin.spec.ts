/**
 * 后台「数据管理」单元测试
 * 覆盖 StaticDataAdminService 的核心行为：
 * 分类元数据统计、条目增删改、名称唯一性校验、expectName 乐观校验、
 * 单配置文件禁增删、objectFile 形状保持（seed-items.json 顶层对象）、备份与热重载。
 * 通过 STATIC_DATA_DIR_OVERRIDE 把数据目录指向临时目录，不触碰真实数据。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StaticDataAdminService } from '../src/modules/admin/static-data-admin.service';

/** 在系统临时目录中构造一份迷你静态数据 */
function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shimo-gamedata-'));
  const write = (file: string, data: any) =>
    fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2) + '\n', 'utf-8');
  write('items.json', [
    { name: '水晶', type: '物品', value: 5, description: '零号元素结晶' },
    { name: '能量块', type: '物品', value: 10, description: '能量聚合体' },
  ]);
  write('shops.json', [{ shopActivity: [{ name: '水晶', count: 1 }], shopDiamond: [], shopData: [] }]);
  // seed-items.json 顶层是单个对象（非数组），写回时必须保持该形状
  write('seed-items.json', { items: ['种子', '种子'] });
  return dir;
}

describe('StaticDataAdminService', () => {
  let dataDir: string;
  let service: StaticDataAdminService;
  let refresh: jest.Mock;

  beforeEach(() => {
    dataDir = makeTempDataDir();
    process.env.STATIC_DATA_DIR_OVERRIDE = dataDir;
    refresh = jest.fn();
    service = new StaticDataAdminService({ refresh } as any);
  });

  afterEach(() => {
    delete process.env.STATIC_DATA_DIR_OVERRIDE;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('listCategories 返回注册表分类并统计条目数', () => {
    const cats = service.listCategories();
    const keys = cats.map((c) => c.key);
    // 覆盖用户要求的核心类别：物品/装备/怪物/地图/任务
    for (const k of ['items', 'equipments', 'monsters', 'maps', 'tasks', 'familiars', 'titles']) {
      expect(keys).toContain(k);
    }
    expect(cats.find((c) => c.key === 'items')!.count).toBe(2);
    expect(cats.find((c) => c.key === 'shops')!.single).toBe(true);
    // 每个分类都下发展示列与新增模板（前端面板依赖）
    for (const c of cats) {
      expect(c.columns.length).toBeGreaterThan(0);
      expect(c.template).toBeDefined();
    }
  });

  it('getEntries 返回某分类全部条目', () => {
    const res = service.getEntries('items');
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0].name).toBe('水晶');
  });

  it('createEntry 追加条目、写盘生效并触发热重载与备份', async () => {
    const res = await service.createEntry('items', {
      name: ' 测试药水 ',
      type: '道具',
      value: 3,
      description: '新增的条目',
    });
    expect(res.index).toBe(2);
    // 名称已 trim
    expect(res.name).toBe('测试药水');

    // 写盘：JSON 内容已更新
    const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf-8'));
    expect(rows).toHaveLength(3);
    expect(rows[2].name).toBe('测试药水');

    // 热重载：refresh 被调用
    expect(refresh).toHaveBeenCalled();

    // 备份：原 2 条数据被备份
    const backupDir = path.join(dataDir, '../../backups/gamedata'.split('/').join(path.sep));
    const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    expect(backups.some((f) => f.startsWith('items.json.') && f.endsWith('.bak'))).toBe(true);
  });

  it('createEntry 同分类重名拒绝', async () => {
    await expect(service.createEntry('items', { name: '水晶' })).rejects.toThrow(BadRequestException);
    // 拒绝时不写盘
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf-8'))).toHaveLength(2);
  });

  it('createEntry 缺名称拒绝', async () => {
    await expect(service.createEntry('items', { value: 1 })).rejects.toThrow(BadRequestException);
    await expect(service.createEntry('items', 'not-an-object' as any)).rejects.toThrow(BadRequestException);
  });

  it('updateEntry 按下标整体替换条目', async () => {
    await service.updateEntry('items', 1, { name: '能量块·改', value: 99 });
    const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf-8'));
    expect(rows[1].name).toBe('能量块·改');
    expect(rows[1].value).toBe(99);
    expect(rows[0].name).toBe('水晶');
  });

  it('updateEntry expectName 与当前不符时拒绝(乐观锁)', async () => {
    await expect(
      service.updateEntry('items', 0, { name: '水晶·改' }, '错误的旧名'),
    ).rejects.toThrow(BadRequestException);
    const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf-8'));
    expect(rows[0].name).toBe('水晶');
  });

  it('updateEntry 改名与其他条目重名时拒绝', async () => {
    await expect(service.updateEntry('items', 1, { name: '水晶' })).rejects.toThrow(BadRequestException);
  });

  it('deleteEntry 按下标删除条目', async () => {
    const res = await service.deleteEntry('items', 0, '水晶');
    expect(res.name).toBe('水晶');
    const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf-8'));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('能量块');
  });

  it('deleteEntry 下标越界抛 404', async () => {
    await expect(service.deleteEntry('items', 99)).rejects.toThrow(NotFoundException);
  });

  it('单配置分类只允许编辑第0条，禁增删', async () => {
    // 商店：单元素数组，可编辑
    await service.updateEntry('shops', 0, { shopActivity: [], shopDiamond: [{ name: '钻石块', count: 1 }], shopData: [] });
    const shops = JSON.parse(fs.readFileSync(path.join(dataDir, 'shops.json'), 'utf-8'));
    expect(Array.isArray(shops)).toBe(true);
    expect(shops[0].shopDiamond[0].name).toBe('钻石块');

    // 禁新增/删除
    await expect(service.createEntry('shops', { data: {} })).rejects.toThrow(BadRequestException);
    await expect(service.deleteEntry('shops', 0)).rejects.toThrow(BadRequestException);
  });

  it('seedItems(objectFile) 编辑后写回保持对象顶层形状', async () => {
    await service.updateEntry('seedItems', 0, { items: ['种子', '种子', '发光种子'] });
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'seed-items.json'), 'utf-8'));
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.items).toHaveLength(3);
    // StaticDataService.getMerchantExtraItems 的兼容读取路径仍然可用
    expect(Array.isArray(parsed.items) ? parsed.items : []).toContain('发光种子');
  });

  it('未知分类抛 404', async () => {
    expect(() => service.getEntries('no-such-key')).toThrow(NotFoundException);
    await expect(service.createEntry('no-such-key', {})).rejects.toThrow(NotFoundException);
  });
});
