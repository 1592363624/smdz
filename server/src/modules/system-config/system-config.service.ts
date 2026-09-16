/**
 * 系统配置中心服务
 * 集中管理所有可通过管理员界面在线调整的配置项(指令前缀、游戏数值、功能开关等)。
 * 配置存数据库 SystemConfig 表，修改后立即生效，无需重启服务。
 *
 * 遵循"配置项抽取"原则：业务逻辑中所有可能变化的常量都通过这里管理。
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
// 签到奖励默认规则（纯常量模块，无服务依赖，不会引入循环依赖）
import {
  CHECKIN_BASE_EXP_KEY,
  CHECKIN_CONSECUTIVE_EXP_MAX_DAYS_KEY,
  CHECKIN_CONSECUTIVE_EXP_PER_DAY_KEY,
  CHECKIN_REWARDS_KEY,
  DEFAULT_CHECKIN_BASE_EXP,
  DEFAULT_CHECKIN_CONSECUTIVE_EXP_MAX_DAYS,
  DEFAULT_CHECKIN_CONSECUTIVE_EXP_PER_DAY,
  DEFAULT_CHECKIN_REWARDS_JSON,
  LEGACY_CHECKIN_REWARDS_JSON,
} from '../game/checkin-config.defaults';
// 世界红包默认配置（纯常量模块：有效期/份数上限/可发放范围等，管理员可在线调整）
import {
  DEFAULT_RED_PACKET_CONFIG,
  DEFAULT_RED_PACKET_CONFIG_JSON,
  RED_PACKET_CONFIG_KEY,
  RedPacketConfig,
  normalizeRedPacketConfig,
} from '../../config/red-packet.config';

/** 新增配置项的默认定义：启动时若库中缺失则自动补行，无需重跑 seed */
interface SystemConfigDefault {
  key: string;
  value: string;
  label: string;
  description: string;
  type: string;
  group: string;
}

/// 私密消息规则表中「其他玩家看到的占位文本」的默认值（规则未填时使用）
const DEFAULT_PRIVATE_PLACEHOLDER = '🔒 该消息为私密消息';

/// 历史版本的占位文案（未带锁图标），用于把旧配置值升级为新版默认值
const LEGACY_PRIVATE_PLACEHOLDER = '该消息为私密消息';

/// 全新部署时默认纳入私密的指令（探测系列：结果属高价值情报，公开会被他人白嫖）
const DEFAULT_PRIVATE_COMMANDS = ['探测雷达', '探测资源', '探测拾取', '探测作物'];

/// 私密消息规则表的默认值：每条规则 = { command: 指令名, placeholder: 占位文本 }
const DEFAULT_PRIVATE_RULES_JSON = JSON.stringify(
  DEFAULT_PRIVATE_COMMANDS.map((command) => ({
    command,
    placeholder: DEFAULT_PRIVATE_PLACEHOLDER,
  })),
);

/// 0/12/18 点「生成副本」第 1 个入口的副本名池（原版 使魔大战.txt [商店]副本）
const DEFAULT_INSTANCE_NAMES_JSON = JSON.stringify([
  'CELL研究中心', 'CELL总部', 'CELL后勤部', '组装车间',
]);

/// 第 2 个入口的副本名池（原版 使魔大战.txt [商店]副本2）
const DEFAULT_INSTANCE_NAMES2_JSON = JSON.stringify([
  '灭绝之地', '誓约之地', '核战废墟', '灵山岛', '四圣祭坛',
]);

const DEFAULT_CONFIGS: SystemConfigDefault[] = [
  {
    key: 'game.dungeonEntryLifetimeHours',
    value: '24',
    label: '副本入口有效期(小时)',
    description:
      '副本入口从开启时刻起算的有效期；到期后入口自动关闭（迁移副本内玩家并清怪重刷）。重启不清空，按剩余时间继续倒计时',
    type: 'number',
    group: 'game',
  },
  {
    key: 'game.instanceNames',
    value: DEFAULT_INSTANCE_NAMES_JSON,
    label: '定时副本名池1',
    description:
      '0/12/18 点「生成副本」第 1 个入口随机取的副本名；必须是地图表中真实存在的地图名，否则入口进不去（无效名字会被自动过滤）',
    type: 'json',
    group: 'game',
  },
  {
    key: 'game.instanceNames2',
    value: DEFAULT_INSTANCE_NAMES2_JSON,
    label: '定时副本名池2',
    description:
      '0/12/18 点「生成副本」第 2 个入口随机取的副本名（原版 [商店]副本2）；同样必须是真实地图名',
    type: 'json',
    group: 'game',
  },
  {
    key: CHECKIN_BASE_EXP_KEY,
    value: String(DEFAULT_CHECKIN_BASE_EXP),
    label: '签到基础经验',
    description:
      '每次签到固定获得的经验；连续加成另算（总经验 = 基础经验 + 连续天数加成）',
    type: 'number',
    group: 'game',
  },
  {
    key: CHECKIN_CONSECUTIVE_EXP_PER_DAY_KEY,
    value: String(DEFAULT_CHECKIN_CONSECUTIVE_EXP_PER_DAY),
    label: '签到每连续1天额外经验',
    description: '连续签到每多 1 天额外增加的经验；设为 0 则取消连续加成',
    type: 'number',
    group: 'game',
  },
  {
    key: CHECKIN_CONSECUTIVE_EXP_MAX_DAYS_KEY,
    value: String(DEFAULT_CHECKIN_CONSECUTIVE_EXP_MAX_DAYS),
    label: '签到连续加成封顶天数',
    description:
      '连续签到经验加成的天数上限（超过该天数不再累加）；0 = 不封顶',
    type: 'number',
    group: 'game',
  },
  {
    key: CHECKIN_REWARDS_KEY,
    value: DEFAULT_CHECKIN_REWARDS_JSON,
    label: '签到奖励表',
    description:
      '配置「哪天给什么东西」：每日奖励（按连续第 N 天，可设循环周期）、连续签到里程碑、累计签到里程碑；奖励类型支持物品/经验/活力',
    type: 'json',
    group: 'game',
  },
  {
    key: 'game.wreckSpawnHour',
    value: '10',
    label: '废弃载具刷新小时',
    description:
      '每天在该整点小时自动刷新废弃载具（0-23）。默认 10。改后下次到点即生效，无需重启。设为 -1 可关闭自动刷新',
    type: 'number',
    group: 'game',
  },
  {
    key: 'game.wreckMaxCount',
    value: '3',
    label: '废弃载具全图上限',
    description:
      '所有地图上无主废弃载具的总数量上限；达到上限后不再自动刷新（管理员指令不受限）。默认 3，0=不限制',
    type: 'number',
    group: 'game',
  },
  {
    key: 'chat.messageIntervalSec',
    value: '0.2',
    label: '用户消息发送间隔(秒)',
    description: '同一用户两条消息之间的最小间隔，防止刷屏；0=不限制',
    type: 'number',
    group: 'command',
  },
  {
    key: 'chat.privateMessages',
    value: DEFAULT_PRIVATE_RULES_JSON,
    label: '私密消息规则',
    description:
      '列表内指令的结果仅发送者本人可见，其他玩家只见对应的占位文本（防止他人白嫖探测雷达等情报）',
    type: 'json',
    group: 'command',
  },
  {
    key: RED_PACKET_CONFIG_KEY,
    value: DEFAULT_RED_PACKET_CONFIG_JSON,
    label: '世界红包',
    description:
      '红包有效期(小时)、单个红包道具种类/份数上限、祝福语长度、是否允许放装备或硬通货等。' +
      '格式：{"expireHours":24,"maxItemKinds":10,"maxTotalCount":100,"minTotalCount":1,' +
      '"maxGreetingLength":60,"allowEquipment":false,"allowCurrency":false,"historyHours":72}',
    type: 'json',
    group: 'command',
  },
];

@Injectable()
export class SystemConfigService implements OnModuleInit {
  private readonly logger = new Logger(SystemConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureDefaultConfigs();
  }

  /**
   * 把 DEFAULT_CONFIGS 中库中尚不存在的键补进去（update:{} 不覆盖管理员改过的值）。
   * 用于「代码新增了配置项，但老库没重跑 seed」的场景，保证管理界面能立刻看到。
   * 已存在的行只纠正 group/label/description，不动 value。
   */
  private async ensureDefaultConfigs(): Promise<void> {
    for (const cfg of DEFAULT_CONFIGS) {
      try {
        const existing = await this.prisma.systemConfig.findUnique({ where: { key: cfg.key } });
        if (!existing) {
          // 私密消息规则首次创建：把旧版「私密指令名单 + 占位文本」两项迁移合并进来，
          // 并删除旧行，避免管理界面出现两个重复的私密配置卡片。
          if (cfg.key === 'chat.privateMessages') {
            const merged = await this.buildInitialPrivateRules();
            await this.prisma.systemConfig.create({ data: { ...cfg, value: merged } });
            await this.prisma.systemConfig.deleteMany({
              where: { key: { in: ['chat.privateCommands', 'chat.privatePlaceholder'] } },
            });
            continue;
          }
          await this.prisma.systemConfig.create({ data: { ...cfg } });
          continue;
        }
        if (
          existing.group !== cfg.group ||
          existing.label !== cfg.label ||
          existing.description !== cfg.description
        ) {
          await this.prisma.systemConfig.update({
            where: { key: cfg.key },
            data: { group: cfg.group, label: cfg.label, description: cfg.description },
          });
          this.cache.delete(cfg.key);
        }
        // 消息间隔：旧默认 0.5 迁到 0.2（仅当库中仍是旧默认时；管理员改过的其他值不动）
        if (cfg.key === 'chat.messageIntervalSec' && Number(existing.value) === 0.5) {
          await this.prisma.systemConfig.update({
            where: { key: cfg.key },
            data: { value: cfg.value },
          });
          this.cache.delete(cfg.key);
        }
        // 私密占位文案升级：旧默认未带锁图标 → 补 🔒（管理员自定义过的文案不动）
        if (cfg.key === 'chat.privateMessages') {
          await this.upgradePrivatePlaceholder(existing);
        }
        // 签到奖励表升级：初版默认含「签到礼包/累计签到礼包」，但物品表中并不存在这两个道具，
        // 属于历史残留 → 改为默认空表。仅「恰好等于旧默认」的行被改写，管理员自定义过的表不动。
        if (cfg.key === CHECKIN_REWARDS_KEY && existing.value === LEGACY_CHECKIN_REWARDS_JSON) {
          await this.prisma.systemConfig.update({
            where: { key: cfg.key },
            data: { value: cfg.value },
          });
          this.cache.delete(cfg.key);
          this.logger.log('已升级签到奖励默认表（移除道具表中不存在的礼包物品）');
        }
      } catch (err: any) {
        this.logger.warn(`补默认配置 ${cfg.key} 失败: ${err?.message ?? err}`);
      }
    }
  }

  /**
   * 构造「私密消息规则」的初始值（仅首次创建该配置时调用）。
   * 兼容旧版两个配置项（chat.privateCommands 名单 + chat.privatePlaceholder 占位文本）：
   * 把旧名单全部并入，占位文本沿用旧值；再补齐内置默认的探测系列指令。
   * @returns JSON 字符串：[{ command, placeholder }, ...]
   */
  private async buildInitialPrivateRules(): Promise<string> {
    const [listRow, phRow] = await Promise.all([
      this.prisma.systemConfig.findUnique({ where: { key: 'chat.privateCommands' } }),
      this.prisma.systemConfig.findUnique({ where: { key: 'chat.privatePlaceholder' } }),
    ]);
    const placeholder = (phRow?.value || '').trim() || DEFAULT_PRIVATE_PLACEHOLDER;
    const commands = new Set<string>();
    // 旧名单解析：兼容 JSON 数组与逗号/顿号分隔两种历史格式
    if (listRow?.value) {
      try {
        const parsed = JSON.parse(listRow.value);
        if (Array.isArray(parsed)) {
          parsed.forEach((c) => String(c).trim() && commands.add(String(c).trim()));
        }
      } catch {
        listRow.value
          .split(/[,，、\s]+/)
          .forEach((c) => c.trim() && commands.add(c.trim()));
      }
    }
    DEFAULT_PRIVATE_COMMANDS.forEach((c) => commands.add(c));
    return JSON.stringify(Array.from(commands).map((command) => ({ command, placeholder })));
  }

  /**
   * 占位文案升级：旧默认「该消息为私密消息」未带锁图标，统一补 🔒 前缀。
   * 仅「恰好等于旧默认文案」的规则被改写，管理员自定义的其他文案保持不动。
   */
  private async upgradePrivatePlaceholder(row: { value: string }): Promise<void> {
    if (!row?.value) return;
    try {
      const rules = this.parsePrivateRules(row.value);
      let changed = false;
      const next = rules.map((r) => {
        if (r.placeholder === LEGACY_PRIVATE_PLACEHOLDER) {
          changed = true;
          return { ...r, placeholder: DEFAULT_PRIVATE_PLACEHOLDER };
        }
        return r;
      });
      if (!changed) return;
      await this.prisma.systemConfig.update({
        where: { key: 'chat.privateMessages' },
        data: { value: JSON.stringify(next) },
      });
      this.cache.delete('chat.privateMessages');
      this.logger.log('已升级私密消息占位文案（补齐 🔒 标记）');
    } catch (err: any) {
      this.logger.warn(`升级私密消息占位文案失败: ${err?.message ?? err}`);
    }
  }

  /**
   * 配置行内存缓存（key → 行），TTL 内免打库。
   * SystemConfig 表极小且变更频率极低，但 getCommandPrefixes 等热点读取
   * 在「每条消息」的指令判定路径上——远程库下每次往返都直接叠加到回复延迟。
   * set() 写库后主动失效对应 key，保证"管理员改完立即生效"。
   */
  private static readonly CACHE_TTL_MS = 5000;
  private readonly cache = new Map<string, { row: any; at: number }>();

  /**
   * 获取所有配置项
   * 注意：`game.globalMarkers`（全局熟练度）也会返回——管理界面用专用表格编辑器展示，
   * 不要改成裸 JSON 文本框。
   */
  async findAll() {
    return this.prisma.systemConfig.findMany({ orderBy: { id: 'asc' } });
  }

  /**
   * 获取单个配置项的原始记录（带 TTL 缓存）
   */
  async findByKey(key: string) {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < SystemConfigService.CACHE_TTL_MS) {
      return hit.row;
    }
    const row = await this.prisma.systemConfig.findUnique({ where: { key } });
    this.cache.set(key, { row, at: now });
    return row;
  }

  /**
   * 读取配置值(自动解析为对应类型)
   * @param key 配置键
   * @param defaultValue 不存在时的默认值
   */
  async get<T = any>(key: string, defaultValue: T): Promise<T> {
    const row = await this.findByKey(key);
    if (!row) return defaultValue;
    return this.parseValue<T>(row.type, row.value, defaultValue);
  }

  /**
   * 批量读取配置
   */
  async getMany<T = any>(keys: string[]): Promise<Record<string, T>> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: keys } },
    });
    const result: Record<string, T> = {};
    for (const row of rows) {
      result[row.key] = this.parseValue<T>(row.type, row.value, undefined as any);
    }
    return result;
  }

  /**
   * 更新配置值(按类型校验/解析)
   * 行不存在时自动创建（type 按 key 前缀推断分组，值类型默认 string），
   * 让新增配置项无需先跑 seed 即可在管理界面直接保存生效。
   */
  async set(key: string, value: any) {
    const row = await this.findByKey(key);
    // 按类型序列化
    let serialized: string;
    let type: string;
    if (row) {
      type = row.type;
      switch (type) {
        case 'number':
          serialized = String(Number(value));
          break;
        case 'boolean':
          serialized = value === true || value === 'true' ? 'true' : 'false';
          break;
        case 'json':
          serialized = typeof value === 'string' ? value : JSON.stringify(value);
          break;
        case 'string-array':
          serialized = Array.isArray(value) ? JSON.stringify(value) : JSON.stringify(String(value).split(','));
          break;
        default: // string
          serialized = String(value);
      }
      const updated = await this.prisma.systemConfig.update({ where: { key }, data: { value: serialized } });
      // 写库成功后失效缓存，管理员改完立即生效（不依赖 TTL 到期）
      this.cache.delete(key);
      return updated;
    }
    // 行不存在 → 自动创建：type 先按传入值推断（number/boolean 可识别，其余按 string），
    // group 取 key 第一段（如 web.handbookTooltipDelayMs → web），便于管理界面分组展示。
    serialized = String(value);
    type =
      typeof value === 'number' || (typeof value === 'string' && value !== '' && !Number.isNaN(Number(value)))
        ? 'number'
        : typeof value === 'boolean' || value === 'true' || value === 'false'
          ? 'boolean'
          : 'string';
    const created = await this.prisma.systemConfig.create({
      data: {
        key,
        value: serialized,
        type,
        label: key,
        description: '（自动创建）管理界面可修改显示名与描述',
        group: key.split('.')[0] || 'system',
      } as any,
    });
    this.cache.delete(key);
    return created;
  }

  /**
   * 快捷读取：指令前缀列表
   */
  getCommandPrefixes(): Promise<string[]> {
    return this.get<string[]>('command.prefixes', ['/', '！', '!']);
  }

  /**
   * 快捷读取：是否必须带前缀才算指令
   */
  getCommandRequirePrefix(): Promise<boolean> {
    return this.get<boolean>('command.requirePrefix', false);
  }

  /**
   * 快捷读取：用户发消息最小间隔（秒）。0=不限制。
   * 防止刷屏；管理员可在「系统配置 → 指令设置」在线调整。
   */
  getMessageIntervalSec(): Promise<number> {
    return this.get<number>('chat.messageIntervalSec', 0.2);
  }

  /**
   * 快捷读取：世界红包配置（有效期、份数上限、可发放范围等）。
   * 管理员在「系统配置 → 世界红包」在线调整；缺失/格式损坏时回退代码默认值。
   */
  async getRedPacketConfig(): Promise<RedPacketConfig> {
    try {
      const raw = await this.get<any>(RED_PACKET_CONFIG_KEY, DEFAULT_RED_PACKET_CONFIG);
      return normalizeRedPacketConfig(raw);
    } catch {
      // 读配置失败不应阻断发红包主链路，退回代码默认值
      return { ...DEFAULT_RED_PACKET_CONFIG };
    }
  }

  /**
   * 快捷读取：私密消息规则列表（[{ command, placeholder }]）。
   * 列表中指令的结果仅发送者本人可见，其他玩家只见对应的占位文本。
   * 用于探测系列等高价值情报指令，防止他人白嫖他人探测结果。
   */
  async getPrivateMessages(): Promise<Array<{ command: string; placeholder: string }>> {
    const raw = await this.get<any>('chat.privateMessages', []);
    return this.parsePrivateRules(raw);
  }

  /**
   * 解析私密消息规则：容错处理（JSON 字符串/数组、缺字段、空指令），
   * 占位文本缺省时回退内置默认值。
   */
  private parsePrivateRules(raw: any): Array<{ command: string; placeholder: string }> {
    let arr = raw;
    if (typeof raw === 'string') {
      try {
        arr = JSON.parse(raw);
      } catch {
        arr = [];
      }
    }
    if (!Array.isArray(arr)) return [];
    return arr
      .map((r: any) => ({
        command: String(r?.command ?? '').trim(),
        placeholder: String(r?.placeholder ?? '').trim() || DEFAULT_PRIVATE_PLACEHOLDER,
      }))
      .filter((r) => r.command);
  }

  /**
   * 按配置类型解析存储值
   */
  private parseValue<T>(type: string, raw: string, defaultValue: T): T {
    if (raw === '' && raw === undefined) return defaultValue;
    switch (type) {
      case 'number': {
        // 注意：0 是合法值（如「不限制」「立即弹出」），不能用 || 回退默认值
        const n = Number(raw);
        return (Number.isFinite(n) ? n : defaultValue) as T;
      }
      case 'boolean':
        return (raw === 'true') as T;
      case 'json':
      case 'string-array': {
        try {
          return JSON.parse(raw) as T;
        } catch {
          return defaultValue;
        }
      }
      default:
        return (raw ?? defaultValue) as T;
    }
  }
}
