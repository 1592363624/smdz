/**
 * 全局熟练度（原版「全局标记」）—— 怪物等级动态化的数据源。
 *
 * ===== 原版语义（复刻依据）=====
 * 1. 存储：`全局标记` 是 @Global.ecode L8 声明的全局技能数组，随存档写入
 *    `地图存档/全局标记/1`（数据存取.ecode L1495 保存、L1360 读取），全局唯一一份。
 * 2. 积累：战斗相关.ecode L3667-3688——**任意一方被击杀**都会给全局标记加 1：
 *      · 怪物击杀目标（L3672-3673）：`攻击方.名称+"熟练度"` +1、`"世界熟练度"` +1
 *      · 目标被玩家/宠物击杀（L3684-3688）：`防御方.名称+"熟练度"` +1、
 *        击杀者是宠物时另加 `攻击方.类型+"熟练度"` +1、`"世界熟练度"` +1
 *    → 玩家杀得越多，该物种与世界等级越高，之后刷出的怪就越强（"越打越强"）。
 * 3. 换算：数据显示.ecode L1640 `显示熟练度等级(标记, 名称)` =
 *      最小 a 使 点数 < a²，即 **floor(√点数) + 1**（点数 0 → 1 级）。
 * 4. 怪物等级：加成计算.ecode L2711 / L2796
 *      `g.等级 = 显示熟练度等级(全局标记, 物种名, 去物种前缀=真)
 *               + 显示熟练度等级(全局标记, "世界")`
 *    且 `L2710 / L2797` 前置「配置等级 > 0 则直接用，= 0 才走上述动态公式」。
 *    原版 数据存取.ecode L551-602 的怪物节**根本不读取「等级」字段**，
 *    故原版怪物等级恒为动态。
 *
 * ===== 本实现的取舍（已核对，非自造）=====
 * · 条目命名沿用原版 `<名称>熟练度`（如 `史莱姆熟练度`、`世界熟练度`），
 *   便于与原版存档逐条对照；后缀拼接只在本文件出现一次。
 * · 写入侧按**去物种前缀后的基名**计数（精英史莱姆 → 史莱姆熟练度）。
 *   原版写入用的是未去前缀的 `防御方.名称`，而读取用的是去前缀后的基名，
 *   两者不匹配 → 原版 145 只怪中有 26 只带前缀（精英/神兽/深蓝/巨型）
 *   的击杀**永远不计入熟练度**（原版缺陷）。此处按读取侧意图统一，
 *   使前缀怪与普通怪共用同一份熟练度，功能才真正可用。
 * · 存储落在系统配置 `game.globalMarkers`（type=json），键为
 *   `Record<"<名称>熟练度", number>`。原版是"内存为准 + 定期落盘"，
 *   本实现同构：内存权威、定时脏写回，避免每次击杀都打一次库。
 *
 * 单一实现约束：等级公式与熟练度累加只在此处维护；
 * 调用方（map.service 生成怪物、combat-system 结算击杀、面板/图鉴展示）
 * 一律经本服务，禁止各自 `Math.sqrt` 或自行拼 `xxx熟练度` 键。
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { stripSpeciesPrefix } from './species-prefix.util';

/** 系统配置键：原版「全局标记」的落库位置 */
export const GLOBAL_MARKERS_KEY = 'game.globalMarkers';
/** 已被取代的旧配置键：原版语义下世界等级是熟练度换算结果，不是可直接设定的配置 */
const LEGACY_WORLD_LEVEL_KEY = 'game.worldLevel';
/** 世界熟练度的条目名（换算时自动补 `熟练度` 后缀 → `世界熟练度`） */
export const WORLD_PROFICIENCY_NAME = '世界';
/** 熟练度条目后缀（原版 添加成就(名称 + "熟练度") / 显示熟练度等级 内部拼接） */
const PROFICIENCY_SUFFIX = '熟练度';
/** 脏数据回写间隔：原版同样是"内存累计 + 定期保存"，避免逐次击杀打库 */
const FLUSH_INTERVAL_MS = 10_000;

/**
 * 原版 显示熟练度等级（数据显示.ecode L1640-1665）的纯函数形式：
 * 最小 a 使 点数 < a²，等价于 floor(√点数) + 1（点数 0 → 1）。
 */
export function proficiencyLevelFromPoints(points: number): number {
  const safe = Number.isFinite(points) && points > 0 ? points : 0;
  return Math.floor(Math.sqrt(safe)) + 1;
}

/**
 * 原版怪物等级的优先规则（加成计算.ecode L2709-2716 / L2793-2807），纯函数：
 *   1. 显式等级（召唤物「强制等级」/ 管理员刷新怪物，`options.level`）；
 *   2. 配置等级 > 0（原版 L2710 / L2797 的短路分支）；
 *   3. 动态公式结果（物种熟练度等级 + 世界熟练度等级）。
 * 抽成单一实现供 map.service（刷怪）与 handbook（图鉴展示）共用，
 * 避免"面板显示"与"实际刷怪"两处口径漂移。
 */
export function pickMonsterLevel(opts: {
  explicitLevel?: number | null;
  configuredLevel?: number | null;
  dynamicLevel: number;
}): number {
  const explicit = Number(opts.explicitLevel);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const configured = Number(opts.configuredLevel);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return opts.dynamicLevel;
}

@Injectable()
export class GlobalProficiencyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GlobalProficiencyService.name);

  /** 内存权威表：`<名称>熟练度` → 点数（原版 全局标记 的等价物） */
  private points = new Map<string, number>();
  /** 懒加载去重：并发首访只打一次库 */
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  /** 是否存在未落盘的增量 */
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // 启动即加载，避免首场战斗的累加落在未初始化的空表上
    await this.ensureLoaded();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // 不因该定时器阻止进程退出（Nest 关闭时另有 onModuleDestroy 兜底落盘）
    this.flushTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /** 确保内存表已从库中加载（幂等、并发安全） */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.load().catch((err: any) => {
        // 加载失败不抛：按空表继续（等级退化为基线 2 级），并在下次访问时重试
        this.loadPromise = null;
        this.logger.error(`全局熟练度加载失败，暂按空表运行: ${err?.message ?? err}`);
      });
    }
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key: GLOBAL_MARKERS_KEY } });
    let raw: Record<string, any> = {};
    let migratedFromLegacy = false;
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
      } catch {
        this.logger.warn(`全局熟练度配置解析失败，按空表重建: ${row.value?.slice(0, 120)}`);
      }
    } else {
      raw = await this.migrateLegacyWorldLevel();
      migratedFromLegacy = Object.keys(raw).length > 0;
    }

    this.points = new Map<string, number>();
    for (const [key, value] of Object.entries(raw)) {
      const num = Number(value);
      if (Number.isFinite(num) && num !== 0) this.points.set(key, num);
    }
    this.loaded = true;
    // 迁移结果必须立刻落库：旧键已被删除，若只留在内存，进程重启即丢失世界等级
    if (migratedFromLegacy) {
      this.dirty = true;
      await this.flush();
    }
    this.logger.log(`全局熟练度已加载：${this.points.size} 条`);
  }

  /**
   * 一次性迁移：旧版把世界等级存成可直接设置的 `game.worldLevel`，
   * 原版语义下它是 `世界熟练度` 的换算结果。按 `显示熟练度等级` 的逆运算
   * 取 `(等级-1)²` 作为点数（floor(√((L-1)²))+1 = L），迁移后删除旧键，
   * 保证世界等级只有一个真相源。
   */
  private async migrateLegacyWorldLevel(): Promise<Record<string, any>> {
    let legacyPoints = 0;
    try {
      const legacy = await this.prisma.systemConfig.findUnique({
        where: { key: LEGACY_WORLD_LEVEL_KEY },
      });
      if (legacy) {
        const level = Math.max(1, Math.floor(Number(legacy.value) || 1));
        legacyPoints = (level - 1) ** 2;
        await this.prisma.systemConfig.delete({ where: { key: LEGACY_WORLD_LEVEL_KEY } });
        this.logger.log(
          `已迁移旧配置 ${LEGACY_WORLD_LEVEL_KEY}=${level} → ${WORLD_PROFICIENCY_NAME}${PROFICIENCY_SUFFIX}=${legacyPoints}，并移除旧键`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`旧世界等级配置迁移失败（忽略）: ${err?.message ?? err}`);
    }
    return legacyPoints > 0 ? { [`${WORLD_PROFICIENCY_NAME}${PROFICIENCY_SUFFIX}`]: legacyPoints } : {};
  }

  /** 原版 添加成就(名称+"熟练度", 数值, 全局标记)：累加点数并安排落盘 */
  async addProficiency(name: string, delta: number): Promise<void> {
    if (!Number.isFinite(delta) || delta === 0) return;
    await this.ensureLoaded();
    const key = this.pointsKey(name);
    if (!key) return;
    const next = (this.points.get(key) ?? 0) + delta;
    if (next <= 0) {
      // 与原版 添加成就 一致：减到非正即移除条目
      this.points.delete(key);
    } else {
      this.points.set(key, next);
    }
    this.dirty = true;
  }

  /** 原版 取成就熟练度(全局标记, 名称+"熟练度") */
  async getPoints(name: string): Promise<number> {
    await this.ensureLoaded();
    return this.pointsSync(name);
  }

  /** 原版 显示熟练度等级(全局标记, 名称)：floor(√点数) + 1 */
  async proficiencyLevel(name: string): Promise<number> {
    return proficiencyLevelFromPoints(await this.getPoints(name));
  }

  /** 原版 显示熟练度等级(全局标记, "世界") */
  async worldLevel(): Promise<number> {
    return this.proficiencyLevel(WORLD_PROFICIENCY_NAME);
  }

  /**
   * 原版 加成计算 L2711 / L2796 的怪物等级动态分支：
   * `显示熟练度等级(全局标记, 物种名, 去物种前缀=真) + 显示熟练度等级(全局标记, "世界")`
   */
  async monsterLevel(monsterName: string): Promise<number> {
    await this.ensureLoaded();
    return this.monsterLevelSync(monsterName);
  }

  // ==================== 同步视图（供同步渲染代码使用）====================
  // 公式仍只有一份（proficiencyLevelFromPoints），异步方法只是它的 await 包装。
  // 调用方必须先 await ensureLoaded()；未加载时按 0 计数（等价原版无该标记）。

  /** 同步读点数（须先 ensureLoaded） */
  pointsSync(name: string): number {
    const key = this.pointsKey(name);
    return key ? (this.points.get(key) ?? 0) : 0;
  }

  /** 同步算等级（须先 ensureLoaded） */
  levelSync(name: string): number {
    return proficiencyLevelFromPoints(this.pointsSync(name));
  }

  /** 同步算动态怪物等级（须先 ensureLoaded） */
  monsterLevelSync(monsterName: string): number {
    return this.levelSync(stripSpeciesPrefix(monsterName))
      + this.levelSync(WORLD_PROFICIENCY_NAME);
  }

  /** 同步取世界等级（须先 ensureLoaded） */
  worldLevelSync(): number {
    return this.levelSync(WORLD_PROFICIENCY_NAME);
  }

  /** 管理员设定世界等级：按逆运算写回 `世界熟练度` 点数，保持单一真相源 */
  async setWorldLevel(level: number): Promise<number> {
    const normalized = Math.max(1, Math.floor(Number(level) || 1));
    await this.ensureLoaded();
    const key = this.pointsKey(WORLD_PROFICIENCY_NAME);
    this.points.set(key, (normalized - 1) ** 2);
    this.dirty = true;
    await this.flush();
    return normalized;
  }

  /** 全量快照（只读，供诊断/展示；返回副本避免调用方就地改） */
  async snapshot(): Promise<Record<string, number>> {
    await this.ensureLoaded();
    return Object.fromEntries(this.points.entries());
  }

  /** 落盘：仅在存在增量时写库 */
  async flush(): Promise<void> {
    if (!this.dirty || !this.loaded) return;
    this.dirty = false;
    const payload = JSON.stringify(Object.fromEntries(this.points.entries()));
    try {
      const existing = await this.prisma.systemConfig.findUnique({
        where: { key: GLOBAL_MARKERS_KEY },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.systemConfig.update({
          where: { key: GLOBAL_MARKERS_KEY },
          data: { value: payload },
        });
      } else {
        // 直接落库而非走 SystemConfigService.set：后者对**新行**按值推断类型，
        // 会把 JSON 文本存成 type=string（解析分支失效）。此处显式声明 json。
        await this.prisma.systemConfig.create({
          data: {
            key: GLOBAL_MARKERS_KEY,
            value: payload,
            type: 'json',
            label: '全局熟练度（原版 全局标记）',
            description: '怪物/世界熟练度点数，由击杀自动累积；世界等级 = floor(√世界熟练度)+1',
            group: 'game',
          },
        });
      }
    } catch (err: any) {
      // 落盘失败要保留脏标记，等待下一次定时回写，否则本次增量永久丢失
      this.dirty = true;
      this.logger.error(`全局熟练度落盘失败（保留待回写）: ${err?.message ?? err}`);
    }
  }

  /** 条目键：与原版 添加成就(名称+"熟练度") 同构；名称已含后缀时不重复拼接 */
  private pointsKey(name: string): string {
    // 按基名归一（精英史莱姆 → 史莱姆），与读取侧 显示熟练度等级(去物种前缀=真) 对齐；
    // 否则写入键与读取键不匹配，前缀怪的击杀将永不生效（原版缺陷，见文件头说明）。
    const base = stripSpeciesPrefix(String(name ?? '').trim());
    if (!base) return '';
    return base.endsWith(PROFICIENCY_SUFFIX) ? base : `${base}${PROFICIENCY_SUFFIX}`;
  }
}
