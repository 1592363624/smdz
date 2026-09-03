/**
 * 静态游戏数据管理服务（StaticDataAdminService）
 * ------------------------------------------------------------------
 * 后台「数据管理」模块的服务端：对 server/prisma/data/*.json 的
 * 物品/装备/怪物/地图/任务等固定配置提供 查看/新增/编辑/删除 能力。
 *
 * 设计说明：
 * - 单一数据源仍是 prisma/data/*.json（与 StaticDataService 一致），
 *   本服务直接读写磁盘文件，不做内存长缓存，避免与 StaticDataService 缓存漂移。
 * - 每次成功写入前自动备份原文件到 server/backups/gamedata/（每文件保留最近 20 份），
 *   写错可人工回滚。
 * - 写入成功后调用 StaticDataService.refresh() 热更新内存缓存，改动立即生效，无需重启。
 * - 条目以数组下标寻址，更新/删除支持 expectName 乐观校验，防止前后端索引错位时误改他人。
 * - 分类注册表（key/文件/展示名/分组/列表列/新增模板）是唯一事实来源，
 *   前端「数据管理」面板完全由 GET /admin/gamedata 返回的元数据驱动，新增分类零前端改动。
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { StaticDataService } from '../game/static-data.service';

/** 列表列定义（前端表格列） */
export interface GameDataColumn {
  field: string;
  label: string;
  /** 宽列（描述类长文本，截断展示） */
  wide?: boolean;
}

/** 分类元数据（下发给前端驱动整个界面） */
export interface GameDataCategory {
  key: string;
  file: string;
  label: string;
  group: string;
  /** 单配置文件（整个 JSON 只有一个配置对象）：仅支持编辑第 0 条，禁新增/删除 */
  single: boolean;
  columns: GameDataColumn[];
  /** 新增条目的默认模板 */
  template: Record<string, any>;
  count: number;
}

/** 分类定义（注册表条目，count 运行时填充） */
interface GameCategoryDef extends Omit<GameDataCategory, 'count' | 'single'> {
  /** 搜索字段（缺省 name/description） */
  searchFields?: string[];
  /** 文件顶层是单个 JSON 对象（如 seed-items.json 的 {items:[...]}），写回时须保持该形状 */
  objectFile?: boolean;
  /** 单配置文件（整个 JSON 只有一个配置对象）：仅支持编辑第 0 条，禁新增/删除 */
  single?: boolean;
}

/** 每文件备份保留份数 */
const BACKUP_KEEP = 20;

@Injectable()
export class StaticDataAdminService {
  private readonly logger = new Logger(StaticDataAdminService.name);

  constructor(private readonly staticData: StaticDataService) {}

  /**
   * 分类注册表：前端「数据管理」面板完全由此驱动。
   * key 与 StaticDataService.DATA_FILES 对齐（refresh 才能命中缓存）；
   * blueprint-purchases.json 未被 StaticDataService 加载，仅存取文件。
   */
  private readonly categories: GameCategoryDef[] = [
    // ===== 物品道具 =====
    {
      key: 'items', file: 'items.json', label: '物品', group: '物品道具',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'type', label: '类型' },
        { field: 'value', label: '价值' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', type: '物品', value: 1, description: '', useEffects: [], useMarkers: [] },
    },
    {
      key: 'seedItems', file: 'seed-items.json', label: '种子物品池', group: '物品道具',
      single: true,
      objectFile: true,
      columns: [{ field: 'items', label: '物品列表', wide: true }],
      template: { items: [] },
    },
    // ===== 装备 =====
    {
      key: 'equipments', file: 'equipments.json', label: '装备/武器', group: '装备',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'equipType', label: '部位' },
        { field: 'specialSeq', label: '特殊序号' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', description: '', equipType: '装备', specialSeq: 0, bonus: {}, baseBonus: {} },
    },
    // ===== 怪物与使魔 =====
    {
      key: 'monsters', file: 'monsters.json', label: '怪物', group: '怪物与使魔',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'type', label: '种类' },
        { field: 'specialSeq', label: '序号' },
        { field: 'level', label: '等级' },
        { field: 'maxHp', label: '生命' },
        { field: 'attack', label: '攻击' },
        { field: 'defense', label: '防御' },
      ],
      template: {
        name: '', type: '怪物', specialSeq: -1, description: '', level: 1,
        hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        attack: 10, defense: 0, speed: 100, dodge: 0, hit: 100, exp: 10,
        equipments: [], weapons: [], markers: [], backpack: [],
      },
    },
    {
      key: 'familiars', file: 'familiars.json', label: '使魔', group: '怪物与使魔',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'specialSeq', label: '序号' },
        { field: 'uniqueSkill', label: '专属技能', wide: true },
      ],
      template: { name: '', specialSeq: 0, description: '', uniqueSkill: '' },
    },
    // ===== 地图 =====
    {
      key: 'maps', file: 'maps.json', label: '地图', group: '地图',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'mapIndex', label: '编号' },
        { field: 'level', label: '等级' },
        { field: 'isFrontier', label: '开拓地' },
        { field: 'isInstance', label: '关卡' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: {
        name: '', description: '', mapIndex: 0, level: 1,
        isFrontier: false, noTeleport: false, noMove: false, isInstance: false,
        requiredTravel: 0, monsters: [], connections: [], resources: [], npcs: [],
        monsterCount: 3,
      },
    },
    // ===== 任务成就 =====
    {
      key: 'tasks', file: 'tasks.json', label: '任务/成就', group: '任务成就',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'publisher', label: '发布人' },
        { field: 'chance', label: '概率' },
        { field: 'level', label: '等级' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', description: '', chance: 1, publisher: '', requirements: [], rewards: [] },
    },
    // ===== 称号 =====
    {
      key: 'titles', file: 'titles.json', label: '称号', group: '称号',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', description: '', bonus: {}, requirements: [], rewards: [] },
    },
    // ===== 配方蓝图 =====
    {
      key: 'recipes', file: 'recipes.json', label: '图鉴配方', group: '配方蓝图',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'level', label: '等级' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', description: '', level: 1, outputs: [], inputs: [] },
    },
    {
      key: 'craftings', file: 'craftings.json', label: '制造配方', group: '配方蓝图',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'level', label: '等级' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', description: '', level: 1, outputs: [], requirements: [] },
    },
    {
      key: 'vehicleRecipes', file: 'vehicle-recipes.json', label: '载具配方', group: '配方蓝图',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'level', label: '等级' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', description: '', level: 1, outputs: [], inputs: [] },
    },
    {
      key: 'blueprints', file: 'blueprints.json', label: '蓝图', group: '配方蓝图',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'type', label: '类型' },
        { field: 'craftTime', label: '耗时' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', type: '', craftTime: 1, cost: 0, materials: [] },
    },
    {
      key: 'blueprintPurchases', file: 'blueprint-purchases.json', label: '蓝图购买', group: '配方蓝图',
      columns: [{ field: 'name', label: '名称' }],
      template: { name: '' },
    },
    // ===== 建筑与NPC =====
    {
      key: 'buildings', file: 'buildings.json', label: '建筑', group: '建筑与NPC',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'type', label: '类型' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', type: '', description: '', materials: [] },
    },
    {
      key: 'npcs', file: 'npcs.json', label: 'NPC对话', group: '建筑与NPC',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'taskId', label: '任务ID' },
      ],
      template: { name: '', taskId: 0, hostileChat: [], friendlyChat: [] },
    },
    // ===== 载具 =====
    {
      key: 'vehicles', file: 'vehicles.json', label: '载具模板', group: '载具',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'type', label: '类型' },
        { field: 'moveType', label: '行走方式' },
        { field: 'maxHp', label: '生命' },
      ],
      template: {
        name: '', vehicleId: '', type: '', moveType: 1, maxHp: 100,
        weaponSlots: 0, defenseSlots: 0, moveSlots: 0, functionSlots: 0,
      },
    },
    {
      key: 'vehicleParts', file: 'vehicle-parts.json', label: '载具部件', group: '载具',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'partType', label: '部件类型' },
        { field: 'limit', label: '限制' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', description: '', partType: '', limit: '', bonus: {} },
    },
    // ===== 商店资源 =====
    {
      key: 'shops', file: 'shops.json', label: '商店配置', group: '商店资源',
      single: true,
      columns: [
        { field: 'shopActivity', label: '活跃度商店', wide: true },
        { field: 'shopDiamond', label: '钻石商店', wide: true },
        { field: 'shopData', label: '数据商店', wide: true },
      ],
      template: { shopActivity: [], shopDiamond: [], shopData: [] },
    },
    {
      key: 'resources', file: 'resources.json', label: '资源', group: '商店资源',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'times', label: '次数' },
        { field: 'renewable', label: '可再生' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', description: '', times: 1, renewable: true, outputs: [] },
    },
    {
      key: 'wrecks', file: 'wrecks.json', label: '残骸掉落', group: '商店资源',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'chance', label: '概率' },
      ],
      template: { name: '', chance: 1, parts: [] },
    },
    // ===== 战斗与增益 =====
    {
      key: 'buffs', file: 'buffs.json', label: '增益', group: '战斗与增益',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'duration', label: '时长' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', description: '', duration: 60, bonus: {} },
    },
    {
      key: 'effects', file: 'effects.json', label: '特效', group: '战斗与增益',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'limit', label: '限制' },
        { field: 'description', label: '描述', wide: true },
      ],
      template: { name: '', description: '', limit: '', bonus: {} },
    },
    {
      key: 'setEffects', file: 'set-effects.json', label: '套装效果', group: '战斗与增益',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'effectText', label: '效果', wide: true },
      ],
      template: { name: '', effectText: '' },
    },
    {
      key: 'attackTexts', file: 'attack-texts.json', label: '攻击文本', group: '战斗与增益',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'forMonster', label: '适用怪物' },
      ],
      template: { name: '', forMonster: '', attackTexts: [] },
    },
    // ===== 文本日志 =====
    {
      key: 'flavorTexts', file: 'flavor-texts.json', label: '风味文本', group: '文本日志',
      columns: [
        { field: 'name', label: '名称' },
        { field: 'content', label: '内容', wide: true },
      ],
      template: { name: '', content: '' },
    },
    {
      key: 'updateLogs', file: 'update-logs.json', label: '更新日志', group: '文本日志',
      single: true,
      columns: [{ field: 'name', label: '名称' }, { field: 'content', label: '内容', wide: true }],
      template: { name: '', content: '' },
    },
    {
      key: 'merchant', file: 'merchant.json', label: '行商配置', group: '文本日志',
      single: true,
      columns: [
        { field: 'equipmentText', label: '行商装备池', wide: true },
        { field: 'itemText', label: '行商物品池', wide: true },
      ],
      template: { equipmentText: '', itemText: '' },
    },
  ];

  /** 数据目录（与 StaticDataService 同源；测试可经 STATIC_DATA_DIR_OVERRIDE 覆盖） */
  private resolveDataDir(): string {
    const override = process.env.STATIC_DATA_DIR_OVERRIDE;
    if (override) return path.resolve(override);
    return path.resolve(__dirname, '../../../prisma/data');
  }

  /** 备份目录：{server}/backups/gamedata */
  private resolveBackupDir(): string {
    return path.resolve(this.resolveDataDir(), '../../backups/gamedata');
  }

  /** 按注册表 key 查分类定义，找不到抛 404 */
  private getCategory(key: string): GameCategoryDef {
    const def = this.categories.find((c) => c.key === key);
    if (!def) {
      throw new NotFoundException(`未知的静态数据分类: ${key}`);
    }
    return def;
  }

  /** 分类文件路径 */
  private getCategoryFile(def: GameCategoryDef): string {
    return path.join(this.resolveDataDir(), def.file);
  }

  /** 读取某分类的 JSON 数组（文件缺失/解析失败按空数组处理，与 StaticDataService 行为一致） */
  private readRows(def: GameCategoryDef): any[] {
    const file = this.getCategoryFile(def);
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
      // 单配置文件存的是对象而非数组（如 seed-items.json），统一包一层数组寻址
      if (parsed && typeof parsed === 'object') return [parsed];
      return [];
    } catch (err: any) {
      throw new BadRequestException(`静态数据文件 ${def.file} 解析失败: ${err.message}`);
    }
  }

  // ============ 对外接口 ============

  /** 全部分类元数据（含条目数），驱动前端面板 */
  listCategories(): GameDataCategory[] {
    return this.categories.map((def) => {
      let count = 0;
      try {
        count = this.readRows(def).length;
      } catch {
        count = 0; // 文件损坏时列表页仍可打开，进入该分类才报错
      }
      return {
        key: def.key,
        file: def.file,
        label: def.label,
        group: def.group,
        single: !!def.single,
        columns: def.columns,
        template: def.template,
        count,
      };
    });
  }

  /** 某分类全部条目（数据量小，整包返回，前端本地过滤） */
  getEntries(key: string): { key: string; file: string; label: string; single: boolean; entries: any[] } {
    const def = this.getCategory(key);
    return {
      key: def.key,
      file: def.file,
      label: def.label,
      single: !!def.single,
      entries: this.readRows(def),
    };
  }

  /** 新增条目 */
  async createEntry(key: string, data: any): Promise<{ index: number; name: string }> {
    const def = this.getCategory(key);
    if (def.single) {
      throw new BadRequestException(`「${def.label}」为单配置文件，只能编辑已有配置，不支持新增`);
    }
    const rows = this.readRows(def);
    const entry = this.normalizeEntry(def, data);
    this.assertNameUnique(def, rows, entry.name);
    rows.push(entry);
    await this.persist(def, rows);
    return { index: rows.length - 1, name: entry.name };
  }

  /** 更新指定下标条目（expectName 乐观校验） */
  async updateEntry(key: string, index: number, data: any, expectName?: string): Promise<{ name: string }> {
    const def = this.getCategory(key);
    const rows = this.readRows(def);
    if (index < 0 || index >= rows.length) {
      throw new NotFoundException(`「${def.label}」不存在序号为 ${index} 的条目`);
    }
    const current = rows[index];
    if (expectName !== undefined && current?.name !== expectName) {
      throw new BadRequestException(
        `条目已被其他人修改（当前为「${current?.name ?? '?'}」，预期「${expectName}」），请刷新后重试`,
      );
    }
    const entry = this.normalizeEntry(def, data);
    // 名称变更时做唯一性校验（排除自身下标）
    this.assertNameUnique(def, rows, entry.name, index);
    rows[index] = entry;
    await this.persist(def, rows);
    return { name: entry.name };
  }

  /** 删除指定下标条目（expectName 乐观校验） */
  async deleteEntry(key: string, index: number, expectName?: string): Promise<{ name: string }> {
    const def = this.getCategory(key);
    if (def.single) {
      throw new BadRequestException(`「${def.label}」为单配置文件，不支持删除`);
    }
    const rows = this.readRows(def);
    if (index < 0 || index >= rows.length) {
      throw new NotFoundException(`「${def.label}」不存在序号为 ${index} 的条目`);
    }
    const current = rows[index];
    if (expectName !== undefined && current?.name !== expectName) {
      throw new BadRequestException(
        `条目已被其他人修改（当前为「${current?.name ?? '?'}」，预期「${expectName}」），请刷新后重试`,
      );
    }
    rows.splice(index, 1);
    await this.persist(def, rows);
    return { name: current?.name ?? '' };
  }

  // ============ 内部工具 ============

  /** 条目合法性校验与归一化：必须是非空对象，名称必填（单配置文件除外） */
  private normalizeEntry(def: GameCategoryDef, data: any): Record<string, any> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new BadRequestException('条目数据必须是一个 JSON 对象');
    }
    const entry = JSON.parse(JSON.stringify(data)) as Record<string, any>; // 深拷贝，剥离前端多余引用
    if (!def.single) {
      const name = String(entry.name ?? '').trim();
      if (!name) {
        throw new BadRequestException(`「${def.label}」条目必须填写名称(name)`);
      }
      entry.name = name;
    }
    return entry;
  }

  /** 名称唯一性校验（同文件内不可重名；excludeIndex 用于更新时排除自身） */
  private assertNameUnique(def: GameCategoryDef, rows: any[], name: string, excludeIndex = -1): void {
    if (def.single || !name) return;
    const dupIndex = rows.findIndex((r, i) => i !== excludeIndex && r?.name === name);
    if (dupIndex >= 0) {
      throw new BadRequestException(`名称「${name}」已存在（序号 ${dupIndex}），同分类下名称必须唯一`);
    }
  }

  /**
   * 持久化：备份原文件 → 原子写入 → 清空 StaticDataService 缓存（热更新）。
   * 写文件失败时原数据仍在备份与 tmp 之外不受影响。
   */
  private async persist(def: GameCategoryDef, rows: any[]): Promise<void> {
    const file = this.getCategoryFile(def);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // 备份：仅当原文件存在且有内容变化风险时
    if (fs.existsSync(file)) {
      this.backupFile(def.file, file);
    }
    // 原子写：先写 tmp 再 rename，避免写入中途崩溃导致 JSON 半截损坏。
    // objectFile 分类（如 seed-items.json）顶层是单个对象，须还原原格式写回；
    // 换行符跟随原文件（CRLF/LF），不追加末尾换行，保持与原数据文件字节级一致。
    const payload = def.objectFile && rows.length === 1 ? rows[0] : rows;
    const eol = fs.existsSync(file) && fs.readFileSync(file, 'utf-8').includes('\r\n') ? '\r\n' : '\n';
    const body = JSON.stringify(payload, null, 2).split('\n').join(eol);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body, 'utf-8');
    fs.renameSync(tmp, file);
    // 热更新：清空静态数据缓存，下次访问从磁盘重载
    this.staticData.refresh();
    this.logger.log(`静态数据「${def.label}」(${def.file}) 已更新，共 ${rows.length} 条，缓存已重载`);
  }

  /** 备份单个数据文件，按文件名分组保留最近 BACKUP_KEEP 份 */
  private backupFile(fileName: string, sourceFile: string): void {
    try {
      const backupDir = this.resolveBackupDir();
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(sourceFile, path.join(backupDir, `${fileName}.${stamp}.bak`));
      // 清理旧备份：同前缀按修改时间倒序保留 BACKUP_KEEP 份
      const olds = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith(`${fileName}.`) && f.endsWith('.bak'))
        .map((f) => ({ f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of olds.slice(BACKUP_KEEP)) {
        fs.unlinkSync(path.join(backupDir, old.f));
      }
    } catch (err: any) {
      // 备份失败不阻断保存，但要留下警示
      this.logger.warn(`备份 ${fileName} 失败: ${err.message}`);
    }
  }
}
