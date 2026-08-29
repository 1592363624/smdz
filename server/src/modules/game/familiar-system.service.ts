/**
 * 使魔/宠物子系统
 * 对应原版：使魔技能.ecode + 使魔家园.ecode + _主程序.ecode 中宠物相关命令
 * 完整实现：使魔选择/召唤/命名/技能/家园 + 宠物改名/转让/驾驶/喂食/嗅探/捕捉
 */

import { forwardRef, Inject, Injectable, Logger, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { BonusService, BonusData } from './bonus.service';
import { StaticDataService } from './static-data.service';
import { TaskService } from './task.service';
import { MapService } from './map.service';
import { CombatSystemService } from './combat-system.service';
import { HomeService } from './home.service';
import { ItemSystemService } from './item-system.service';
import { FamiliarSkillsService } from './familiar-skills.service';
import { hasActive } from './expire-time.util';

/**
 * 召唤物/宠物实例（与现有 FamiliarService 中的 SummonUnit 一致）
 */
export interface SummonUnit {
  specialSeq: number;
  name: string;
  affinity?: number;
  level?: number;
  id?: string;
  /** 归属者QQ */
  ownerQQ?: string;
  /** 当前地图上的召唤物标识 */
  qq?: string;
  /** 类型 */
  type?: string;
  /** 当前生命值 */
  hp?: number;
  /** 战斗力 */
  combatPower?: number;
  /** === 原版召唤物为"玩家2实例"，携带完整玩家级数组（对应 _主程序.ecode L9783 重定义数组） === */
  /** 对召唤者好感（原版 添加成就("好感"+玩家.QQ, 30)） */
  好感?: number;
  /** 剧情房子（原版 玩家2.房子 = 对话列表[1].任务） */
  房子?: string;
  /** 成就数组 */
  成就?: any[];
  /** 背包数组 */
  背包?: any[];
  /** 增益数组 */
  增益?: any[];
  /** 武器数组 */
  武器?: any[];
  /** 装备数组 */
  装备?: any[];
  /** 标记2数组 */
  标记2?: any[];
  /** 标记数组 */
  标记?: any[];
  /** 任务数组 */
  任务?: any[];
  /** 装备预设数组 */
  装备预设?: any[];
}

/**
 * 商店物品定义
 */
export interface ShopItem {
  name: string;
  cost: number;
  costType: '钻石' | 'activity' | 'dataCore';
  description?: string;
}

/**
 * 家园状态
 */
export interface HomeStatus {
  progress: number;       // 0=未开始 1=清空地面 2=开挖地基 3=建造房子 4=完成
  name: string;
  mapId: number;
  music?: string;
}

/**
 * 生产者（资源1类型），用于产出计算
 * 对应原版 ecode 资源1 数据类型
 */
export interface Producer {
  name: string;
  /** 产出物品列表 */
  outputs: OutputItem[];
  /** 优先级：1=作物 2=建筑 3=特殊 */
  priority: number;
  /** 数量（建筑/作物数量） */
  count: number;
  /** 是否不占建筑数量上限 */
  noOccupancy?: boolean;
}

/**
 * 产出物品
 */
export interface OutputItem {
  name: string;
  count: number;
}

@Injectable()
export class FamiliarSystemService {
  private readonly logger = new Logger(FamiliarSystemService.name);

  /** 狩猎宠物类型列表 */
  private readonly huntingPetTypes = ['常春藤', '狼', '虎', '巨齿鲨'];

  /** 禁止改名的名字 */
  private readonly forbiddenNames = ['白', '行商', '花园宝宝', '小白狐'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly bonusService: BonusService,
    private readonly staticData: StaticDataService,
    private readonly taskService: TaskService,
    private readonly mapService: MapService,
    // 三方循环依赖（system→combat→skills→system）会破坏 design:paramtypes 元数据，
    // 环上每条边都必须显式 @Inject(forwardRef())，否则该参数解析为 Object。
    @Inject(forwardRef(() => CombatSystemService))
    private readonly combatSystem: CombatSystemService,
    @Optional() private readonly homeService?: HomeService,
    @Optional() private readonly itemSystem?: ItemSystemService,
    @Inject(forwardRef(() => FamiliarSkillsService))
    @Optional() private readonly familiarSkills?: FamiliarSkillsService,
    // P2 写入口收口：兑换等读改写路径逐步迁到 mutate 管道（锁+新鲜快照+审计）。
    // Optional 末位参数，旧测试桩不传也不受影响。
    @Optional() private readonly mutateService?: any,
  ) {}

  // ==================== 使魔基础操作 ====================

  /**
   * 选择/更换使魔
   * 对应原版：选择使魔/更换使魔()
   * 更换玩家的使魔类型，需要已拥有该使魔（好感度 > 0）
   * @param userId 用户ID
   * @param familiarName 使魔名称
   * @returns 操作结果文本
   */
  async selectFamiliar(userId: number, familiarName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // ========== 无参数：列出可选使魔（对应原版 L766-775） ==========
    if (!familiarName || familiarName.trim() === '') {
      // 新玩家（未开始游戏）：列出所有可召唤使魔供选择
      if (!player.type) {
        const allFamiliars = this.staticData.getAllFamiliars().filter((f: any) => !f.noSummon);
        const lines: string[] = [
          `${player.name || '冒险者'} 选择你的第一个使魔来开始游戏：`,
          `━━━━━━━━━━━━━━━`,
        ];
        const options: { label: string; cmd: string }[] = [];
        for (const f of allFamiliars) {
          const name = f.name || '未知';
          lines.push(`  ${options.length + 1}. ${name}`);
          options.push({ label: name, cmd: `选择使魔${name}` });
        }
        lines.push(`━━━━━━━━━━━━━━━`);
        // 直接返回文本即可（消息入口已有门禁拦截，此处补充指令本身触发的情况）
        return lines.join('\n');
      }

      // 老玩家：列出已拥有好感>0的使魔（对应原版 L766-775）
      const lines: string[] = [
        `${player.name || '冒险者'} 选择你想更换的使魔，背包和等级等数据不会清空`,
        `━━━━━━━━━━━━━━━`,
      ];
      const options: { label: string; cmd: string }[] = [];
      const allFamiliars = this.staticData.getAllFamiliars();
      for (const f of allFamiliars) {
        const name = f.name || '未知';
        const affinity = this.playerService.getMarkerValue(markers, `${name}好感`);
        if (affinity >= 1) {
          lines.push(`  ${options.length + 1}. ${name}`);
          options.push({ label: name, cmd: `选择使魔${name}` });
        }
      }
      if (options.length === 0) {
        lines.push(`  (尚未拥有任何使魔)`);
        lines.push(`━━━━━━━━━━━━━━━`);
        lines.push(`💡 你可以发送「召唤使魔」来解锁更多可更换的使魔`);
      } else {
        lines.push(`━━━━━━━━━━━━━━━`);
        lines.push(`💡 也可以发送「选择使魔 <名称>」直接选择`);
      }
      return lines.join('\n');
    }

    // 查找使魔定义（静态配置 JSON 单一来源）
    const familiar = this.staticData.getFamiliarByName(familiarName);
    if (!familiar) {
      return `不存在的使魔：${familiarName}`;
    }

    // ========== 新玩家首次选择使魔（对应原版 _主程序.ecode L686-722） ==========
    // 原版：新玩家(老玩家==假)第一次选择使魔 = 清空所有数据、设置角色、正式开局。
    // 判断依据：player.type 为空即尚未选择使魔开始游戏。
    if (!player.type) {
      // 清空初始化的所有玩家数据（对应原版 重定义数组 清空成就/标记/标记2/背包/装备/武器/任务/增益/装备预设）
      player.achievements = [];
      player.markers = { '活力2': 100, '使用活力': 0 };
      player.markers2 = [];
      player.backpack = [];
      player.equipment = [];
      player.weapons = [];
      player.tasks = [];
      player.buffs = [];
      player.equipmentPresets = [];

      // 设置角色为所选使魔（对应原版：玩家.类型/特殊序号/图片/特有技能）
      player.type = familiar.name;
      player.specialSeq = familiar.specialSeq;
      player.uniqueSkill = familiar.uniqueSkill || '';
      player.currentWeapon = 0;

      // 初始好感：兰音特殊序号为20，其他为1（对应原版 L704-708）
      const affinityKey = `${familiar.name}好感`;
      // 兰音 specialSeq 需按 JSON 实际值判断，原版用 #兰音 常量（序号23）
      const isLanyin = familiar.name === '兰音' || String(familiar.specialSeq) === '23';
      const initAffinity = isLanyin ? 20 : 1;
      markers[affinityKey] = initAffinity;
      // 同步到玩家 affinity 字段（战斗计算中按好感触发使魔专属效果，如伊卡洛斯好感≥20）
      player.affinity = initAffinity;

      // 初始等级/生命保持基础值，正式进入游戏
      player.level = player.level || 1;
      player.exp = 0;
      // 升级经验门槛按公式重算，避免沿用错误的存量值（如旧版 100）
      player.upgradeExp = player.upgradeExp || this.playerService.calcUpgradeExp(player.level);
      // 按原版 _计算玩家 公式重算基础战斗属性（1级：攻击10、生命上限≈52、护盾≈22、装甲≈32）
      // 对齐加成计算.ecode L1799-1833，使开局属性即符合等级成长公式
      this.playerService.recalcLevelStats(player);
      player.hp = player.maxHp;
      player.shield = player.maxShield;
      player.armor = player.maxArmor;

      // 标记已开始游戏（老玩家=真），并保存
      player.markers = JSON.stringify(markers);
      await this.playerService.savePlayer(player);

      // 开局立即发放新手教程任务，避免"选完使魔→查看任务→空列表"的引导断裂。
      // 对应原版 _主程序.ecode L11686-11692：新玩家自动领取"新手教程"任务。
      try {
        await this.taskService.initNewPlayerTasks(userId);
      } catch (e) {
        this.logger.warn(`开局发放新手任务失败: ${e.message}`);
      }

      return `选择为${familiar.name}开始游戏\n💡 使用「查看任务」查看任务`;
    }

    // 检查是否已拥有该使魔（好感度>0）
    const affinityKey = `${familiarName}好感`;
    const currentAffinity = this.playerService.getMarkerValue(markers, affinityKey);
    if (currentAffinity <= 0) {
      return `${player.name || '冒险者'} 你尚未获得该使魔「${familiarName}」\n请使用「召唤使魔」来获取新使魔`;
    }

    // 检查是否炮击模式
    if (player.attackMode === 1) {
      return `${player.name || '冒险者'} 炮击模式下不可以更换使魔`;
    }

    // 计算更换冷却时间（根据称号）
    const titles = this.playerService.safeJsonParse<any[]>(player.titles, []);
    const multiHandIV = titles.find((t: any) => t.name === '多面手IV');
    let cooldown = 900; // 默认15分钟
    if (multiHandIV) {
      cooldown = 300; // 多面手IV: 5分钟
    } else {
      const multiHandIII = titles.find((t: any) => t.name === '多面手III');
      const multiHandII = titles.find((t: any) => t.name === '多面手II');
      const multiHandI = titles.find((t: any) => t.name === '多面手I');
      if (multiHandIII) cooldown = 450;
      else if (multiHandII) cooldown = 600;
      else if (multiHandI) cooldown = 750;
    }

    // 检查是否为同一使魔
    if (player.type === familiarName) {
      return `${player.name || '冒险者'} 你上次换成${familiarName}还是上次`;
    }

    // 检查冷却
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const cooldownMarker = markers2.find((m: any) => m.name === '更换使魔');
    const now = Date.now() / 1000;
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      const remaining = Math.ceil(cooldownMarker.expireAt - now);
      return `${player.name || '冒险者'} 更换使魔冷却中，剩余${remaining}秒`;
    }

    // 如果是兰音，确保好感度至少20（兰音特殊序号=23，对齐原版 #兰音）
    const isLanyin = familiar.name === '兰音' || String(familiar.specialSeq) === '23';
    if (isLanyin && currentAffinity < 20) {
      // 自动补足到20
      markers[affinityKey] = 20;
    }

    // 执行更换
    player.type = familiarName;
    player.specialSeq = familiar.specialSeq;
    player.uniqueSkill = familiar.uniqueSkill || '';
    // 同步当前好感到 affinity 字段（战斗计算中按好感触发使魔专属效果）
    player.affinity = this.playerService.getMarkerValue(markers, affinityKey);

    // 设置冷却标记
    const newMarkers2 = markers2.filter((m: any) => m.name !== '更换使魔');
    newMarkers2.push({
      name: '更换使魔',
      expireAt: now + cooldown,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    // 增加活跃度
    const activity = this.playerService.getMarkerValue(markers, '活跃度');
    markers['活跃度'] = activity + 1;
    player.markers = JSON.stringify(markers);

    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '更换使魔');

    return `${player.name || '冒险者'} 从${player.type}更换为${familiarName}（冷却${Math.ceil(cooldown / 60)}分钟）`;
  }

  /**
   * 召唤使魔
   * 对应原版：召唤使魔()
   * 消耗召唤券随机获取新使魔
   * @param userId 用户ID
   * @param count 召唤次数
   * @returns 召唤结果文本
   */
  async summonFamiliar(userId: number, count: number = 1): Promise<string> {
    if (count < 1) {
      count = 1;
    }
    // 读券→扣券→写回必须全程持用户级共享锁，理由同 exchange。
    return this.playerService.withUserLock(userId, () =>
      this.applySummonFamiliar(userId, count));
  }

  /** 召唤的数据库读改写段（调用方需已持有用户级锁）。 */
  private async applySummonFamiliar(userId: number, count: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查召唤券数量
    const backpack = this.playerService.getBackpackItems(player);
    const ticketItem = backpack.find((item: any) => item.name === '召唤券');
    const ticketCount = ticketItem ? (ticketItem.count || 1) : 0;

    if (ticketCount < count) {
      return `${player.name || '冒险者'} 你的召唤券只有${ticketCount}，无法召唤${count}次\n你可以在商店兑换召唤券`;
    }

    // 获取所有可召唤的使魔（静态配置 JSON 单一来源）
    const allFamiliars = this.staticData.getAllFamiliars().filter((f) => !f.noSummon);

    if (allFamiliars.length === 0) {
      return '没有可召唤的使魔';
    }

    // 执行召唤
    const summonedItems: string[] = [];

    for (let i = 0; i < count; i++) {
      // 随机选择一个使魔
      const randomIndex = Math.floor(Math.random() * allFamiliars.length);
      const chosenFamiliar = allFamiliars[randomIndex];

      // 增加该使魔的好感度
      const affinityKey = `${chosenFamiliar.name}好感`;
      const currentAffinity = this.playerService.getMarkerValue(markers, affinityKey);
      markers[affinityKey] = currentAffinity + 1;

      summonedItems.push(chosenFamiliar.name);
    }

    // 扣除召唤券
    const newTicketCount = ticketCount - count;
    if (newTicketCount <= 0) {
      // 移除召唤券
      const idx = backpack.findIndex((item: any) => item.name === '召唤券');
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      ticketItem!.count = newTicketCount;
    }

    player.markers = JSON.stringify(markers);
    player.backpack = JSON.stringify(backpack);

    // 检查召唤冷却
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const cooldownMarker = markers2.find((m: any) => m.name === '召唤冷却');
    const now = Date.now() / 1000;
    if (!cooldownMarker || cooldownMarker.expireAt <= now) {
      // 活跃度+1
      const activity = this.playerService.getMarkerValue(markers, '活跃度');
      markers['活跃度'] = activity + 1;
      player.markers = JSON.stringify(markers);

      // 设置冷却
      const newMarkers2 = markers2.filter((m: any) => m.name !== '召唤冷却');
      newMarkers2.push({
        name: '召唤冷却',
        expireAt: now + 10,
      });
      player.markers2 = JSON.stringify(newMarkers2);
    }

    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '召唤使魔');

    return `${player.name || '冒险者'} 使用了${count}张召唤券，召唤出了${summonedItems.join('、')}\n重复召唤出的使魔会转化为对应使魔的好感`;
  }

  /**
   * 召唤固定剧情角色"白"（特殊召唤，不消耗召唤券）
   * 对应原版：召唤1白1()（_主程序.ecode L9777-9795）
   * 原版逻辑：
   *   玩家2.名称 = "白"; 玩家2.类型 = "白"; 玩家2.QQ = "召唤物" + 生成编号()
   *   玩家2.归属 = 玩家.QQ
   *   重定义数组(玩家2.成就/背包/增益/武器/装备/标记2/标记/任务/装备预设, 假, 0)  // 全新实例
   *   添加成就("好感" + 玩家.QQ, 30, 玩家2.标记)  // 对召唤者好感 30
   *   玩家2.房子 = 对话列表[1].任务  // 剧情：初始休眠仓
   *   加入成员(地图列表[玩家.地图].召唤物, 玩家2)
   *   添加成就("召唤白", 1, 玩家.标记)
   * @param userId 用户ID
   * @param name 剧情角色名（固定"白"）
   * @returns 结果文本
   */
  async summonStoryFamiliar(userId: number, name: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图的召唤物列表
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) {
      return `${player.name || '冒险者'} 你不在任何地图上，无法召唤。`;
    }
    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 原版：重复召唤"白"时，先移除已有的"白"召唤物（避免叠加）
    const existingIdx = summons.findIndex((s: any) => s.name === name);
    if (existingIdx !== -1) {
      summons.splice(existingIdx, 1);
    }

    // 构造"白"召唤物实例（对应原版 玩家2 重定义数组后的全新实例）
    const whiteUnit: SummonUnit = {
      specialSeq: 0,
      name,
      type: name,
      qq: `召唤物${Math.floor(Math.random() * 900000) + 100000}`,
      ownerQQ: String(player.qqNumber || player.id),
      affinity: 30, // 对应原版 添加成就("好感"+玩家.QQ, 30)
      level: 1,
      hp: 100,
      combatPower: 0,
      好感: 30,
      房子: '初始休眠仓', // 原版 玩家2.房子 = 对话列表[1].任务（剧情占位）
      成就: [],
      背包: [],
      增益: [],
      武器: [],
      装备: [],
      标记2: [],
      标记: [],
      任务: [],
      装备预设: [],
    };

    summons.push(whiteUnit);
    await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });

    // 记录"召唤白"成就（对应原版 L9795 添加成就("召唤白", 1, 玩家.标记)）
    const markers = this.playerService.safeJsonParse<any>(player.markers, {});
    this.playerService.setMarker(markers, '召唤白', 1);
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `${player.name || '冒险者'} 打开了休眠仓，召唤出了【${name}】\n随着休眠仓被打开，锁着的门似乎也跟着一起解开了`;
  }

  /**
   * 命名使魔
   * 对应原版：命名使魔()
   * 修改玩家的使魔显示名称
   * @param userId 用户ID
   * @param name 新名称
   * @returns 操作结果文本
   */
  async nameFamiliar(userId: number, name: string): Promise<string> {
    if (!name) {
      return '请指定新名称，例如：命名使魔新名称';
    }

    // 名称长度检查（最多16字符，中文占2字符）
    const byteLength = name.replace(/[^\x00-\xff]/g, 'xx').length;
    if (byteLength > 16) {
      return '名称太长，最多16字符，中文占2字符';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 修改名称
    player.name = name;

    await this.playerService.savePlayer(player);

    return `${player.name || '冒险者'} 把名字修改为${name}`;
  }

  /**
   * 查看使魔数据
   * 对应原版：使魔数据()
   * 查看玩家当前使魔的详细数据
   * @param userId 用户ID
   * @returns 使魔数据文本
   */
  async viewFamiliarData(userId: number): Promise<string> {
    // 对齐原版 数据显示.ecode L723-995 显示使魔数据()
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, buffs } = playerData;

    // 原版 L736-747：未选择使魔时返回提示
    if (!player.type) {
      return '你还没有选择使魔，请先发送「选择使魔」来选择';
    }

    // 获取使魔定义（静态配置 JSON 单一来源）
    const familiar = this.staticData.getFamiliarByName(player.type);

    if (!familiar) {
      return `未知的使魔类型: ${player.type}`;
    }

    // ====== 通过 buildAttackerBonus 获取计算后的完整属性 ======
    // 对齐原版 玩家.属性（计算后），而非 DB 基础存储值
    const calc = this.combatSystem.buildAttackerBonus(player, playerData);

    // 获取好感度（对齐原版 L750/L792-804）
    const affinityKey = `${player.type}好感`;
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);

    // 获取技能等级
    const skillKey = `${player.type}技能熟练度`;
    const skillExp = this.playerService.getMarkerValue(markers, skillKey);
    const skillLevel = this.playerService.getSkillLevel(markers, player.type);

    // 好感度描述
    let affinityDesc = '陌生';
    const affinityLevels = [0, 25, 50, 75, 100];
    const affinityTexts = ['陌生', '熟悉', '友好', '亲密', '挚爱'];
    for (let i = affinityLevels.length - 1; i >= 0; i--) {
      if (affinity >= affinityLevels[i]) {
        affinityDesc = affinityTexts[i];
        break;
      }
    }

    // 好感度全属性加成（对齐原版 L754/L800: 全属性+(好感-100)/10%）
    const affinityBonus = affinity > 100 ? `（全属性+${Math.round((affinity - 100) / 10)}%）` : '';

    // ====== 构建显示文本 ======
    const lines: string[] = [];

    // 基础信息（对齐原版 L736-786）
    lines.push(`【${familiar.name}】Lv.${player.level}`);
    lines.push('━━━━━━━━━━━━━━━');

    // 护盾/装甲/生命（对齐原版 L780-786）
    if (calc.护盾) {
      lines.push(`护盾: ${Math.round(player.shield || 0)}/${Math.round(calc.护盾)}`);
    }
    if (calc.装甲) {
      lines.push(`装甲: ${Math.round(player.armor || 0)}/${Math.round(calc.装甲)}`);
    }
    lines.push(`生命: ${Math.round(player.hp || 0)}/${Math.round(calc.生命 || player.maxHp || 100)}`);

    // 四系攻击（对齐原版 L787-788）
    lines.push(`物攻: ${Math.round(calc.物伤 || 0)}  电攻: ${Math.round(calc.电伤 || 0)}`);
    lines.push(`火攻: ${Math.round(calc.火伤 || 0)}  冰攻: ${Math.round(calc.冰伤 || 0)}`);

    // 命中/闪避/速度/暴击（对齐原版 L789-790）
    lines.push(`命中: ${Math.round(calc.命中 || 0)}  闪避: ${Math.round(calc.闪避 || 0)}`);
    lines.push(`速度: ${Math.round(calc.速度 || 0)}  暴击: ${Math.round(calc.暴击 || 0)}%`);

    // 好感度+采集（对齐原版 L791-806）
    lines.push(`好感: ${Math.round(affinity)}（${affinityDesc}）${affinityBonus}`);

    // 战力（对齐原版 L807）
    const combatPower = this.bonusService.calcCombatPower({
      攻击: calc.攻击 || 0,
      生命: calc.生命 || 0,
      装甲: calc.装甲 || 0,
      速度: calc.速度 || 0,
    });
    lines.push(`战力: ${combatPower}`);

    // 详细模式属性（对齐原版 L808-976 详细=真）
    lines.push('━━━━━━━━━━━━━━━');

    // 三层抗性（对齐原版 L809-823）
    if (calc.护盾伤害上限) {
      lines.push(`◆护盾单次最多减少${Math.round(calc.护盾伤害上限)}%`);
    }
    lines.push('◆护盾物/火/冰/电抗:');
    lines.push(`  ${Math.round(calc.护盾物抗 || 0)}%/${Math.round(calc.护盾火抗 || 0)}%/${Math.round(calc.护盾冰抗 || 0)}%/${Math.round(calc.护盾电抗 || 0)}%`);

    if (calc.装甲伤害上限) {
      lines.push(`◆装甲单次最多减少${Math.round(calc.装甲伤害上限)}%`);
    }
    lines.push('◆装甲物/火/冰/电抗:');
    lines.push(`  ${Math.round(calc.装甲物抗 || 0)}%/${Math.round(calc.装甲火抗 || 0)}%/${Math.round(calc.装甲冰抗 || 0)}%/${Math.round(calc.装甲电抗 || 0)}%`);

    if (calc.生命伤害上限) {
      lines.push(`◆生命单次最多减少${Math.round(calc.生命伤害上限)}%`);
    }
    lines.push('◆生命物/火/冰/电抗:');
    lines.push(`  ${Math.round(calc.生命物抗 || 0)}%/${Math.round(calc.生命火抗 || 0)}%/${Math.round(calc.生命冰抗 || 0)}%/${Math.round(calc.生命电抗 || 0)}%`);

    // 暴击伤害/韧性（对齐原版 L824）
    lines.push(`◆暴击伤害: ${Math.round(calc.暴击伤害 || 0)}%  韧性: ${Math.round(calc.韧性 || 0)}%`);

    // 穿透（对齐原版 L836-838：仅非0时显示）
    const totalPen = (calc.护盾穿透 || 0) + (calc.装甲穿透 || 0) + (calc.生命穿透 || 0);
    if (totalPen) {
      lines.push(`◆护盾/装甲/生命穿透: ${Math.round(calc.护盾穿透 || 0)}/${Math.round(calc.装甲穿透 || 0)}/${Math.round(calc.生命穿透 || 0)}%`);
    }

    // 贯穿/抗贯穿（对齐原版 L854-856）
    if ((calc.贯穿 || 0) + (calc.抗贯穿 || 0) !== 0) {
      lines.push(`◆贯穿: ${Math.round(calc.贯穿 || 0)}%  抗贯穿: ${Math.round(calc.抗贯穿 || 0)}%`);
    }

    // 三层回复（对齐原版 L860-868）
    if ((calc.护盾回复 || 0) + (calc.护盾回复2 || 0) !== 0) {
      lines.push(`◆护盾回复: ${Math.round(calc.护盾回复 || 0)}+${Math.round(calc.护盾回复2 || 0)}%`);
    }
    if ((calc.装甲回复 || 0) + (calc.装甲回复2 || 0) !== 0) {
      lines.push(`◆装甲修复: ${Math.round(calc.装甲回复 || 0)}+${Math.round(calc.装甲回复2 || 0)}%`);
    }
    if ((calc.生命回复 || 0) + (calc.生命回复2 || 0) !== 0) {
      lines.push(`◆生命恢复: ${Math.round(calc.生命回复 || 0)}+${Math.round(calc.生命回复2 || 0)}%`);
    }

    // 三层偷取（对齐原版 L869-877）
    if ((calc.吸护盾 || 0) + (calc.吸护盾2 || 0) !== 0) {
      lines.push(`◆护盾偷取: ${Math.round(calc.吸护盾 || 0)}+${Math.round(calc.吸护盾2 || 0)}%`);
    }
    if ((calc.吸装甲 || 0) + (calc.吸装甲2 || 0) !== 0) {
      lines.push(`◆装甲偷取: ${Math.round(calc.吸装甲 || 0)}+${Math.round(calc.吸装甲2 || 0)}%`);
    }
    if ((calc.吸生命 || 0) + (calc.吸生命2 || 0) !== 0) {
      lines.push(`◆生命偷取: ${Math.round(calc.吸生命 || 0)}+${Math.round(calc.吸生命2 || 0)}%`);
    }

    // 伤害分配（对齐原版 L878）
    lines.push(`◆护盾/装甲/生命伤害: ${100 + Math.round(calc.攻击护盾 || 0)}/${100 + Math.round(calc.攻击装甲 || 0)}/${100 + Math.round(calc.攻击生命 || 0)}`);

    // 武器列表（对齐原版 L906-920）
    const weapons = playerData.weapons || [];
    if (Array.isArray(weapons) && weapons.length > 0) {
      const weaponNames = weapons.map((w: any, i: number) =>
        `${w?.name || w?.名称 || '未知'}${w?.data ? `[${this.familiarQualityPrefix(w.data)}]` : ''}`
      );
      lines.push(`◆使用的武器: ${weaponNames.join('、')}`);
    }

    // 装备列表（对齐原版 L922-930）
    const equipments = playerData.equipment || [];
    if (Array.isArray(equipments) && equipments.length > 0) {
      const equipNames = equipments.map((e: any) =>
        `${e?.name || e?.名称 || '未知'}${e?.data ? `[${this.familiarQualityPrefix(e.data)}]` : ''}`
      );
      lines.push(`◆使用的装备: ${equipNames.join('、')}`);
    }

    // 增益（对齐原版 L956-963）
    if (buffs && Array.isArray(buffs) && buffs.length > 0) {
      const buffNames = buffs.map((b: any) => b?.name || b?.名称 || '未知');
      lines.push(`◆当前增益: ${buffNames.join('、')}`);
    }

    // 魅力/活力（对齐原版 L977-984）
    lines.push('━━━━━━━━━━━━━━━');
    lines.push(`魅力: ${Math.round(calc.魅力 || 0)}`);

    // 活力（对齐原版 L983-984: 活力/活力2）
    // 旧存档缺失「活力2」标记时按原版基础上限 100 兜底，避免显示成 0/NaN 歧义；
    // 标记补写由活力恢复结算与最终加成计算统一落盘，这里只负责展示兜底。
    const vitality2 = Math.max(100, Number(this.playerService.getMarkerValue(markers, '活力2')) || 100);
    lines.push(`活力: ${Math.round(player.vitality || 0)}/${Math.round(vitality2)}`);

    // 技能信息
    lines.push('━━━━━━━━━━━━━━━');
    lines.push(`特有技能: ${familiar.uniqueSkill || '无'}`);
    lines.push(`技能等级: ${skillLevel}（经验: ${Math.round(skillExp)}）`);

    // 描述
    if (familiar.description) {
      lines.push('━━━━━━━━━━━━━━━');
      lines.push(familiar.description);
    }

    return lines.join('\n');
  }

  /**
   * 使魔品质前缀
   * 对齐原版 数据显示.ecode L1591-1617 显示品质()
   * 取装备数据首位字符映射品质：e=普通 d=良好 c=优秀 b=精良 a=史诗 s=传说 default=神迹
   * @param data 装备数据字符串
   * @returns 品质前缀文本
   */
  private familiarQualityPrefix(data: string): string {
    if (!data || typeof data !== 'string') return '神迹';
    const prefix = data.charAt(0);
    const qualityMap: Record<string, string> = {
      'e': '普通', 'd': '良好', 'c': '优秀', 'b': '精良',
      'a': '史诗', 's': '传说',
    };
    return qualityMap[prefix] || '神迹';
  }

  /**
   * 查看使魔详细
   * 对应原版：查看使魔详细()
   * 查看指定使魔的详细信息
   * @param userId 用户ID
   * @param familiarName 使魔名称
   * @returns 使魔详细信息文本
   */
  async viewFamiliarDetail(userId: number, familiarName: string): Promise<string> {
    if (!familiarName) {
      return '请指定使魔名称';
    }

    const familiar = this.staticData.getFamiliarByName(familiarName);

    if (!familiar) {
      return `不存在的使魔：${familiarName}`;
    }

    // 获取玩家对该使魔的好感度
    const playerData = await this.playerService.getPlayerData(userId);
    const { markers } = playerData;
    const affinityKey = `${familiarName}好感`;
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);

    // 获取技能等级
    const skillKey = `${familiarName}技能熟练度`;
    const skillExp = this.playerService.getMarkerValue(markers, skillKey);
    const skillLevel = this.playerService.getSkillLevel(markers, familiarName);

    const lines = [
      `【${familiar.name}】`,
      `━━━━━━━━━━━━━━━`,
      `${familiar.description2 || familiar.description || ''}`,
      `━━━━━━━━━━━━━━━`,
      `特有技能: ${familiar.uniqueSkill || '无'}`,
      `技能说明: ${familiar.skillDesc || '无'}`,
      `━━━━━━━━━━━━━━━`,
      `你的好感度: ${Math.round(affinity)}`,
      `技能等级: ${skillLevel}`,
      familiar.noSummon ? '⚠️ 不可召唤' : '✅ 可召唤',
    ];

    return lines.filter(Boolean).join('\n');
  }

  // ==================== 使魔商店 ====================

  /** 将数据存取.ecode 载入的商店项转换为运行时商店项。 */
  private getShopCatalog(): {
    activity: ShopItem[];
    diamond: ShopItem[];
    dataCore: ShopItem[];
  } {
    const config = this.staticData.getShopConfig();
    const map = (items: Array<{ name: string; count: number }>, costType: ShopItem['costType']): ShopItem[] =>
      items.map((item) => ({ name: item.name, cost: item.count, costType }));
    return {
      activity: map(config.activity, 'activity'),
      diamond: map(config.diamond, '钻石'),
      dataCore: map(config.dataCore, 'dataCore'),
    };
  }

  private getItemQuantity(item: any): number {
    return Number(item?.quantity ?? item?.count ?? item?.数量 ?? item?.数量值 ?? 0) || 0;
  }

  private addResourceToBackpack(backpack: any[], name: string, count: number, type = '资源'): void {
    const equipment = type === '装备';
    if (equipment) {
      backpack.push({ name, type, quantity: 1, durability: 0, data: '' });
      return;
    }
    const existing = backpack.find((item: any) =>
      (item?.name ?? item?.名称) === name && (item?.type ?? item?.类型 ?? '资源') !== '装备',
    );
    if (existing) {
      const next = this.getItemQuantity(existing) + count;
      if (existing.quantity !== undefined || existing.数量 !== undefined) existing.quantity = next;
      else existing.count = next;
      return;
    }
    backpack.push({ name, type, quantity: count });
  }

  private async addExchangeReward(backpack: any[], itemName: string, count: number): Promise<void> {
    const equipmentDef = this.staticData.getEquipmentByName(itemName);
    if (equipmentDef?.name && this.itemSystem) {
      for (let i = 0; i < count; i++) {
        backpack.push(await this.itemSystem.generateRewardEquipment(itemName));
      }
      return;
    }
    this.addResourceToBackpack(backpack, itemName, count, equipmentDef?.name ? '装备' : '资源');
  }

  /**
   * 使魔商店
   * 对应原版：使魔商店()
   * 显示商店列表，支持子商店：活跃度商店、钻石商店、数据商店
   * @param userId 用户ID
   * @param shopType 子商店类型（activity/diamond/dataCore）
   * @returns 商店内容文本
   */
  async familiarShop(userId: number, shopType?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const catalog = this.getShopCatalog();
    const normalizedType = ({
      活跃度: 'activity',
      activity: 'activity',
      钻石: 'diamond',
      diamond: 'diamond',
      数据: 'dataCore',
      数据核心: 'dataCore',
      data: 'dataCore',
      dataCore: 'dataCore',
    } as Record<string, string>)[shopType || ''] || '';

    // 原版“使魔商店”本身只显示三个子商店的入口。
    if (!normalizedType) {
      if (shopType) return `${player.name || '冒险者'}没有这个商店`;
      return `${player.name || '冒险者'}#换行1、活跃度商店#2、钻石商店#3、数据商店`;
    }

    const backpack = this.playerService.getBackpackItems(player);
    const diamondItem = backpack.find((item: any) => item.name === '钻石');
    const dataCoreItem = backpack.find((item: any) => item.name === '数据核心');
    const diamondCount = this.getItemQuantity(diamondItem);
    const dataCoreCount = this.getItemQuantity(dataCoreItem);
    const activity = this.playerService.getMarkerValue(markers, '活跃度');
    const shop = catalog[normalizedType as keyof typeof catalog];
    const currencyName = normalizedType === 'activity' ? '活跃度'
      : normalizedType === 'diamond' ? '钻石' : '数据核心';
    const balance = normalizedType === 'activity' ? activity
      : normalizedType === 'diamond' ? diamondCount : dataCoreCount;
    let result = `${player.name || '冒险者'}你有${Math.round(balance)}${currencyName}`;
    shop.forEach((item, index) => {
      result += `#换行${index + 1}、${item.name}(${item.cost})`;
    });
    if (normalizedType === 'activity') result += '#换行“兑换优秀武器补给箱3”来兑换3次';
    if (normalizedType === 'diamond') result += '#换行“兑换召唤券3”来兑换3次';
    return result;
  }

  /**
   * 兑换
   * 对应原版：兑换()
   * 从商店兑换物品
   * @param userId 用户ID
   * @param itemName 物品名称
   * @param count 兑换数量
   * @returns 兑换结果文本
   */
  async exchange(userId: number, itemName: string, count: number = 1): Promise<string> {
    const rawName = (itemName || '').trim();
    if (!rawName) {
      return '请指定要兑换的物品名称';
    }

    // 原版 取数字/去数字：兑换优秀武器补给箱3 => 名称“优秀武器补给箱”、数量3。
    const embeddedDigits = rawName.match(/\d+/g);
    if (count === 1 && embeddedDigits?.length) count = Number(embeddedDigits.join('')) || 1;
    count = Math.max(1, Math.trunc(Number(count) || 1));
    const normalizedName = rawName.replace(/\d/g, '').replace(/\s+/g, '');

    // 扣货币→加货→整包写回必须全程持用户级共享锁，否则与后台自动开采/
    // 任务结算并发时，本结果会被其旧快照整包覆盖（曾导致钻石被扣、召唤券
    // 却没到账）。优先走 P2 mutate 管道（同一把锁 + 新鲜快照 + 货币审计）；
    // 测试桩未注入管道时回落到裸锁路径。
    if (this.mutateService?.mutate) {
      return this.mutateService.mutate(userId, (ctx: any) =>
        this.doExchange(ctx, normalizedName, count));
    }
    return this.playerService.withUserLock(userId, () =>
      this.playerService.getPlayerData(userId).then((playerData: any) =>
        this.doExchange(playerData, normalizedName, count)));
  }

  /** 兑换的读改写段：mutate 管道回调或裸锁路径共用（playerData 为锁内新鲜快照）。 */
  private async doExchange(playerData: any, normalizedName: string, count: number): Promise<string> {
    const userId = playerData.player.userId;
    const { player, markers } = playerData;

    const catalog = this.getShopCatalog();
    // 原版判定顺序必须是：活跃度 -> 钻石 -> 数据核心。
    const shopItem = catalog.activity.find((item) => item.name === normalizedName)
      || catalog.diamond.find((item) => item.name === normalizedName)
      || catalog.dataCore.find((item) => item.name === normalizedName);
    if (!shopItem) {
      return `商店中没有「${normalizedName}」`;
    }

    const source = shopItem.costType;
    const totalCost = shopItem.cost * count;
    const backpack = this.playerService.getBackpackItems(player);
    const currencyName = source === 'activity' ? '活跃度' : source === '钻石' ? '钻石' : '数据核心';

    if (source === 'activity') {
      const activity = this.playerService.getMarkerValue(markers, '活跃度');
      if (activity < totalCost) {
        return `需要${totalCost}活跃度，你只有${Math.round(activity)}`;
      }
      markers['活跃度'] = activity - totalCost;
    } else {
      const currencyItem = backpack.find((item: any) => item.name === currencyName);
      const current = this.getItemQuantity(currencyItem);
      if (current < totalCost) {
        return `需要${totalCost}${currencyName}，你只有${Math.round(current)}`;
      }
      if (current === totalCost) {
        const index = currencyItem ? backpack.indexOf(currencyItem) : -1;
        if (index >= 0) backpack.splice(index, 1);
      } else if (currencyItem) {
        if (currencyItem.quantity !== undefined) currencyItem.quantity = current - totalCost;
        else currencyItem.count = current - totalCost;
      }
    }

    await this.addExchangeReward(backpack, normalizedName, count);
    // 数据商店兑换还会调用后台运作.ecode 的“活跃度(玩家,a)”。
    if (source === 'dataCore') {
      markers['活跃度'] = this.playerService.getMarkerValue(markers, '活跃度') + count;
      markers['历史活跃度'] = this.playerService.getMarkerValue(markers, '历史活跃度') + count;
      if (player.type) {
        const affinityKey = `${player.type}好感`;
        markers[affinityKey] = this.playerService.getMarkerValue(markers, affinityKey) + count / 100;
      }
    }
    markers['兑换'] = this.playerService.getMarkerValue(markers, '兑换') + count;
    player.backpack = JSON.stringify(backpack);
    player.markers = JSON.stringify(markers);

    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '兑换', count);

    const display = this.staticData.getEquipmentByName(normalizedName)
      ? normalizedName
      : `${normalizedName}x${count}`;
    return `${player.name || '冒险者'}用${totalCost}${currencyName}兑换了${display}`;
  }

  // ==================== 家园系统 ====================

  /**
   * 家园操作
   * 对应原版：家园/家园音乐/家园搬迁/家园命名()
   * 完全实现家园系统
   * @param userId 用户ID
   * @param subCommand 子命令
   * @param args 额外参数
   * @returns 操作结果文本
   */
  async handleHome(userId: number, subCommand: string, ...args: string[]): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!subCommand) {
      return this.getHomeStatus(player, markers);
    }

    switch (subCommand) {
      case 'music':
      case '音乐':
      case '家园音乐':
        return this.handleHomeMusic(userId, args[0]);
      case '搬迁':
      case '家园搬迁':
        return this.handleHomeRelocate(userId, args[0]);
      case '命名':
      case '家园命名':
        return this.handleHomeRename(userId, args[0]);
      case '产出':
      case '家园产出':
        return this.handleHomeOutput(userId);
      case '前线':
      case '家园前线':
        return this.handleHomeFrontline(userId);
      case '家园操作':
        return this.getHomeOperations(player, markers);
      case '圈地':
        return this.handleHomeClaim(userId, player, markers);
      case '开挖地基':
        return this.handleHomeDig(userId, player, markers);
      case '建造地基':
        return this.handleHomeFoundation(userId, player, markers);
      case '建造房子':
        return this.handleHomeConstruct(userId, player, markers);
      case '查看':
        return this.getHomeStatus(player, markers);
      default:
        return `未知的家园操作：${subCommand}\n可用操作：music、搬迁、命名、产出、前线、圈地、开挖地基、建造地基、建造房子、查看`;
    }
  }

  /** 读取家园原始所在地图。家园建成后玩家可能已移动到屋内/前线，不能再用 player.mapId 推断。 */
  private getHouseBaseMapId(player: any): number {
    const stats = this.playerService.safeJsonParse<Record<string, any>>(player.stats, {});
    return Number(stats['家园原地图ID'] || stats.houseBaseMapId || player.mapId || 0);
  }

  /** 原版圈地使用固定词库加生成编号为家园命名；名称必须全局唯一。 */
  private async generateHouseName(userId: number): Promise<string> {
    const prefixes = [
      '深渊', '天空之城', '新世界', '边陲之地', '边缘世界', '无主之地',
      '1号采矿基地', '惑星', '矮行星', '脉冲星', '激变星', '红巨星',
      '白矮星', '超新星', '中转站', '潘多拉', '维斯卡', '环形世界', '避难所',
    ];
    const base = prefixes[Math.floor(Math.random() * prefixes.length)];
    const suffix = `${userId}${Date.now().toString().slice(-6)}`;
    const candidate = `${base}${suffix}`;
    const occupied = await this.prisma.player.findFirst({ where: { houseName: candidate } });
    return occupied ? `${base}${userId}${Math.floor(Math.random() * 1000000)}` : candidate;
  }

  /** 取得玩家家园关联动态地图；必要时按原版流程补建。 */
  private async getHouseMaps(player: any, progress: number): Promise<{ yard: any; interior?: any; frontline?: any } | null> {
    if (!player.houseName) return null;
    const baseMapId = this.getHouseBaseMapId(player);
    if (!baseMapId) return null;
    return this.mapService.ensureHouseMaps(player.houseName, baseMapId, progress);
  }

  /** 取得玩家家园院子；建造和产出操作只应写入院子。 */
  private async getHouseYard(player: any, progress: number): Promise<any | null> {
    const maps = await this.getHouseMaps(player, progress);
    return maps?.yard || null;
  }

  /** 当前玩家是否位于自己的院子，复刻原版建造操作的地点门禁。 */
  private async isAtHouseYard(player: any): Promise<boolean> {
    if (!player.houseName || !player.mapId) return false;
    const currentMap = await this.mapService.getMapById(player.mapId);
    return currentMap?.name === player.houseName;
  }

  /** 产出2（作物/建筑非空）条目数；土堆/杂草等障碍物在原版里产出2恒为空。 */
  private countOutputs2(resource: any): number {
    const raw = resource?.outputs2 ?? resource?.['产出2'];
    if (Array.isArray(raw)) return raw.length;
    if (raw == null || raw === '') return 0;
    const parsed = this.playerService.safeJsonParse<any[]>(raw, []);
    return Array.isArray(parsed) ? parsed.length : 0;
  }

  /**
   * 院子里未清理的障碍物（资源2中产出2为空的项）。
   * 对应原版开挖/建造地基的计次循环校验（_主程序.ecode L2522-2527、L2546-2551）。
   */
  private getYardObstacles(yard: any): any[] {
    const resources2 = this.playerService.safeJsonParse<any[]>(yard?.resources2, []);
    return resources2.filter((resource: any) => this.countOutputs2(resource) === 0);
  }

  /** 从静态资源定义深拷贝（对应原版把资源列表1[n]复制进地图资源2）。 */
  private copyResourceDef(name: string): any {
    const def = this.staticData.getAllResources().find((resource: any) => resource.name === name);
    return def ? JSON.parse(JSON.stringify(def)) : { name, times: 20 };
  }

  /**
   * 获取家园状态
   * 显示家园进度、建筑数量、产出预览等信息
   */
  private async getHomeStatus(player: any, markers: any): Promise<string> {
    const progress = this.playerService.getMarkerValue(markers, '家园进度');

    // 原版动态地图的家园院子与玩家当前所在地图分离；已圈地后优先读取院子。
    let mapName = player.houseName || '未设置';
    let mapBuildings: any[] = [];
    const homeMap = player.houseName
      ? await this.mapService.getMapByName(player.houseName).catch(() => null)
      : (player.mapId ? await this.mapService.getMapById(player.mapId) : null);
    if (homeMap) {
      try {
        mapName = homeMap.name;
        mapBuildings = this.playerService.safeJsonParse<any[]>(homeMap.buildings, []);
      } catch {
        // 忽略
      }
    }

    const lines = [
      `🏠 家园 - ${mapName}`,
      `━━━━━━━━━━━━━━━`,
    ];

    if (progress === 0) {
      lines.push('去到你中意的地点，然后「圈地」来开始建造你的家园');
      lines.push('地点不需要太纠结，能搬家');
      lines.push('当前进度: 未开始');
    } else if (progress === 1) {
      lines.push('当前进度: 清空地面');
      lines.push('清理掉土堆和杂草后「开挖地基」');
    } else if (progress === 2) {
      lines.push('当前进度: 开挖地基');
      lines.push('清理掉土堆后「建造地基」');
      lines.push('建造地基需要消耗80木头、120石头、40铁矿和40绳子');
    } else if (progress === 3) {
      lines.push('当前进度: 建造房子');
      lines.push('「建造房子」来建造，需要消耗300木头、500石头、160铁矿和120绳子');
    } else if (progress >= 4) {
      lines.push('家园已建成！');
      lines.push('你可以在家园里面休息、种地、安装生产设备、放置愿意跟随你的怪物和NPC');

      // 显示已在家园中的建筑
      if (mapBuildings.length > 0) {
        lines.push('━━━━━━━━━━━━━━━');
        lines.push(`📦 建筑 (${mapBuildings.length}种):`);
        for (const b of mapBuildings) {
          lines.push(`  ${b.name} x${b.count || 1}`);
        }
      }
    }

    // 家园名称
    if (player.houseName && player.houseName !== mapName) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`家园名称: ${player.houseName}`);
    }

    // 背景音乐
    if (player.houseMusic) {
      lines.push(`🎵 背景音乐: ${player.houseMusic}`);
    }

    return lines.join('\n');
  }

  /**
   * 家园音乐
   */
  private async handleHomeMusic(userId: number, musicName?: string): Promise<string> {
    if (!musicName) {
      return '请指定音乐名称，例如：家园音乐月光';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.houseName) {
      return '你还没有家园，无法设置家园音乐';
    }

    const progress = this.playerService.getMarkerValue(playerData.markers, '家园进度');
    const maps = await this.getHouseMaps(player, progress);
    if (!maps) return '家园地图不存在，无法设置家园音乐';

    // 原版同时修改院子、屋内、前线三张动态地图的音乐。
    await this.mapService.updateDynamicFields(maps.yard.id, { music: musicName });
    if (maps.interior) await this.mapService.updateDynamicFields(maps.interior.id, { music: musicName });
    if (maps.frontline) await this.mapService.updateDynamicFields(maps.frontline.id, { music: musicName });
    await this.playerService.savePlayer(player);

    return `已将家园背景音乐更换为：${musicName}`;
  }

  /**
   * 家园搬迁
   */
  private async handleHomeRelocate(userId: number, targetMap?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    const progress = this.playerService.getMarkerValue(markers, '家园进度');
    if (progress === 0) {
      return '去到你中意的地点，然后「圈地」来开始建造你的家园';
    }

    if (!targetMap) {
      return '请指定搬迁目标地图，例如：家园搬迁森林出口';
    }

    // 检查目标地图是否存在
    let map: any;
    try {
      map = await this.mapService.getMapByName(targetMap);
    } catch {
      return `地图「${targetMap}」不存在`;
    }

    if (!map) {
      return `地图「${targetMap}」不存在`;
    }

    // 检查是否可搬迁
    if (map.noMove) {
      return `「${targetMap}」不可搬迁至此`;
    }

    if (map.isInstance || map.isFrontier) {
      return `「${targetMap}」不可搬迁至此`;
    }

    // 原版“搬迁”只改变家园所在的世界地图，不改变家园名称和内部三张地图。
    const stats = this.playerService.safeJsonParse<Record<string, any>>(player.stats, {});
    const oldBaseMapId = Number(stats['家园原地图ID'] || stats.houseBaseMapId || 0);
    stats['家园原地图ID'] = map.id;
    stats['家园原地图'] = map.name;
    player.stats = JSON.stringify(stats);
    player.mapId = map.id;
    player.location = map.name;
    if (player.houseName) {
      await this.mapService.ensureHouseMaps(player.houseName, map.id, progress);
      if (oldBaseMapId > 0 && oldBaseMapId !== map.id) {
        await this.mapService.removeMapConnection(oldBaseMapId, player.houseName);
      }
    }

    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '家园搬迁');

    return `家园已搬迁至「${targetMap}」`;
  }

  /**
   * 家园命名
   */
  private async handleHomeRename(userId: number, newName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    const progress = this.playerService.getMarkerValue(markers, '家园进度');
    if (progress === 0) {
      return '去到你中意的地点，然后「圈地」来开始建造你的家园';
    }

    if (!newName) {
      return `请指定新名称，例如：家园命名陨落之地`;
    }

    // 检查名称是否已被其他玩家使用
    const existingPlayers = await this.prisma.player.findMany({
      where: { houseName: newName },
    });
    if (existingPlayers.length > 0 && existingPlayers.some(p => p.userId !== userId)) {
      return `禁止与其他家园同名, 请使用其他名称：${newName}`;
    }

    const oldName = player.houseName;
    if (oldName && oldName !== newName) {
      try {
        await this.mapService.renameHouseMaps(oldName, newName);
      } catch (error: any) {
        return error?.message || `家园名称修改失败：${newName}`;
      }
    }

    player.houseName = newName;

    await this.playerService.savePlayer(player);
    // 先持久化新名称，再推进任务，避免任务服务读取旧玩家对象时覆盖本次改名。
    await this.taskService.advance(userId, '家园命名');

    return `家园已命名为「${newName}」`;
  }

  // ==================== 家园建造流程 ====================

  /**
   * 圈地 - 开始建造家园
   * 对应原版：圈地()
   * 设置家园进度=1，表示开始清空地面
   */
  private async handleHomeClaim(userId: number, player: any, markers: any): Promise<string> {
    const progress = this.playerService.getMarkerValue(markers, '家园进度');

    if (progress > 0) {
      return `你的家园已经开始建造了（当前进度: ${this.getProgressText(progress)}）`;
    }

    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return '你不在任何地图上，无法圈地';
    if (currentMap.isInstance || currentMap.isFrontier) {
      return `${player.name || '冒险者'} 不能在副本或玩家的家园内圈地`;
    }

    const houseName = await this.generateHouseName(userId);
    const stats = this.playerService.safeJsonParse<Record<string, any>>(player.stats, {});
    stats['家园原地图ID'] = currentMap.id;
    stats['家园原地图'] = currentMap.name;
    player.houseName = houseName;
    player.stats = JSON.stringify(stats);
    await this.mapService.ensureHouseMaps(houseName, currentMap.id, 1);

    // 设置家园进度为1
    markers['家园进度'] = 1;
    player.markers = JSON.stringify(markers);

    await this.playerService.savePlayer(player);

    return `${player.name || '冒险者'}在${currentMap.name}圈了一块地，你暂时称呼它为${houseName}\n清理掉土堆和杂草后「开挖地基」`;
  }

  /**
   * 开挖地基 - 进度1→2
   * 对应原版 _主程序.ecode L2516-2541：不消耗任何材料，但要求院子里
   * 资源2中产出2为空的障碍物（土堆/杂草）已全部清理干净；
   * 开挖成功后资源2重置为2个土堆，供「建造地基」前再次清理。
   */
  private async handleHomeDig(userId: number, player: any, markers: any): Promise<string> {
    const progress = this.playerService.getMarkerValue(markers, '家园进度');

    if (progress !== 1) {
      if (progress === 0) return '请先「圈地」来开始建造你的家园';
      if (progress >= 2) return '已经完成了开挖地基，继续「建造地基」吧';
      return `当前进度: ${this.getProgressText(progress)}，无法开挖地基`;
    }

    const yard = await this.getHouseYard(player, progress);
    if (!yard || !(await this.isAtHouseYard(player))) {
      return `${player.name || '冒险者'}你不在你家园里，不能进行这个操作。`;
    }

    const obstacles = this.getYardObstacles(yard);
    if (obstacles.length > 0) {
      const obstacleNames = [...new Set(obstacles.map((o: any) => String(o.name ?? '未知')))].join('、');
      return `${player.name || '冒险者'}必须先清空地面。清理掉土堆和杂草后再「开挖地基」\n` +
        `当前还有：${obstacleNames}，发送「挖土」「割草」清理（观察附近可查看剩余次数）`;
    }

    // 原版开挖后资源2重置为2个土堆（资源列表1[3]），进度→2
    await this.mapService.updateDynamicFields(yard.id, {
      resources2: JSON.stringify([this.copyResourceDef('土堆'), this.copyResourceDef('土堆')]),
    });

    // 更新进度
    markers['家园进度'] = 2;
    player.markers = JSON.stringify(markers);

    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '开挖地基');

    return `${player.name || '冒险者'}开始挖地基。\n院子里又出现了两个土堆，清掉后就可以「建造地基」（需要80木头、120石头、40铁矿和40绳子）`;
  }

  /**
   * 建造地基 - 进度2→3
   * 需要 80木头+120石头+40铁矿+40绳子
   */
  private async handleHomeFoundation(userId: number, player: any, markers: any): Promise<string> {
    const progress = this.playerService.getMarkerValue(markers, '家园进度');

    if (progress !== 2) {
      if (progress === 0) return '请先「圈地」来开始建造你的家园';
      if (progress < 2) return '请先「开挖地基」';
      if (progress >= 3) return '已经完成了建造地基，继续「建造房子」吧';
      return `当前进度: ${this.getProgressText(progress)}，无法建造地基`;
    }

    const yard = await this.getHouseYard(player, progress);
    if (!yard || !(await this.isAtHouseYard(player))) {
      return `${player.name || '冒险者'}你不在你家园里，不能进行这个操作。`;
    }

    // 原版先校验地面：开挖地基后院子里会重新出现2个土堆，必须再清空才能建造
    const obstacles = this.getYardObstacles(yard);
    if (obstacles.length > 0) {
      const obstacleNames = [...new Set(obstacles.map((o: any) => String(o.name ?? '未知')))].join('、');
      return `${player.name || '冒险者'}必须先挖开土堆。清理掉土堆后再「建造地基」\n` +
        `当前还有：${obstacleNames}，发送「挖土」清理（观察附近可查看剩余次数）`;
    }

    // 检查所需材料（对应原版逐项提示：建造地基需要80木头，你只有X）
    const required = [
      { name: '木头', count: 80 },
      { name: '石头', count: 120 },
      { name: '铁矿', count: 40 },
      { name: '绳子', count: 40 },
    ];

    const backpack = this.playerService.getBackpackItems(player);

    for (const req of required) {
      const item = backpack.find((i: any) => i.name === req.name);
      const hasCount = item ? (item.count || 1) : 0;
      if (hasCount < req.count) {
        return `建造地基需要${req.count}${req.name}，你只有${Math.round(hasCount)}`;
      }
    }

    // 扣除材料
    for (const req of required) {
      const item = backpack.find((i: any) => i.name === req.name);
      const itemCount = item.count || 1;
      if (itemCount === req.count) {
        const idx = backpack.findIndex((i: any) => i.name === req.name);
        if (idx !== -1) backpack.splice(idx, 1);
      } else {
        item.count = itemCount - req.count;
      }
    }

    // 更新进度
    markers['家园进度'] = 3;
    player.markers = JSON.stringify(markers);
    player.backpack = JSON.stringify(backpack);

    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '建造地基');

    return `${player.name || '冒险者'} 消耗了80木头、120石头、40铁矿和40绳子\n地基已经建造好了，接下来「建造房子」`;
  }

  /**
   * 建造房子 - 进度3→4
   * 需要 300木头+500石头+160铁矿+120绳子
   */
  private async handleHomeConstruct(userId: number, player: any, markers: any): Promise<string> {
    const progress = this.playerService.getMarkerValue(markers, '家园进度');

    if (progress !== 3) {
      if (progress === 0) return '请先「圈地」来开始建造你的家园';
      if (progress < 3) return '请先完成「建造地基」';
      if (progress >= 4) return '你的家园已经建好了！';
      return `当前进度: ${this.getProgressText(progress)}，无法建造房子`;
    }

    const yard = await this.getHouseYard(player, progress);
    if (!yard || !(await this.isAtHouseYard(player))) {
      return `${player.name || '冒险者'}你不在你家园里，不能进行这个操作。`;
    }

    // 检查所需材料
    const required = [
      { name: '木头', count: 300 },
      { name: '石头', count: 500 },
      { name: '铁矿', count: 160 },
      { name: '绳子', count: 120 },
    ];

    const backpack = this.playerService.getBackpackItems(player);

    for (const req of required) {
      const item = backpack.find((i: any) => i.name === req.name);
      const hasCount = item ? (item.count || 1) : 0;
      if (hasCount < req.count) {
        return `材料不足：需要${req.name}x${req.count}，你只有${Math.round(hasCount)}`;
      }
    }

    // 扣除材料
    for (const req of required) {
      const item = backpack.find((i: any) => i.name === req.name);
      const itemCount = item.count || 1;
      if (itemCount === req.count) {
        const idx = backpack.findIndex((i: any) => i.name === req.name);
        if (idx !== -1) backpack.splice(idx, 1);
      } else {
        item.count = itemCount - req.count;
      }
    }

    // 更新进度
    markers['家园进度'] = 4;
    player.markers = JSON.stringify(markers);
    player.backpack = JSON.stringify(backpack);

    // 原版建成房子时追加“屋内”和“前线”地图，并在院子中加入两个入口。
    await this.mapService.ensureHouseMaps(player.houseName, this.getHouseBaseMapId(player), 4);

    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '建造房子');

    return `${player.name || '冒险者'} 消耗了300木头、500石头、160铁矿和120绳子\n🏠 家园建好了！\n你可以开始在家园里面安装生产设备、放置怪物和NPC了`;
  }

  /**
   * 获取进度文本描述
   */
  private getProgressText(progress: number): string {
    const texts: Record<number, string> = {
      0: '未开始',
      1: '清空地面',
      2: '开挖地基',
      3: '建造房子',
      4: '已完成',
    };
    return texts[progress] || '未知';
  }

  // ==================== 家园产出计算 ====================

  /** 原版“文本四舍”只用于提示文本，不改变实际扣除的小数数量。 */
  private roundLikeOriginal(value: number): number {
    return Math.round(Number(value) || 0);
  }

  /** 背包数量兼容原版 quantity 与旧版 count，并保持原条目的字段风格。 */
  private setItemQuantity(item: any, value: number): void {
    if (!item) return;
    if (item.quantity !== undefined) {
      item.quantity = value;
    } else {
      item.count = value;
    }
  }

  /** 兼容直接实例化服务的旧测试/工具夹具；正式运行时始终由任务服务推进。 */
  private async advanceTask(userId: number, actionName: string, count = 1): Promise<void> {
    if (typeof (this.taskService as any)?.advance !== 'function') return;
    await (this.taskService as any).advance(userId, actionName, count);
  }

  /**
   * 家园产出
   * 对应原版：家园产出() / 取地图产出() / 产出资源()
   * 计算家园中所有建筑和作物的产出，并将产出物品添加到玩家背包
   */
  private async handleHomeOutput(userId: number): Promise<string> {
    // 原版地图操作.ecode 的完整观测逻辑统一由 HomeService 执行；保留下方旧实现仅供
    // 没有注入 HomeService 的历史单元测试夹具回退，线上 Nest 实例始终走此入口。
    if (this.homeService) {
      return this.homeService.collectHomeOutput(userId);
    }
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    const progress = this.playerService.getMarkerValue(markers, '家园进度');
    if (progress < 4) {
      return '家园尚未建成，无法产出';
    }

    // 已圈地后家园院子是独立动态地图，不能把玩家当前所在地图当作家园。
    if (!player.houseName && !player.mapId) {
      return '你还没有家园所在地图';
    }

    const map = player.houseName
      ? await this.mapService.getMapByName(player.houseName).catch(() => null)
      : await this.mapService.getMapById(player.mapId);

    if (!map) {
      return '家园所在的地图不存在';
    }

    // 解析地图上的建筑列表
    const mapBuildings = this.playerService.safeJsonParse<any[]>(map.buildings, []);
    if (mapBuildings.length === 0) {
      return '家园中没有建筑，无法产出';
    }

    // 获取建筑定义（静态配置 JSON 单一来源）
    const buildingNames = mapBuildings.map((b: any) => b.name);
    const buildingDefs = this.staticData
      .getAllBuildings()
      .filter((b) => buildingNames.includes(b?.name));

    // 构建建筑定义映射
    const buildingDefMap = new Map<string, any>();
    for (const def of buildingDefs) {
      buildingDefMap.set(def.name, def);
    }

    // 转为生产：将地图上的建筑转换为生产者
    const producers: Producer[] = [];
    for (const b of mapBuildings) {
      const def = buildingDefMap.get(b.name);
      if (!def) continue;

      // 解析建筑定义的产出（materials 字段存储的是产出物品列表）
      const outputs = this.playerService.safeJsonParse<any[]>(def.materials, []);
      if (outputs.length === 0) continue;

      // 构建生产者
      const producer: Producer = {
        name: b.name,
        outputs: outputs.map((o: any) => ({ name: o.name, count: o.count || 0 })),
        priority: 2, // 建筑默认优先级2
        count: b.count || 1,
      };
      producers.push(producer);
    }

    if (producers.length === 0) {
      return '家园中的建筑没有产出配置';
    }

    // 获取玩家背包作为存放地
    const backpack = this.playerService.getBackpackItems(player);

    // 计算时间差：距离上次产出过去了多少秒
    const now = Date.now() / 1000;
    const lastOutput = this.playerService.getMarkerValue(markers, '家园产出时间');
    let timeDiff = 60; // 默认60秒（最少产出间隔）
    if (lastOutput > 0) {
      timeDiff = Math.min(3600, Math.max(60, now - lastOutput)); // 最多1小时，最少1分钟
    }

    // 产出倍率（可配置，默认1.0）
    const buildingOutputRate = 1.0;    // 建筑产出倍率
    const powerConsumeRate = 1.0;      // 电力消耗倍率
    const fuelConsumeRate = 1.0;       // 燃料消耗倍率
    const powerFuelOutputRate = 1.0;   // 燃电产出倍率
    const laborSupplyRate = 1.0;       // 人力供应倍率

    // 执行产出计算（按优先级分组）
    const outputItems: any[] = [];
    const priorities = [...new Set(producers.map(p => p.priority))].sort();

    for (const pri of priorities) {
      // 筛选当前优先级的建筑
      const priorityProducers = producers.filter(p => p.priority === pri);

      // 计算每个生产者的产出
      for (const producer of priorityProducers) {
        // 计算最小产出时间（受消耗品影响）
        const minTime = this.calcMinOutputTime(producer, timeDiff, backpack);

        for (const output of producer.outputs) {
          let quantity = output.count * producer.count * minTime / 60;

          // 应用倍率
          if (output.count > 0) {
            // 正产出
            quantity = quantity * buildingOutputRate;
            if (output.name === '电力' || output.name === '燃料') {
              quantity = quantity * powerFuelOutputRate;
            }
          } else {
            // 负产出（消耗品）
            if (output.name === '电力') {
              quantity = quantity * powerConsumeRate;
            } else if (output.name === '燃料') {
              quantity = quantity * fuelConsumeRate;
            }
          }

          // 跳过电力消耗（电力消耗在整体计算中处理）
          if (output.name === '电力' && output.count < 0) continue;

          // 添加到产出列表
          const existing = outputItems.find((o: any) => o.name === output.name);
          if (existing) {
            existing.count += quantity;
          } else {
            outputItems.push({ name: output.name, count: quantity });
          }
        }
      }
    }

    // 处理电力总体平衡
    const powerOutput = outputItems.find((o: any) => o.name === '电力');
    if (powerOutput && powerOutput.count < 0) {
      // 电力不足，所有产出减半
      for (const item of outputItems) {
        if (item.name !== '电力') {
          item.count = Math.floor(item.count * 0.5);
        }
      }
      powerOutput.count = 0;
    }

    // 将产出添加到玩家背包
    const resultLines: string[] = [];
    resultLines.push(`🏠 家园产出（${timeDiff < 60 ? '1' : Math.round(timeDiff / 60)}分钟）`);
    resultLines.push(`━━━━━━━━━━━━━━━`);

    let hasOutput = false;
    for (const item of outputItems) {
      const count = Math.round(item.count);
      if (count === 0) continue;

      if (count > 0) {
        // 正产出 - 添加到背包
        await this.playerService.addToBackpack(userId, item.name, Math.abs(count));
        resultLines.push(`✅ +${count} ${item.name}`);
        hasOutput = true;
      } else {
        // 消耗品不足时显示
        resultLines.push(`⚠️ 消耗了${Math.abs(count)} ${item.name}`);
      }
    }

    if (!hasOutput) {
      resultLines.push('本次没有产出任何物品');
    }

    // 更新上次产出时间
    markers['家园产出时间'] = now;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return resultLines.join('\n');
  }

  /**
   * 计算最小产出时间
   * 对应原版：取最小产出时间()
   * 受消耗品（负产出）限制，计算可供消耗的时间
   */
  private calcMinOutputTime(producer: Producer, timeDiff: number, backpack: any[]): number {
    // 检查是否有消耗品（负产出）
    const consumables = producer.outputs.filter(o => o.count < 0 && o.name !== '电力');
    if (consumables.length === 0) {
      return timeDiff;
    }

    // 计算各消耗品能支撑的时间
    const times: number[] = [];
    for (const cons of consumables) {
      const item = backpack.find((i: any) => i.name === cons.name);
      const available = item ? (item.count || 1) : 0;

      // 消耗品数量 / (消耗率 / 60) = 可支撑秒数
      const consumeRate = Math.abs(cons.count) / 60;
      if (consumeRate > 0) {
        const supportTime = available / consumeRate;
        times.push(supportTime);
      }
    }

    if (times.length === 0) {
      return timeDiff;
    }

    // 取最小可支撑时间
    times.sort((a, b) => a - b);
    const minTime = times[0];

    return Math.min(timeDiff, minTime);
  }

  /**
   * 取建筑数量
   * 对应原版：取建筑数量()
   * 统计地图上不占建筑数量上限的建筑总数
   */
  private async countBuildings(map: any): Promise<number> {
    const buildings = this.playerService.safeJsonParse<any[]>(map.buildings, []);
    const buildingNames = buildings.map((b: any) => b.name);
    // 静态配置 JSON 单一来源，只取 name/type 两个字段
    const buildingDefs = this.staticData
      .getAllBuildings()
      .filter((b) => buildingNames.includes(b?.name))
      .map((b) => ({ name: b.name, type: b.type }));

    // 构建不占位建筑集合
    const noOccupancyNames = new Set<string>();
    for (const def of buildingDefs) {
      // 如果建筑类型为"天花板"、"墙壁"等结构类，不占数量上限
      if (['天花板', '墙壁', '地板', '门', '窗户'].includes(def.type)) {
        noOccupancyNames.add(def.name);
      }
    }

    let total = 0;
    for (const b of buildings) {
      if (!noOccupancyNames.has(b.name)) {
        total += b.count || 1;
      }
    }
    return total;
  }

  // ==================== 家园前线 ====================

  /**
   * 家园前线
   * 对应原版：家园前线() / 是否有特殊宠物()
   * 显示家园前线状态，检查是否有特殊宠物等
   */
  private async handleHomeFrontline(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    const progress = this.playerService.getMarkerValue(markers, '家园进度');
    if (progress < 4) {
      return `${player.name || '冒险者'}需要先完成房屋的建造`;
    }

    const maps = await this.getHouseMaps(player, progress);
    const map = maps?.frontline;
    if (!map) return `${player.name || '冒险者'}#一个错误发生了:家园前线地图编号为0`;

    const qq = String((player as any).qqNumber || (player as any).externalId || player.userId || userId);
    let summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    let vehicles = this.playerService.safeJsonParse<any[]>(map.vehicles, []);
    const frontlineQQ = `怪物前线${qq}sg`;
    const existing = summons.find((s: any) => (s.QQ || s.qq) === frontlineQQ);
    if (!existing) {
      // 原版 L2240：首次查看前线时以等级0生成前线，而不是只展示静态状态。
      const generated = this.combatSystem.generateFrontline(map, qq, Date.now(), 0);
      summons = generated.summons;
      vehicles = generated.vehicles;
      await this.mapService.updateDynamicFields(map.id, {
        summons: JSON.stringify(summons),
        vehicles: JSON.stringify(vehicles),
      });
    }

    // 检查是否有特殊宠物（特殊序号 > 0 的宠物）
    const specialPets = summons.filter((s: any) => {
      const specialSeq = s.specialSeq ?? s.特殊序号 ?? 0;
      const hp = s.hp ?? s.当前生命 ?? 0;
      return specialSeq > 0 && hp > 0;
    });

    // 原版直接累加前线地图建筑数量，用于显示防御上限。
    const totalBuildings = this.playerService
      .safeJsonParse<any[]>(map.buildings, [])
      .reduce((sum: number, b: any) => sum + Number(b.count ?? b.数量 ?? 1), 0);

    // 获取地图上的建筑列表
    const mapBuildings = this.playerService.safeJsonParse<any[]>(map.buildings, []);
    const frontline = summons.find((s: any) => (s.QQ || s.qq) === frontlineQQ);
    const frontLevel = this.playerService.getMarkerValue(markers, '前线');

    const lines = [
      `${player.name || '冒险者'},${player.houseName}前线防御阵地`,
      `防御阵地和地精无视载具伤害上限，攻击无载具目标时一击必杀`,
      `防御:${totalBuildings}/${frontLevel + 3} 等级:${frontLevel}`,
      `火力通道:`,
    ];

    for (const weapon of frontline?.武器 || frontline?.weapons || []) {
      const name = weapon.名称 ?? weapon.name ?? '';
      const physical = weapon.属性?.物 ?? weapon.attributes?.physical ?? 0;
      lines.push(`${name}（伤害${physical}%）`);
    }

    // 显示特殊宠物
    if (specialPets.length > 0) {
      lines.push(`特殊存在:`);
      for (const pet of specialPets) {
        lines.push(`  ${pet.name || pet.名称} (HP: ${pet.hp ?? pet.当前生命 ?? 0})`);
      }
    }

    // 显示建筑列表
    if (mapBuildings.length > 0) {
      lines.push(`建筑列表:`);
      for (const b of mapBuildings) {
        lines.push(`  ${b.name || b.名称} x${b.count ?? b.数量 ?? 1}`);
      }
    }

    lines.push('发送「开始战斗」开始地精的攻势');

    return lines.join('\n');
  }

  /** 原版“家园操作”菜单：显示家园管理、建筑安装和快捷入口。 */
  private getHomeOperations(player: any, markers: any): string {
    const name = player.name || '冒险者';
    const lines = [
      name,
      '「家园命名」来修改家园名称',
      '「家园搬迁」来搬迁家园',
      '「家园音乐」来更换背景音乐',
      '「安装基础发电机1」来安装建筑',
      '「拆卸基础发电机1」来收起建筑',
      '「安装燃料50」来把燃料放入院子',
      '「家园产出」来观测家园生产',
    ];
    if (this.playerService.getMarkerValue(markers, '家园进度') >= 4) {
      lines.push('「家园前线」来查看防御阵地');
    }
    return lines.join('\n');
  }

  // ==================== 宠物系统 ====================

  /**
   * 宠物操作
   * 对应原版：宠物()
   * 宠物操作的总入口
   * @param userId 用户ID
   * @param subCommand 子命令
   * @returns 操作结果文本
   */
  async handlePet(userId: number, subCommand: string): Promise<string> {
    switch (subCommand) {
      case '操作':
        return this.getPetOperationsHelp(userId);
      default:
        return this.getPetOperationsHelp(userId);
    }
  }

  /**
   * 获取宠物操作帮助
   */
  private async getPetOperationsHelp(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const lines = [
      `${player.name || '冒险者'} 的宠物操作`,
      `━━━━━━━━━━━━━━━`,
      `1. 宠物改名 - 修改宠物名称`,
      `2. 宠物转让 - 转让宠物给他人`,
      `3. 全部跟随 - 让宠物跟随`,
      `4. 全部停下 - 让宠物停下`,
      `5. 全部被动 - 被动模式`,
      `6. 全部主动 - 主动攻击`,
      `7. 大召唤术 - 召唤所有宠物`,
      `8. 救助全部 - 救助宠物`,
      `9. 全部挤奶 - 采集宠物产出`,
      `10. 宠物驾驶 - 让宠物驾驶载具`,
      `11. 呼叫 - 呼叫宠物`,
      `12. 宠物装备 - 管理宠物装备`,
      `13. 宠物觉醒 - 觉醒宠物`,
      `14. 宠物前往 - 让宠物前往某地`,
      `15. 宠物攻击 - 宠物主动攻击`,
      `16. 宠物喂食 - 喂食提高好感`,
      `17. 宠物嗅探 - 寻找怪物`,
      `━━━━━━━━━━━━━━━`,
      `跟随: 跟着玩家移动`,
      `主动: 主动攻击`,
      `被动: 挨打也不会反击`,
      `输入宠物名称即可，不用输入宠物的称号`,
    ];

    return lines.join('\n');
  }

  /**
   * 宠物改名
   * 对应原版：宠物改名()
   * @param userId 用户ID
   * @param oldName 宠物原名
   * @param newName 新名称
   * @returns 操作结果文本
   */
  async renamePet(userId: number, oldName: string, newName: string): Promise<string> {
    if (!oldName || !newName) {
      return '请指定格式：宠物改名原名 新名';
    }

    // 检查禁用名称
    if (this.forbiddenNames.includes(oldName) || this.forbiddenNames.includes(newName)) {
      return '不能改这个名字';
    }

    // 名称长度检查
    const byteLength = newName.replace(/[^\x00-\xff]/g, 'xx').length;
    if (byteLength > 16) {
      return '最多16字符，中文占2字符';
    }

    // 获取当前地图上的召唤物
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 这里需要从地图的召唤物列表中查找并修改
    // 由于地图数据在 GameMap 模型的 summons JSON 字段中
    const map = await this.mapService.getMapById(player.mapId);

    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 查找属于玩家的宠物
    const petIndex = summons.findIndex(
      (s: any) => (s.name === oldName || s.image === oldName) && s.ownerQQ === player.userId.toString(),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${oldName}」并且属于你的NPC或宠物`;
    }

    // 执行改名
    summons[petIndex].image = newName;
    summons[petIndex].name = newName;

    await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });

    return `把${oldName}改名为${newName}`;
  }

  /**
   * 宠物转让
   * 对应原版：宠物转让()
   * @param userId 用户ID
   * @param targetQQ 目标QQ号
   * @param petName 宠物名称
   * @returns 操作结果文本
   */
  async transferPet(userId: number, targetQQ: string, petName: string): Promise<string> {
    if (!targetQQ || !petName) {
      return '请指定格式：宠物转让@QQ 宠物名';
    }

    // 检查禁用名称
    if (this.forbiddenNames.includes(petName)) {
      return '不能转让这个';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);

    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 查找属于玩家的宠物
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${petName}」并且属于你的NPC`;
    }

    // 检查是否为宝宝
    const markers = summons[petIndex].markers || {};
    if (markers['幼崽']) {
      return '宝宝不能转让';
    }

    // 目标玩家是否存在
    const targetPlayer = await this.prisma.player.findFirst({
      where: { masterQQ: targetQQ },
    });

    if (!targetPlayer) {
      return `QQ ${targetQQ} 在玩家列表不存在`;
    }

    // 检查是否防御阵地
    if (markers['阵地']) {
      return '防御阵地不能转让';
    }

    // 执行转让
    summons[petIndex].ownerQQ = targetQQ;
    // 清空标记并重置好感
    summons[petIndex].markers = { [`好感${targetQQ}`]: 100 };

    await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });

    return `把${petName}转让给了${targetQQ}`;
  }

  /**
   * 宠物驾驶
   * 对应原版：宠物驾驶()
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param vehicleName 载具名称（或"原"表示使用宠物自带载具）
   * @returns 操作结果文本
   */
  async petDrive(userId: number, petName: string, vehicleName: string): Promise<string> {
    if (!petName || !vehicleName) {
      return '请指定格式：宠物驾驶宠物名 载具名\n如果是自带有载具的宠物，可以「宠物驾驶宠物名 原」让她驾驶自己原来的载具';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);

    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 查找属于玩家的宠物
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${petName}」并且属于你的宠物`;
    }

    const pet = summons[petIndex];

    if (pet.hp === 0) {
      return `${petName} 没有属性，不能战斗`;
    }

    // 查找载具
    const vehicles = this.playerService.safeJsonParse<any[]>(map.vehicles, []);

    if (vehicleName === '原') {
      // 使用宠物自带载具
      const petVehicle = vehicles.find((v: any) => v.id === petName);
      if (petVehicle) {
        petVehicle.driver = petName;
        // 载具找到
        return `${petName} 进入了${petVehicle.name}的驾驶舱`;
      } else {
        return `${petName} 并不是自带载具的宠物`;
      }
    }

    // 查找指定载具
    const vehicleIndex = vehicles.findIndex((v: any) => v.name === vehicleName);
    if (vehicleIndex === -1) {
      return `附近没有载具「${vehicleName}」`;
    }

    const vehicle = vehicles[vehicleIndex];

    // 检查归属
    if (vehicle.owner !== player.userId.toString() && vehicle.owner !== petName) {
      return `这不是你的或者不是${petName}的${vehicle.name}`;
    }

    // 执行驾驶
    // 踢出当前驾驶员
    const currentDriver = vehicle.driver;
    if (currentDriver) {
      // 查找驾驶员并清除其载具引用
      const driverPet = summons.find((s: any) => s.qq === currentDriver);
      if (driverPet) {
        driverPet.vehicle = '';
      }
    }

    vehicle.driver = pet.qq || petName;
    pet.vehicle = vehicle.id || vehicleName;

    summons[petIndex] = pet;
    vehicles[vehicleIndex] = vehicle;

    // 更新地图数据
    await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons), vehicles: JSON.stringify(vehicles) });

    return `${petName} 进入了${vehicle.name}的驾驶舱`;
  }

  /**
   * 宠物喂食
   * 对应原版：宠物喂食()
   * 消耗糖心巧克力提高宠物好感
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param count 消耗数量
   * @returns 操作结果文本
   */
  async petFeed(userId: number, petName: string, count: number = 1): Promise<string> {
    if (!petName || count <= 0) {
      return '请指定格式：宠物喂食宠物名 数量\n消耗糖心巧克力来提高宠物的好感';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查背包是否有糖心巧克力
    const backpack = this.playerService.getBackpackItems(player);
    const chocolateItem = backpack.find((item: any) => item.name === '糖心巧克力');
    const chocolateCount = chocolateItem ? (chocolateItem.count || 0) : 0;

    if (chocolateCount < count) {
      return `需要${count}个糖心巧克力，你只有${chocolateCount}`;
    }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);

    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 查找属于玩家的宠物
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${petName}」并且属于你的宠物`;
    }

    const pet = summons[petIndex];

    // 检查是否为临时宠物
    if (pet.qq && pet.qq.includes('x')) {
      return '临时宠物不能喂食';
    }

    // 扣除糖心巧克力
    if (chocolateCount === count) {
      const idx = backpack.findIndex((item: any) => item.name === '糖心巧克力');
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      chocolateItem!.count = chocolateCount - count;
    }
    player.backpack = JSON.stringify(backpack);

    // 增加好感
    const affinityKey = `好感${player.userId}`;
    if (!pet.markers) pet.markers = {};
    const currentAffinity = pet.markers[affinityKey] || 0;
    pet.markers[affinityKey] = currentAffinity + count * 10;

    summons[petIndex] = pet;

    // 更新地图和玩家数据
    await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });

    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '宠物喂食', count);

    const newAffinity = pet.markers[affinityKey] || 0;
    return `${petName} 对你的好感提高了${count * 10}（当前${Math.round(newAffinity)}）`;
  }

  /**
   * 宠物嗅探
   * 对应原版：宠物嗅探()
   * 让狩猎宠物寻找当前地图的怪物
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param monsterName 要寻找的怪物名称
   * @returns 操作结果文本
   */
  async petSniff(userId: number, petName: string, monsterName: string): Promise<string> {
    if (!petName || !monsterName) {
      return '请指定格式：宠物嗅探宠物名 怪物名\n消耗宠物等级的生肉，让宠物尝试寻找当前地图存在的怪物，冷却10分钟';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);

    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 查找属于玩家的宠物
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${petName}」并且属于你的宠物`;
    }

    const pet = summons[petIndex];

    // 检查是否为狩猎宠物
    const isHunter = this.huntingPetTypes.some(type => (pet.type || '').includes(type));
    if (!isHunter) {
      return `${petName} 不是狩猎宠物，当前的狩猎类宠物有常春藤、各种狼、各种虎、巨齿鲨`;
    }

    // 检查冷却
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const cooldownMarker = markers2.find((m: any) => m.name === '宠物嗅探');
    const now = Date.now() / 1000;
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      const remaining = Math.ceil(cooldownMarker.expireAt - now);
      return `宠物嗅探冷却中，剩余${remaining}秒`;
    }

    // 检查生肉数量
    const backpack = this.playerService.getBackpackItems(player);
    const meatItem = backpack.find((item: any) => item.name === '生肉');
    const meatCount = meatItem ? (meatItem.count || 0) : 0;
    const petLevel = pet.level || 1;

    if (meatCount < petLevel) {
      return `需要消耗${petLevel}的生肉，你只有${meatCount}`;
    }

    // 检查怪物是否在当前地图存在；运行时实例统一读取 GameMonster 表。
    const monsters = await this.mapService.getMapMonsters(map);
    const monsterExists = monsters.some((m: any) => m.name === monsterName || m.名称 === monsterName);

    if (!monsterExists) {
      return `在${map.name}无法找到「${monsterName}」这种怪物`;
    }

    // 扣除生肉
    if (meatCount === petLevel) {
      const idx = backpack.findIndex((item: any) => item.name === '生肉');
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      meatItem!.count = meatCount - petLevel;
    }
    player.backpack = JSON.stringify(backpack);

    // 设置冷却
    const newMarkers2 = markers2.filter((m: any) => m.name !== '宠物嗅探');
    newMarkers2.push({
      name: '宠物嗅探',
      expireAt: now + 600,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    // 计算成功率：宠物战斗力 ÷ 怪物战斗力 × 2500%
    const petCombatPower = this.bonusService.calcCombatPower({
      攻击: pet.attack || 0,
      生命: pet.hp || 0,
      装甲: pet.defense || 0,
      速度: pet.speed || 100,
    });

    // 从怪物定义获取战斗力（静态配置 JSON 单一来源）
    const monsterDef = this.staticData.getMonsterByName(monsterName);

    const monsterCombatPower = monsterDef
      ? this.bonusService.calcCombatPower({
          攻击: monsterDef.attack || 0,
          生命: monsterDef.hp || 0,
          装甲: monsterDef.defense || 0,
          速度: monsterDef.speed || 100,
        })
      : 100;

    const successRate = Math.min(100, (petCombatPower / Math.max(1, monsterCombatPower)) * 2500);
    const isSuccess = Math.random() * 100 < successRate;

    if (isSuccess) {
      // 成功找到怪物：写入 GameMonster 表（临时怪物 isTemp=true，嗅探产物）
      const defBonus = monsterDef?.bonus ? this.playerService.safeJsonParse<any>(monsterDef.bonus, {}) : {};
      const newMonster = monsterDef
        ? {
            name: monsterDef.name,
            type: monsterDef.type || '怪物',
            specialSeq: monsterDef.specialSeq ?? -1,
            level: monsterDef.level || 1,
            hp: monsterDef.hp || 100,
            maxHp: monsterDef.hp || 100,
            shield: monsterDef.shield || 0,
            maxShield: monsterDef.shield || 0,
            armor: monsterDef.armor || 0,
            maxArmor: monsterDef.armor || 0,
            bonus: monsterDef.bonus || '{}',
            exp: defBonus.经验 || 10,
          }
        : {
            name: monsterName,
            type: '怪物',
            specialSeq: -1,
            level: 1,
            hp: 100,
            maxHp: 100,
            shield: 0,
            maxShield: 0,
            armor: 0,
            maxArmor: 0,
            bonus: '{}',
            exp: 10,
          };

      await this.mapService.addTempMonster(map.id, newMonster);

      // 添加嗅探标记到地图标记3（map.markers 仍为 GameMap 字段，保留）
      const mapMarkers3 = this.playerService.safeJsonParse<any[]>(map.markers || '[]', []);
      mapMarkers3.push({
        name: `嗅探${monsterName}`,
        expireAt: now + 120,
      });

      await this.mapService.updateDynamicFields(map.id, {
        markers: JSON.stringify(mapMarkers3),
      });

      await this.playerService.savePlayer(player);

      return `${petName} 吃掉了${petLevel}的生肉\n找到了一只${monsterName}（成功率${Math.round(successRate)}%）\n2分钟内扫荡时出现${monsterName}的几率更高`;
    } else {
      await this.playerService.savePlayer(player);

      return `${petName} 吃掉了${petLevel}的生肉\n但是没有找到${monsterName}的踪迹……（成功率${Math.round(successRate)}%）`;
    }
  }

  /**
   * 宠物觉醒
   * 对应原版：宠物觉醒()
   * 消耗觉醒丹觉醒宠物，每觉醒一次宠物全属性+0.5%
   * 觉醒到99的倍数时需要花费(觉醒次数+1)÷10的觉醒丹来突破；次数为-1时返还所有觉醒丹
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param countStr 觉醒次数（负数表示返还觉醒丹）
   * @returns 操作结果文本
   */
  async petAwaken(userId: number, petName: string, countStr: string): Promise<string> {
    if (!petName || !countStr) {
      return `「宠物觉醒史莱姆 3」消耗3个觉醒丹来觉醒名为【史莱姆】的宠物3次。
「宠物觉醒史莱姆 -1」来返回名为【史莱姆】的宠物消耗的觉醒丹。
每觉醒到99时，需要花费(觉醒次数+1)÷10的觉醒丹来突破
◆每觉醒一次宠物全属性+0.5%，并获得以下效果：
◆觉醒≥1：神识初醒 - 每击杀或助攻1次，基础护盾、装甲、生命+8，闪避、命中、攻击+1
◆觉醒≥100：炼精化气 - 攻击优先级高于觉醒小于100的宠物，命中和闪避+10%，攻击+20%
◆觉醒≥200：逆转阴阳 - 贯穿+10%，攻击+50%
◆觉醒≥300：天地同辉 - 宠物驾驶载具时，攻击+20%，载具被命中时33%几率载具受到的伤害减半
◆觉醒≥400：羽化升仙 - 攻击、护盾、装甲、生命、命中、闪避、护盾回复、装甲修复、生命恢复+50%，可以使用指令「宠物攻击」
◆觉醒≥500：天神降世 - 命中目标造成目标状态上限3%的额外伤害，攻击时释放技能「天神降世」`;
    }

    const count = parseInt(countStr, 10);
    if (isNaN(count) || count === 0) {
      return `「宠物觉醒史莱姆 3」消耗3个觉醒丹来觉醒名为【史莱姆】的宠物3次。`;
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );
    if (petIndex === -1) {
      return `当前地图没有名为「${petName}」并且属于你的宠物`;
    }

    const pet = summons[petIndex];

    // 临时召唤物不能觉醒
    if (pet.qq && pet.qq.includes('x')) {
      return '召唤物不能觉醒';
    }
    if ((pet.hp || 0) <= 0) {
      return `${petName} 没有属性，不能觉醒`;
    }

    if (!pet.markers) pet.markers = {};
    const currentAwaken = pet.markers['觉醒'] || 0;

    // 返回觉醒丹：计算历史消耗并重置
    if (count < 0) {
      let totalSpent = 0;
      let d = 0;
      for (let i = 0; i < currentAwaken; i++) {
        totalSpent += d % 100 === 99 ? (d + 1) / 10 : 1;
        d++;
      }
      pet.markers['觉醒'] = 0;
      summons[petIndex] = pet;
      await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });

      // 返还觉醒丹到背包
      const backpack = this.playerService.getBackpackItems(player);
      const pillItem = backpack.find((item: any) => item.name === '觉醒丹');
      if (pillItem) {
        pillItem.count = (pillItem.count || 0) + totalSpent;
      } else {
        backpack.push({ name: '觉醒丹', type: '资源', count: totalSpent });
      }
      player.backpack = JSON.stringify(backpack);
      await this.playerService.savePlayer(player);

      return `还原了${petName}的${currentAwaken}次觉醒，得到了觉醒丹x${totalSpent}`;
    }

    // 正向觉醒
    const backpack = this.playerService.getBackpackItems(player);
    const pillItem = backpack.find((item: any) => item.name === '觉醒丹');
    let available = pillItem ? (pillItem.count || 0) : 0;

    let d = currentAwaken;
    let used = 0;
    let done = 0;
    for (let i = 0; i < count; i++) {
      const cost = d % 100 === 99 ? (d + 1) / 10 : 1;
      if (available < cost) break;
      available -= cost;
      used += cost;
      d++;
      done++;
    }

    if (done === 0) {
      const nextCost = d % 100 === 99 ? (d + 1) / 10 : 1;
      return `${petName}，突破「${this.getAwakenStageName(d)}」需要${nextCost}颗觉醒丹，你只有${pillItem ? pillItem.count : 0}`;
    }

    // 扣除觉醒丹
    if (pillItem && used > 0) {
      if (pillItem.count === used) {
        backpack.splice(backpack.indexOf(pillItem), 1);
      } else {
        pillItem.count -= used;
      }
    }
    player.backpack = JSON.stringify(backpack);

    // 记录觉醒次数
    pet.markers['觉醒'] = d;
    // 属性加成：每觉醒一次全属性+0.5%（基于初始属性）
    if (!pet.baseStats) {
      pet.baseStats = {
        hp: pet.hp || 0,
        attack: pet.attack || 0,
        defense: pet.defense || 0,
        speed: pet.speed || 100,
      };
    }
    const bonus = 1 + d * 0.005;
    pet.hp = Math.round((pet.baseStats.hp || 0) * bonus);
    pet.attack = Math.round((pet.baseStats.attack || 0) * bonus);
    pet.defense = Math.round((pet.baseStats.defense || 0) * bonus);
    pet.speed = Math.round((pet.baseStats.speed || 100) * bonus);

    summons[petIndex] = pet;
    await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });
    await this.playerService.savePlayer(player);

    return `消耗${used}颗觉醒丹让${petName}觉醒了${done}次，突破到了
${this.getAwakenStageName(d)}(${d})`;
  }

  /**
   * 获取觉醒阶段名称
   * @param awaken 觉醒次数
   */
  private getAwakenStageName(awaken: number): string {
    if (awaken < 100) return `神识初醒(${awaken})`;
    if (awaken < 200) return `炼精化气(${awaken - 100})(${awaken})`;
    if (awaken < 300) return `逆转阴阳(${awaken - 200})(${awaken})`;
    if (awaken < 400) return `天地同辉(${awaken - 300})(${awaken})`;
    if (awaken < 500) return `羽化升仙(${awaken - 400})(${awaken})`;
    return `天神降世(${awaken - 500})(${awaken})`;
  }

  /**
   * 宠物攻击
   * 对应原版：宠物攻击()
   * 远程操作放在指定地图、觉醒≥400、生命大于0的宠物对怪物发起攻击（冷却30秒）
   * @param userId 用户ID
   * @param mapName 目标地图名称
   * @returns 操作结果文本
   */
  async petAttack(userId: number, mapName: string): Promise<string> {
    if (!mapName) {
      return `「宠物攻击森林出口」来远程操作，让你放在森林出口的宠物对怪物发起攻击`;
    }

    let map: any;
    try {
      map = await this.mapService.getMapByName(mapName);
    } catch {
      return `${mapName} 在地图列表不存在`;
    }
    if (!map) {
      return `${mapName} 在地图列表不存在`;
    }

    // 查找该地图上属于玩家、存活、觉醒≥400的宠物
    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const qualifiedPet = summons.find(
      (s: any) =>
        s.ownerQQ === userId.toString() &&
        (s.hp || 0) > 0 &&
        ((s.markers && s.markers['觉醒']) || 0) >= 400,
    );

    if (!qualifiedPet) {
      return `${mapName} 没有属于你、当前生命大于0、觉醒阶段至少为【羽化升仙】的宠物`;
    }

    // 检查地图上的目标怪物（来自 GameMonster 表，临时生成的怪物 isTemp=true）
    const spawnMonsters = await this.mapService.getMapMonsters(map.id);
    if (spawnMonsters.length === 0) {
      return `${map.name} 没有目标了`;
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 冷却30秒
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const cooldownKey = `宠物攻击${map.name}`;
    const cd = markers2.find((m: any) => m.name === cooldownKey);
    if (cd && cd.expireAt > now) {
      return `宠物攻击冷却中，剩余${Math.ceil(cd.expireAt - now)}秒`;
    }

    // 宠物攻击：逐次真实结算（对齐原版 宠物攻击() 走武器攻击链路）
    // 天神降世联动（对应原版 _主程序.ecode L397-400）：觉醒≥500 且"降"冷却(180秒)未过
    // → 对地图上所有存活怪物各发起一次必中结算（原版 武器攻击(...,"天神a",100)）。
    const awaken = (qualifiedPet.markers && qualifiedPet.markers['觉醒']) || 0;
    let resultText = '';
    const taskProgress: Array<{ actionName: string; count: number }> = [];
    const petMarkers2 = this.playerService.safeJsonParse<any[]>(qualifiedPet.markers2, []);
    const skyfallCd = petMarkers2.find((m: any) => m.name === '降');
    const canSkyfall = awaken >= 500 && !(skyfallCd && skyfallCd.expireAt > Date.now() / 1000);

    if (canSkyfall) {
      // 天神降世：对所有存活怪物逐次结算（必中）
      resultText += `【天神降世】${qualifiedPet.name} 对所有敌人降下审判！\n`;
      for (const m of spawnMonsters) {
        if ((m.hp || 0) <= 0) continue;
        const r = await this.combatSystem.resolvePetVsMonster(qualifiedPet, m, map.id, userId, playerData, taskProgress, '天神a', true);
        resultText += r + '\n';
        if (m.hp <= 0) await this.mapService.removeMapMonster(map.id, m.id);
      }
      // 写入"降"冷却 180 秒（原版 时间间隔要求("降",180)）
      const newPetM2 = petMarkers2.filter((m: any) => m.name !== '降');
      newPetM2.push({ name: '降', expireAt: Date.now() / 1000 + 180 });
      qualifiedPet.markers2 = JSON.stringify(newPetM2);
    } else {
      // 普通宠物攻击：只对第一个怪物发起结算
      const monster = spawnMonsters[0];
      resultText = await this.combatSystem.resolvePetVsMonster(qualifiedPet, monster, map.id, userId, playerData, taskProgress);
      if (monster.hp <= 0) {
        await this.mapService.removeMapMonster(map.id, monster.id);
      }
    }

    // resolvePetVsMonster 已通过对象引用直接修改 qualifiedPet.hp（反伤掉血等），
    // 此处将更新后的宠物实例写回 summons 数组并持久化。
    const petIdx = summons.findIndex((s: any) => s === qualifiedPet);
    if (petIdx >= 0) summons[petIdx] = qualifiedPet;

    // 设置冷却和活动标记
    const newMarkers2 = markers2.filter((m: any) => m.name !== cooldownKey);
    newMarkers2.push({ name: cooldownKey, expireAt: now + 30 });
    player.markers2 = JSON.stringify(newMarkers2);

    // 更新玩家（地图怪物已通过表操作更新，仅保存玩家与召唤物）
    await this.mapService.updateDynamicFields(map.id, {
      summons: JSON.stringify(summons),
    });
    await this.playerService.savePlayer(player);
    for (const progress of taskProgress) {
      await this.taskService.advance(userId, progress.actionName, progress.count);
    }

    return resultText.trim();
  }

  /**
   * 宠物前往
   * 对应原版：宠物前往()
   * 让当前地图上属于玩家的宠物移动到指定地图
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param mapName 目标地图名称
   * @returns 操作结果文本
   */
  async petGoto(userId: number, petName: string, mapName: string): Promise<string> {
    if (!petName || !mapName) {
      return `「宠物前往史莱姆 森林出口」来让名为史莱姆的宠物前往你指定的地点`;
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );
    if (petIndex === -1) {
      return `${map.name} 这里没有属于你的、名为「${petName}」的宠物或NPC`;
    }

    let targetMap: any;
    try {
      targetMap = await this.mapService.getMapByName(mapName);
    } catch {
      return `${mapName} 在地图列表不存在`;
    }
    if (!targetMap) {
      return `${mapName} 在地图列表不存在`;
    }

    const pet = summons[petIndex];
    summons.splice(petIndex, 1);

    // 处理载具描述
    const vehicles = this.playerService.safeJsonParse<any[]>(map.vehicles || '[]', []);
    const vehicle = vehicles.find((v: any) => v.id === pet.vehicle || v.driver === pet.qq || v.driver === petName);
    let moveText: string;
    if (vehicle && vehicle.walkMode === 0) {
      moveText = `拖着${vehicle.name}跑到了`;
    } else if (vehicle && vehicle.walkMode === 1) {
      moveText = `驾驶${vehicle.name}一路疾驰来到了`;
    } else if (vehicle && vehicle.walkMode === 2) {
      moveText = `操纵${vehicle.name}飞到了`;
    } else if (vehicle && vehicle.walkMode === 4) {
      moveText = `的${vehicle.name}安装了无法移动的组件，${pet.name}丢下${vehicle.name}跑到了`;
    } else if (vehicle) {
      moveText = `操纵${vehicle.name}跃迁到了`;
    } else {
      moveText = '跑到了';
    }

    // 添加到目标地图
    const targetSummons = this.playerService.safeJsonParse<any[]>(targetMap.summons, []);
    targetSummons.push(pet);
    await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });
    await this.mapService.updateDynamicFields(targetMap.id, { summons: JSON.stringify(targetSummons) });

    return `${pet.name}${moveText}${targetMap.name}`;
  }

  /**
   * 宠物装备
   * 对应原版：宠物装备()
   * 让宠物额外使用背包里的武器/装备/法宝（必须是宝宝，螳螂除外），或把装备还给你
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param itemArg 物品序号（给装备）或物品名称（还装备）
   * @returns 操作结果文本
   */
  async petEquip(userId: number, petName: string, itemArg: string): Promise<string> {
    if (!petName || !itemArg) {
      return `「宠物装备史莱姆 17」来让名为【史莱姆】的宠物额外使用你背包里的第17个物品(这个物品必须是武器，或者装备，或者法宝)
这件物品会被宠物拿过去装备在身上
必须是使用床补魔生下的宝宝才能使用这个功能
一个宠物最多额外装备一件武器、一件装备、一件法宝
「宠物装备史莱姆 火神机枪」来让宠物把它装备的物品(或者背包里的物品)还给你`;
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );
    if (petIndex === -1) {
      return `${map.name} 这里没有属于你的、名为${petName}的宠物`;
    }

    const pet = summons[petIndex];

    // 必须是宝宝（补魔生下）或螳螂
    const isBaby = pet.markers && pet.markers['宝宝'];
    const isMantis = (pet.type || '').includes('螳螂');
    if (!isBaby && !isMantis) {
      return `${map.name} 这里没有属于你的、名为${petName}、是补魔生下来的宝宝的宠物`;
    }
    if (pet.qq && pet.qq.includes('x')) {
      return '召唤物不能执行此操作';
    }

    // 宠物额外装备列表：装备预设[2].装备
    if (!pet.equipmentPresets) pet.equipmentPresets = [{}, { equipment: [] }];
    const extraEquip: any[] = pet.equipmentPresets[2]?.equipment || [];

    // 背包物品
    const backpack = this.playerService.getBackpackItems(player);
    const isIndex = /^\d+$/.test(itemArg);

    if (isIndex) {
      // 给宠物上装备
      let idx = parseInt(itemArg, 10);
      if (idx < 1 || idx > backpack.length) {
        return `背包中没有第${idx}个物品`;
      }
      // 原版中背包数组从1开始
      const item = backpack[idx - 1];

      // 判断物品类型
      const itemType = item.type || '';
      const isWeaponType = itemType === '武器';
      const isEquipType = itemType === '装备';
      const isMagic = itemType === '法宝';

      if (!isWeaponType && !isEquipType && !isMagic) {
        return `${item.name}不是装备，也不是武器或者法宝`;
      }

      // 检查是否已装备同名物品
      const sameName = extraEquip.some((e: any) => e.name === item.name);
      if (sameName) {
        return `${petName} 已经在使用${item.name}这件物品了`;
      }

      // 检查同类型数量限制
      const hasWeapon = extraEquip.some((e: any) => (e.type || '') === '武器');
      const hasEquip = extraEquip.some((e: any) => (e.type || '') === '装备');
      const hasMagic = extraEquip.some((e: any) => (e.type || '') === '法宝');

      if (isWeaponType && hasWeapon) {
        return `${petName} 已经在使用额外的武器了，不能装备多件`;
      }
      if (isEquipType && hasEquip) {
        return `${petName} 已经在使用额外的装备了，不能装备多件`;
      }
      if (isMagic && hasMagic) {
        return `${petName} 已经在使用法宝了，不能装备多件`;
      }

      // 装备给宠物并从玩家背包移除
      extraEquip.push(item);
      backpack.splice(idx - 1, 1);
      player.backpack = JSON.stringify(backpack);

      pet.equipmentPresets[2].equipment = extraEquip;
      summons[petIndex] = pet;

      await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });
      await this.playerService.savePlayer(player);

      const typeText = isWeaponType ? '接过了' : isEquipType ? '穿上了' : '佩戴上了';
      return `${petName}${typeText}${player.name || '你'}递过来的${item.name}`;
    }

    // 还装备：按名称在宠物额外装备中查找
    const equipIdx = extraEquip.findIndex((e: any) => e.name === itemArg);
    if (equipIdx === -1) {
      return `${petName} 没装备有${itemArg}`;
    }

    const returned = extraEquip[equipIdx];
    extraEquip.splice(equipIdx, 1);
    backpack.push(returned);
    player.backpack = JSON.stringify(backpack);

    pet.equipmentPresets[2].equipment = extraEquip;
    summons[petIndex] = pet;

    await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });
    await this.playerService.savePlayer(player);

    return `${petName}把${returned.name}还给了${player.name || '你'}`;
  }


  /**
   * 捕捉宠物
   * 对应原版：捕捉/开始捕捉/停止捕捉()
   * @param userId 用户ID
   * @param action 动作：capture/start/stop
   * @param target 目标名称
   * @returns 操作结果文本
   */
  async capturePet(userId: number, action: string, target?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);

    if (!map) {
      return '你不在任何地图上';
    }

    // 原版地图.怪物2是运行时实例。当前版本实例在 GameMonster 表，旧地图 JSON
    // 只作为存量数据回退，避免迁移前已经存在的捕捉目标直接消失。
    const persistentMonsters = typeof (this.mapService as any).getMapMonsters === 'function'
      ? await this.mapService.getMapMonsters(map)
      : [];
    const legacyMonsters = this.playerService.safeJsonParse<any[]>(map.monsters, []);
    const usePersistentMonster = persistentMonsters.length > 0;
    const monsters = usePersistentMonster ? persistentMonsters : legacyMonsters;
    const nowMs = Date.now();
    const playerName = player.name || '冒险者';
    const playerQQ = String(player.qqNumber ?? player.userId ?? userId);

    const parseJson = <T>(value: any, fallback: T): T =>
      this.playerService.safeJsonParse<T>(value, fallback);
    const readEntryName = (entry: any): string => entry?.名称 ?? entry?.name ?? '';
    const readEntryTimeMs = (entry: any): number => {
      const raw = Number(entry?.有效期至 ?? entry?.expireAt ?? 0);
      return raw > 0 && raw < 1e12 ? raw * 1000 : raw;
    };
    const activeEntry = (entries: any[], name: string): any | undefined => entries.find((entry: any) =>
      readEntryName(entry) === name && (!readEntryTimeMs(entry) || readEntryTimeMs(entry) > nowMs),
    );
    const readMarkerValue = (entries: any, name: string): number => {
      if (Array.isArray(entries)) {
        const entry = entries.find((item: any) => readEntryName(item) === name);
        return Number(entry?.数值 ?? entry?.value ?? entry?.count ?? 0);
      }
      return Number(entries?.[name] ?? 0);
    };
    const getMonsterDefinition = (monster: any): any =>
      this.staticData.getMonsterByName(monster?.name ?? monster?.名称 ?? target ?? '') || {};
    const getMonsterBonus = (monster: any, definition: any): any => ({
      ...parseJson<any>(definition?.bonus, {}),
      ...parseJson<any>(monster?.bonus, {}),
    });
    const getBaseAnesthesia = (monster: any, definition: any, bonus: any): number => {
      const definitionBonus = parseJson<any>(definition?.bonus, {});
      const value = definitionBonus.麻醉 ?? definitionBonus.anesthesia
        ?? definition?.麻醉 ?? definition?.anesthesia
        ?? monster?.麻醉 ?? monster?.anesthesia
        ?? bonus.麻醉 ?? bonus.anesthesia ?? 0;
      return Number(value || 0);
    };
    const getDescription = (monster: any, definition: any): string => String(
      monster?.description ?? monster?.说明 ?? definition?.description ?? definition?.说明 ?? '',
    );
    const getMonsterBuffs = (monster: any): any[] => parseJson<any[]>(monster?.buffs ?? monster?.增益, []);
    const getMonsterMarkers2 = (monster: any): any[] => parseJson<any[]>(monster?.markers2 ?? monster?.标记2, []);
    const saveMonsterState = async (monster: any, fields: { buffs?: any[]; markers2?: any[] }): Promise<void> => {
      if (fields.buffs) monster.buffs = JSON.stringify(fields.buffs);
      if (fields.markers2) monster.markers2 = JSON.stringify(fields.markers2);
      if (!usePersistentMonster) {
        const legacyIndex = legacyMonsters.indexOf(monster);
        if (legacyIndex >= 0) {
          await this.mapService.updateDynamicFields(map.id, { monsters: JSON.stringify(legacyMonsters) });
        }
        return;
      }
      if (typeof (this.mapService as any).updateMonsterFields === 'function') {
        await (this.mapService as any).updateMonsterFields(map.id, monster.id, {
          ...(fields.buffs ? { buffs: monster.buffs } : {}),
          ...(fields.markers2 ? { markers2: monster.markers2 } : {}),
        });
      } else if (typeof (this.mapService as any).saveGameMonster === 'function') {
        await (this.mapService as any).saveGameMonster(monster);
      }
    };

    if (action === 'start') {
      if (!target) {
        return '请指定目标：开始捕捉史莱姆';
      }

      const monsterIndex = monsters.findIndex((m: any) => m.name === target || m === target);
      if (monsterIndex === -1) {
        return `附近没有${target}`;
      }

      const monster = monsters[monsterIndex];
      const monsterData = typeof monster === 'string' ? { name: monster } : monster;
      const definition = getMonsterDefinition(monsterData);
      const bonus = getMonsterBonus(monsterData, definition);
      const baseAnesthesia = getBaseAnesthesia(monsterData, definition, bonus);
      const description = getDescription(monsterData, definition);

      // 原版 _主程序.ecode L6246-6247。
      if (baseAnesthesia <= 0 && !description.includes('【特殊驯服方式】')) {
        return `${playerName}${target}不是可以捕捉的对象，或者不能通过正常麻醉的方式捕捉\n${description}`;
      }

      const anesthesiaMarkers = getMonsterMarkers2(monsterData);
      const anesthesiaBuffs = getMonsterBuffs(monsterData);
      // 兼容历史版本把“麻醉”写入 buffs 的数据；新写入仍按原版放入标记2。
      if (activeEntry(anesthesiaMarkers, '麻醉') || activeEntry(anesthesiaBuffs, '麻醉')) {
        return `${playerName}${target}已经被麻醉了`;
      }

      const captureBuffs = anesthesiaBuffs.filter((entry: any) => readEntryName(entry) !== '捕捉模式');
      captureBuffs.push({ 名称: '捕捉模式', 强度: 0, 有效期至: nowMs + 600 * 1000, 是否叠加时间: false });
      await saveMonsterState(monsterData, { buffs: captureBuffs });

      return `${playerName},${target}被设置为捕捉模式\n“停止捕捉${target}”来取消`;
    }

    if (action === 'stop') {
      if (!target) {
        return '请指定目标：停止捕捉史莱姆';
      }

      const monsterIndex = monsters.findIndex((m: any) => m.name === target || m === target);
      if (monsterIndex === -1) {
        return `${playerName}附近没有${target}`;
      }
      const monster = monsters[monsterIndex];
      const marker2 = getMonsterMarkers2(monster);
      const buffs = getMonsterBuffs(monster);
      // 原版 L6267 检查的是“麻醉”标记2而非“捕捉模式”增益；疑似笔误，按原版保留。
      if (activeEntry(marker2, '麻醉') || activeEntry(buffs, '麻醉')) {
        const nextBuffs = buffs.filter((entry: any) => readEntryName(entry) !== '捕捉模式');
        await saveMonsterState(monster, { buffs: nextBuffs });
        return `${playerName},${target}被取消了捕捉模式`;
      }

      return `${playerName}${target}已经被麻醉了`;
    }

    // 捕捉
    if (action === 'capture') {
      if (!target) {
        return '请指定目标：捕捉史莱姆';
      }

      // 检查是否为特殊宠物（花园宝宝、小白狐）
      if (target === '花园宝宝' || target === '小白狐') {
        return this.captureSpecialPet(userId, target, map, player, markers);
      }

      const monsterIndex = monsters.findIndex((m: any) => {
        if (typeof m === 'string') return m === target;
        return m.name === target;
      });

      if (monsterIndex === -1) {
        return `附近没有${target}`;
      }

      const monster = monsters[monsterIndex];
      const monsterData = typeof monster === 'string' ? { name: monster } : monster;
      const definition = getMonsterDefinition(monsterData);
      const bonus = getMonsterBonus(monsterData, definition);
      const baseAnesthesia = getBaseAnesthesia(monsterData, definition, bonus);
      const description = getDescription(monsterData, definition);

      // 原版 L6169-6177：特殊麻醉目标走专属驯服流程，普通捕捉不处理。
      if (baseAnesthesia < 0 && monsterData.vitality !== -15 && monsterData.活力 !== -15) {
        const detail = description.includes('【特殊驯服方式】')
          ? description.slice(description.indexOf('【特殊驯服方式】'))
          : '(不可捕捉)';
        return `${playerName}\n${target}\n特殊麻醉值${this.roundLikeOriginal(Number(bonus.当前麻醉 ?? 0))}/${this.roundLikeOriginal(Math.abs(baseAnesthesia))}${detail}`;
      }

      const monsterMarkers = parseJson<any[]>(monsterData.markers ?? monsterData.标记, []);
      const anesthesiaOwnerValue = readMarkerValue(monsterMarkers, `麻醉者${playerQQ}`);
      const currentAnesthesia = Number(bonus.当前麻醉 ?? bonus.currentAnesthesia ?? 0);
      const anesthesiaLimit = Math.abs(baseAnesthesia);

      // 原版 L6182-6184：必须由当前玩家实际造成过麻醉，且麻醉值已满。
      if (anesthesiaOwnerValue === 0) {
        return `${playerName}你未对${target}造成任何麻醉值，没有权利捕捉。`;
      }
      if (currentAnesthesia < anesthesiaLimit) {
        return `${playerName}\n${target}\n麻醉${this.roundLikeOriginal(currentAnesthesia)}/${this.roundLikeOriginal(anesthesiaLimit)}，捕捉需要${this.roundLikeOriginal(Math.abs(baseAnesthesia / 150))}的饲料\n请使用带麻醉效果的武器麻醉目标\n“开始捕捉${target}”来进入捕捉模式，捕捉模式下的目标被攻击不会减少生命值`;
      }

      // 原版 L6188-6192：比较和扣除使用 abs(基础麻醉/150) 的原始小数值，文本四舍只影响显示。
      const feedRequired = Math.abs(baseAnesthesia) / 150;
      const backpack = this.playerService.getBackpackItems(player);
      const feedItem = backpack.find((item: any) => item.name === '饲料');
      const feedCount = feedItem ? Number(feedItem.quantity ?? feedItem.count ?? 0) : 0;

      if (feedCount < feedRequired) {
        return `${playerName}捕捉${target}需要${this.roundLikeOriginal(feedRequired)}的饲料，你只有${this.roundLikeOriginal(feedCount)}`;
      }

      if (feedCount <= feedRequired) {
        const idx = backpack.findIndex((item: any) => item.name === '饲料');
        if (idx !== -1) backpack.splice(idx, 1);
      } else {
        this.setItemQuantity(feedItem, feedCount - feedRequired);
      }
      player.backpack = JSON.stringify(backpack);

      // 原版 L6195-6224：将怪物转为 specialSeq=-2 的召唤物，保留原实例属性。
      const sourceName = monsterData.name || target;
      const newPet = {
        ...monsterData,
        name: sourceName,
        type: monsterData.type || sourceName,
        specialSeq: -2,
        ownerQQ: playerQQ,
        qq: `${monsterData.qq || `${player.userId}_pet_${target}`}g`,
        hp: monsterData.hp || monsterData.maxHp || 100,
        maxHp: monsterData.maxHp || monsterData.hp || 100,
        attack: monsterData.attack || definition.attack || 10,
        defense: monsterData.defense || definition.defense || 5,
        speed: monsterData.speed || definition.speed || 100,
        level: monsterData.level || definition.level || 1,
        markers: { [`好感${playerQQ}`]: 100 },
        vehicle: '',
        isPet: true,
      };
      delete newPet.id;
      delete newPet.mapId;

      // 添加到地图召唤物
      const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
      summons.push(newPet);

      if (usePersistentMonster) {
        await this.mapService.removeMapMonster(map.id, monsterData.id);
        await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });
      } else {
        monsters.splice(monsterIndex, 1);
        await this.mapService.updateDynamicFields(map.id, {
          monsters: JSON.stringify(monsters),
          summons: JSON.stringify(summons),
        });
      }

      await this.playerService.savePlayer(player);
      await this.advanceTask(userId, '捕捉');
      await this.advanceTask(userId, `捕捉${target}`);

      return `驯养了一只${target}\n${target} 对你的好感度为100`;
    }

    return '未知的捕捉操作';
  }

  /**
   * 捕捉特殊宠物（花园宝宝、小白狐）
   */
  private async captureSpecialPet(
    userId: number,
    target: string,
    map: any,
    player: any,
    markers: any,
  ): Promise<string> {
    // 统计全地图中该宠物的数量
    const allMaps = await this.mapService.getAllMaps();
    let totalCount = 0;

    for (const m of allMaps) {
      const summons = this.playerService.safeJsonParse<any[]>(m.summons, []);
      totalCount += summons.filter((s: any) => s.name === target).length;
    }

    // 检查冷却（全地图数量<10时有冷却）
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const cooldownMarker = markers2.find((m: any) => m.name === `${target}冷却`);
    const now = Date.now() / 1000;

    if (totalCount < 10 && cooldownMarker && cooldownMarker.expireAt > now) {
      const remaining = Math.ceil(cooldownMarker.expireAt - now);
      return `你近期已经抓到过${target}了，冷却${remaining}秒`;
    }

    // 先确认目标仍在当前地图，避免目标不存在时错误扣除饲料。
    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const petIndex = summons.findIndex((s: any) => s.name === target);
    if (petIndex === -1) {
      return `附近没有${target}`;
    }

    // 检查饲料
    const backpack = this.playerService.getBackpackItems(player);
    const feedItem = backpack.find((item: any) => item.name === '饲料');
    const feedCount = feedItem ? Number(feedItem.quantity ?? feedItem.count ?? 0) : 0;

    if (feedCount < 100) {
      return '需要100饲料';
    }

    // 扣除饲料
    if (feedCount === 100) {
      const idx = backpack.findIndex((item: any) => item.name === '饲料');
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      this.setItemQuantity(feedItem, feedCount - 100);
    }
    player.backpack = JSON.stringify(backpack);

    // 40%成功率
    const isSuccess = Math.random() < 0.4;

    const addLocalItem = (itemName: string, count: number): void => {
      const existing = backpack.find((item: any) => item.name === itemName);
      if (existing) {
        const current = Number(existing.quantity ?? existing.count ?? 0);
        this.setItemQuantity(existing, current + count);
      } else {
        backpack.push({ name: itemName, count });
      }
    };

    let result = `拿100饲料引诱${target}`;

    if (isSuccess) {
      // 捕捉成功
      result += `\n${target} 吃掉饲料后，紧紧跟着你`;

      // 添加到当前背包，和饲料扣除一起由本次 savePlayer 原子写回。
      addLocalItem(target, 1);

      // 设置冷却
      const newMarkers2 = markers2.filter((m: any) => m.name !== `${target}冷却`);
      newMarkers2.push({
        name: `${target}冷却`,
        expireAt: now + 1800,
      });
      player.markers2 = JSON.stringify(newMarkers2);

      // 从地图移除
      summons.splice(petIndex, 1);
    } else {
      // 捕捉失败
      result += `\n${target} 吃掉饲料后逃走了……`;
      summons.splice(petIndex, 1);
    }

    // 额外奖励物品
    const rewardItems = ['木头', '石头', '铁矿', '绳子'];
    const rewardName = rewardItems[Math.floor(Math.random() * rewardItems.length)];
    const rewardCount = Math.floor(Math.random() * 5) + 1;
    addLocalItem(rewardName, rewardCount);
    player.backpack = JSON.stringify(backpack);
    result += `\n得到了${rewardName}x${rewardCount}`;

    // 更新地图
    await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });

    await this.playerService.savePlayer(player);
    await this.advanceTask(userId, '捕捉');
    await this.advanceTask(userId, `捕捉${target}`);

    return result;
  }

  // ==================== 使魔技能 ====================

  /**
   * 安乐天使技能
   * 对应原版：安乐天使()
   * 给自己、其他玩家或召唤物施加行星护盾（20秒伤害免疫）
   * @param userId 用户ID
   * @param targetName 目标名称（可选，为空则对自己使用）
   * @returns 操作结果文本
   */
  async safetyAngel(userId: number, targetName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 原版“装备要求”只检查当前已装备栏，背包中的同名物品不能直接触发技能。
    if (!this.hasEquippedSkillItem(player, '安乐天使')) {
      return '需要安乐天使';
    }

    const parsedMarkers2 = typeof player.markers2 === 'string'
      ? this.playerService.safeJsonParse<any[]>(player.markers2, [])
      : player.markers2;
    const markers2 = Array.isArray(parsedMarkers2) ? parsedMarkers2 : [];
    const cooldownMarker = markers2.find((m: any) => (m?.name ?? m?.名称) === '安乐');
    const nowMs = Date.now();
    const now = nowMs / 1000;
    const rawExpire = Number(cooldownMarker?.expireAt ?? cooldownMarker?.有效期至 ?? 0);
    const expireAtMs = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
    if (cooldownMarker && expireAtMs > nowMs) {
      const remaining = Math.ceil((expireAtMs - nowMs) / 1000);
      return `冷却中，剩余${remaining}秒`;
    }

    // 设置冷却（300秒 = 5分钟）；markers2 新数据统一使用毫秒时间戳。
    const newMarkers2 = markers2.filter((m: any) => (m?.name ?? m?.名称) !== '安乐');
    newMarkers2.push({
      name: '安乐',
      expireAt: nowMs + 300 * 1000,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    const normalizedTarget = this.normalizeSkillTarget(targetName);
    if (!normalizedTarget) {
      // 对自己使用
      player.buffs = JSON.stringify(this.addSkillBuff(player, '安乐天使', 20, now));
      await this.playerService.savePlayer(player);
      return `给自己套上了行星护盾`;
    }

    // 尝试查找目标（先查召唤物，再查玩家）
    const map = await this.mapService.getMapById(player.mapId);

    if (map) {
      const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
      const summonTarget = summons.find((s: any) =>
        (s.name || s.名称) === normalizedTarget || (s.qq || s.QQ) === normalizedTarget,
      );

      if (summonTarget) {
        summonTarget.buffs = this.addSkillBuff(summonTarget, '安乐天使', 20, now);

        await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });

        await this.playerService.savePlayer(player);
        return `给${summonTarget.name || summonTarget.名称}套上了行星护盾`;
      }
    }

    // 对玩家使用
    const targetPlayer = await this.findSkillTargetPlayer(normalizedTarget);

    if (targetPlayer) {
      const targetDisplayName = targetPlayer.name || normalizedTarget;
      if (targetPlayer.id === player.id) {
        player.buffs = JSON.stringify(this.addSkillBuff(player, '安乐天使', 20, now));
        await this.playerService.savePlayer(player);
        return `给${targetDisplayName}套上了行星护盾`;
      }

      const newBuffs = this.addSkillBuff(targetPlayer, '安乐天使', 20, now);

      await this.prisma.player.update({
        where: { id: targetPlayer.id },
        data: { buffs: JSON.stringify(newBuffs) },
      });

      await this.playerService.savePlayer(player);
      return `给${targetDisplayName}套上了行星护盾`;
    }

    // 原版目标不存在时返回错误，不会把技能悄悄改成对自己使用。
    player.markers2 = JSON.stringify(markers2.filter((m: any) => (m?.name ?? m?.名称) !== '安乐'));
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'},${normalizedTarget}在玩家列表不存在`;
  }

  /**
   * 福音书技能
   * 对应原版：福音书()
   * 给自己或目标施加福音书增益（300秒属性加成）
   * @param userId 用户ID
   * @param targetName 目标名称（可选，为空则对自己使用）
   * @returns 操作结果文本
   */
  async gospelBook(userId: number, targetName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 原版“装备要求”只检查当前已装备栏，背包中的同名物品不能直接触发技能。
    if (!this.hasEquippedSkillItem(player, '福音书')) {
      return '需要福音书';
    }

    // 检查是否每天只能使用一次
    const gospelUsage = this.playerService.getMarkerValue(markers, '福音书');
    if (gospelUsage !== 0) {
      return '一天只能使用一次';
    }

    // 记录使用
    markers['福音书'] = 1;
    player.markers = JSON.stringify(markers);

    const now = Date.now() / 1000;
    const normalizedTarget = this.normalizeSkillTarget(targetName);

    if (!normalizedTarget) {
      // 对自己使用
      player.buffs = JSON.stringify(this.addSkillBuff(player, '福音书', 300, now, { strength: 10 }));
      await this.playerService.savePlayer(player);
      return `给自己使用了福音书`;
    }

    // 尝试查找目标
    const map = await this.mapService.getMapById(player.mapId);

    if (map) {
      const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
      const summonTarget = summons.find((s: any) =>
        (s.name || s.名称) === normalizedTarget || (s.qq || s.QQ) === normalizedTarget,
      );

      if (summonTarget) {
        summonTarget.buffs = this.addSkillBuff(summonTarget, '福音书', 300, now, { strength: 10 });

        await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });

        await this.playerService.savePlayer(player);
        return `给${summonTarget.name || summonTarget.名称}使用了福音书`;
      }
    }

    // 对玩家使用
    const targetPlayer = await this.findSkillTargetPlayer(normalizedTarget);

    if (targetPlayer) {
      const targetDisplayName = targetPlayer.name || normalizedTarget;
      if (targetPlayer.id === player.id) {
        player.buffs = JSON.stringify(this.addSkillBuff(player, '福音书', 300, now, { strength: 10 }));
        await this.playerService.savePlayer(player);
        return `给${targetDisplayName}使用了福音书`;
      }

      const newBuffs = this.addSkillBuff(targetPlayer, '福音书', 300, now, { strength: 10 });

      await this.prisma.player.update({
        where: { id: targetPlayer.id },
        data: { buffs: JSON.stringify(newBuffs) },
      });

      await this.playerService.savePlayer(player);
      return `给${targetDisplayName}使用了福音书`;
    }

    // 原版目标不存在时不消耗“每日一次”标记，也不回退到自己。
    delete markers['福音书'];
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'},${normalizedTarget}在玩家列表不存在`;
  }

  /** 读取技能目标的增益，兼容玩家字段字符串和召唤物字段数组/字符串。 */
  private addSkillBuff(
    target: any,
    buffName: string,
    durationSeconds: number,
    nowSeconds: number,
    extra: Record<string, any> = {},
  ): any[] {
    const rawBuffs = typeof target?.buffs === 'string'
      ? this.playerService.safeJsonParse<any[]>(target.buffs, [])
      : target?.buffs;
    const buffs = Array.isArray(rawBuffs) ? rawBuffs : [];
    const next = buffs.filter((buff: any) => (buff?.name ?? buff?.名称) !== buffName);
    next.push({
      name: buffName,
      expireAt: nowSeconds + durationSeconds,
      ...extra,
    });
    return next;
  }

  /** 技能装备门禁与 FamiliarSkillsService 保持一致，只认当前装备。 */
  private hasEquippedSkillItem(player: any, itemName: string): boolean {
    const rawEquipment = typeof player?.equipment === 'string'
      ? this.playerService.safeJsonParse<any[]>(player.equipment, [])
      : player?.equipment;
    return Array.isArray(rawEquipment) && rawEquipment.some((item: any) =>
      String(item?.name ?? item?.名称 ?? '').trim() === itemName,
    );
  }

  /** 兼容“[@QQ]”快捷目标和普通名称，保持原版目标解析语义。 */
  private normalizeSkillTarget(targetName?: string): string {
    const raw = (targetName || '').trim();
    const wrapped = raw.match(/^\[@?(.+)\]$/);
    return (wrapped ? wrapped[1] : raw).trim();
  }

  /** 以玩家名称、QQ、openid、用户名依次查找玩家目标。 */
  private async findSkillTargetPlayer(targetName: string): Promise<any | null> {
    if (!targetName) return null;
    const byName = await this.prisma.player.findFirst({ where: { name: targetName } });
    if (byName) return byName;
    const byMaster = await this.prisma.player.findFirst({ where: { masterQQ: targetName } });
    if (byMaster) return byMaster;
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { qqNumber: targetName },
          { externalId: targetName },
          { username: targetName },
          { nickname: targetName },
        ],
      },
    });
    return user ? this.prisma.player.findUnique({ where: { userId: user.id } }) : null;
  }

  /**
   * 更新召唤物的幼崽成长计时。
   * 对应原版 数据分析.ecode L947-971 的“计算幼崽”。
   * 返回 true 表示仍是幼崽，false 表示本次已经长大。
   */
  private updateSummonGrowth(summon: any, markers: Record<string, any>): boolean {
    let remaining = Number(markers['幼崽'] ?? 0);
    if (!Number.isFinite(remaining) || remaining <= 0) return false;

    const rawTime = Number(markers['时间2'] ?? 0);
    const previous = rawTime > 1e12 ? rawTime / 1000 : rawTime;
    const now = Math.floor(Date.now() / 1000);
    const elapsed = previous > 0 ? Math.max(0, now - previous) : 0;
    remaining -= elapsed;

    if (remaining > 0) {
      markers['幼崽'] = remaining;
      markers['时间2'] = now;
      return true;
    }

    // 原版“置成就熟练度(..., 0)”会删除幼崽和时间标记。
    delete markers['幼崽'];
    delete markers['时间2'];
    const type = String(summon?.type ?? summon?.类型 ?? '');
    const definition = type ? this.staticData.getMonsterByName(type) : null;
    const vitality = Number(definition?.vitality ?? definition?.活力 ?? definition?.specialSeq ?? definition?.特殊序号);
    if (Number.isFinite(vitality)) {
      summon.vitality = vitality;
      if (summon.活力 !== undefined) summon.活力 = vitality;
    }
    return false;
  }

  /**
   * 检查并更新召唤物幼崽成长计时（public 包装）。
   * 对应原版 _主程序.ecode L6045 在呼叫/操作宠物前先调用 计算幼崽 的逻辑。
   * @returns true 表示仍是幼崽，false 表示已长大（标记已被清除）
   */
  checkAndUpdateGrowth(summon: any): boolean {
    const markers = summon?.markers ?? summon?.标记 ?? {};
    return this.updateSummonGrowth(summon, markers);
  }

  /**
   * 设置跟随
   * 对应原版 _主程序.ecode L1121-1174。
   * 无显式第二参数时按原版切换“跟随”标记；传入 stop/false 由网页指令层显式关闭。
   * @param userId 用户ID
   * @param targetName 宠物名称或QQ
   * @param isFollow 是否跟随；省略时按当前状态切换
   * @returns 操作结果文本
   */
  async setFollow(userId: number, targetName: string, isFollow?: boolean): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);

    if (!map) {
      return '你不在任何地图上';
    }

    // 原版检查的是地图列表编号，而不是数据库自增 id。
    const configuredMapIndex = Number(map.mapIndex ?? map.地图编号 ?? 0);
    const mapIndex = configuredMapIndex > 0
      ? configuredMapIndex
      : Number(map.id ?? player.mapId ?? 0);
    if (mapIndex <= 2 || map.isInstance || map.关卡) {
      return `${player.name || '冒险者'}此操作在此处不可用`;
    }

    const rawSummons = typeof map.summons === 'string'
      ? this.playerService.safeJsonParse<any[]>(map.summons, [])
      : map.summons;
    const summons = Array.isArray(rawSummons) ? rawSummons : [];
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const playerQQ = String(
      user?.qqNumber || (player as any).qqNumber || player.masterQQ || player.userId || userId,
    );
    const ownerIds = new Set([
      String(userId),
      String(player.id),
      String(user?.qqNumber || ''),
      String(user?.externalId || ''),
      String(player.masterQQ || ''),
    ].filter(Boolean));

    // 查找目标；先按名称/图片/QQ匹配，再按归属和好感决定是否允许控制。
    const petIndex = summons.findIndex((s: any) =>
      [s.name, s.名称, s.image, s.图片, s.qq, s.QQ].some(
        (value) => String(value ?? '') === String(targetName ?? ''),
      ),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${targetName}」并且属于你的宠物`;
    }

    const pet = summons[petIndex];
    const owner = String(pet.ownerQQ ?? pet.归属 ?? pet.owner ?? pet.ownerId ?? '');
    const isOwner = ownerIds.has(owner);
    const rawPetMarkers = typeof pet.markers === 'string'
      ? this.playerService.safeJsonParse<any>(pet.markers, {})
      : (pet.markers ?? pet.标记 ?? {});
    const petMarkers: Record<string, any> = Array.isArray(rawPetMarkers)
      ? Object.fromEntries(rawPetMarkers.map((item: any) => [
        item?.name ?? item?.名称,
        item?.value ?? item?.数值 ?? item?.count ?? 0,
      ]).filter(([name]) => Boolean(name)))
      : (rawPetMarkers && typeof rawPetMarkers === 'object' ? { ...rawPetMarkers } : {});
    this.updateSummonGrowth(pet, petMarkers);
    const affinity = pet.name === '白' || pet.名称 === '白'
      ? 100
      : Number(
        petMarkers[`好感${playerQQ}`]
        ?? petMarkers[`好感${userId}`]
        ?? pet.affinity
        ?? pet.好感
        ?? 0,
      );

    if (!isOwner && affinity < 100) {
      return `${pet.name || pet.名称 || targetName}，我不会跟你走的(好感不足100)`;
    }
    if (Number(petMarkers['阵地'] ?? 0) !== 0) {
      return `${pet.name || pet.名称 || targetName}不能行走`;
    }
    if (Number(petMarkers['幼崽'] ?? 0) !== 0) {
      return `${pet.name || pet.名称 || targetName}还不能行走`;
    }

    const currentFollow = Number(petMarkers['跟随'] ?? (pet.follow ? 0 : 1));
    const nextFollow = isFollow === undefined ? currentFollow === 1 : isFollow;
    const petName = pet.name || pet.名称 || targetName;
    if (nextFollow) {
      pet.follow = true;
      pet.mode = 'follow';
      petMarkers['跟随'] = 0;
      // 原版任务/NPC 通过好感获得跟随后会转为当前玩家归属。
      if (!isOwner) {
        pet.ownerQQ = playerQQ;
        if (pet.归属 !== undefined) pet.归属 = playerQQ;
        if (pet.qq === 'npc2g' || pet.QQ === 'npc2g') {
          pet.qq = `怪物${Date.now()}g`;
          if (pet.QQ !== undefined) pet.QQ = pet.qq;
        }
      }
    } else {
      pet.follow = false;
      pet.mode = 'idle';
      petMarkers['跟随'] = 1;
    }
    pet.markers = JSON.stringify(petMarkers);
    if (pet.标记 !== undefined) pet.标记 = pet.markers;

    summons[petIndex] = pet;

    await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });

    // 取对话（_主程序.ecode L1163-1171）：开始跟随取"跟随"台词(类型2)，停止跟随取"停下"台词(类型3)。
    let dialogue = '';
    try {
      dialogue = this.staticData.getDialogue(
        player.name || '冒险者',
        { type: pet.type ?? pet.类型, qq: pet.qq ?? pet.QQ },
        petName,
        nextFollow ? 2 : 3,
      );
    } catch {
      /* 对话数据缺失时不拼接 */
    }

    return nextFollow
      ? `${petName} 开始跟随你${dialogue ? `\n${dialogue}` : ''}`
      : `${petName} 停止跟随${dialogue ? `\n${dialogue}` : ''}`;
  }

  /**
   * 获取使魔技能效果
   * 根据好感度计算技能效果倍率
   * 好感度越高，技能效果越强
   * @param affinity 当前好感度数值
   * @returns 效果倍率（1.0 为基准）
   */
  getSkillEffect(affinity: number): number {
    // 基础效果为 1.0（100%）
    // 好感度每增加 1000，效果提升 5%，最高提升至 200%
    const bonus = Math.min(1.0, Math.floor(affinity / 1000) * 0.05);
    return Math.min(2.0, 1.0 + bonus);
  }

  // ==================== 好感度系统 ====================

  /**
   * 好感度等级配置
   * 1-5级，每级对应不同的好感度阈值和效果描述
   */
  private readonly affinityLevels = [
    { level: 1, minAffinity: 0, name: '陌生', effect: '基础效果' },
    { level: 2, minAffinity: 25, name: '熟悉', effect: '解锁部分专属对话' },
    { level: 3, minAffinity: 50, name: '友好', effect: '技能效果提升10%' },
    { level: 4, minAffinity: 75, name: '亲密', effect: '技能效果提升20%，解锁特殊互动' },
    { level: 5, minAffinity: 100, name: '挚爱', effect: '技能效果提升30%，解锁专属剧情' },
  ];

  /**
   * 增加好感度
   * 好感度增加：战斗/对话/赠礼等增加好感
   * @param userId 用户ID
   * @param amount 增加的好感度数值
   * @returns 操作结果文本
   */
  async increaseAffinity(userId: number, amount: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return '你还没有选择使魔';
    }

    // 获取当前使魔的好感度
    const affinityKey = `${player.type}好感`;
    const currentAffinity = this.playerService.getMarkerValue(markers, affinityKey);
    const newAffinity = currentAffinity + amount;

    // 更新好感度
    markers[affinityKey] = newAffinity;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    // 获取之前的等级和新的等级
    const oldLevel = this.getAffinityLevelByValue(currentAffinity);
    const newLevel = this.getAffinityLevelByValue(newAffinity);

    let result = `${player.type} 的好感度增加了 ${amount} 点（当前: ${Math.round(newAffinity)}）`;

    // 如果等级提升，显示解锁效果
    if (newLevel > oldLevel) {
      const levelConfig = this.affinityLevels.find(l => l.level === newLevel);
      if (levelConfig) {
        result += `\n好感度等级提升至 Lv.${newLevel}「${levelConfig.name}」！\n${levelConfig.effect}`;
      }
    }

    return result;
  }

  /**
   * 根据好感度数值获取等级
   * @param affinity 好感度数值
   * @returns 好感度等级（1-5）
   */
  private getAffinityLevelByValue(affinity: number): number {
    let level = 1;
    for (const l of this.affinityLevels) {
      if (affinity >= l.minAffinity) {
        level = l.level;
      }
    }
    return level;
  }

  /**
   * 获取好感度等级
   * @param userId 用户ID
   * @returns 好感度等级（1-5）
   */
  async getAffinityLevel(userId: number): Promise<number> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return 0;
    }

    const affinityKey = `${player.type}好感`;
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);
    return this.getAffinityLevelByValue(affinity);
  }

  /**
   * 应用好感度效果
   * 根据好感度等级给玩家添加对应的属性加成
   * @param userId 用户ID
   * @param bonus 加成数据对象
   */
  async applyAffinityEffects(userId: number, bonus: BonusData): Promise<void> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return;
    }

    // 获取好感度等级
    const affinityKey = `${player.type}好感`;
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);
    const level = this.getAffinityLevelByValue(affinity);

    // 根据等级应用加成
    // 等级越高，加成越多
    const affinityBonus = (level - 1) * 0.1; // 每级10%加成

    // 根据使魔类型应用不同的加成效果
    switch (player.type) {
      case '龙姬':
        bonus.攻击 = (bonus.攻击 || 0) + Math.floor(10 * affinityBonus);
        break;
      case '军姬':
      case '军姬2':
        bonus.速度 = (bonus.速度 || 0) + Math.floor(10 * affinityBonus);
        break;
      case 'Saber':
        bonus.攻击 = (bonus.攻击 || 0) + Math.floor(15 * affinityBonus);
        bonus.防御 = (bonus.防御 || 0) + Math.floor(5 * affinityBonus);
        break;
      case '冥鱼':
        bonus.暴击 = (bonus.暴击 || 0) + Math.floor(5 * affinityBonus);
        break;
      case '伊卡洛斯':
        bonus.攻击 = (bonus.攻击 || 0) + Math.floor(20 * affinityBonus);
        break;
      case '兰音':
        bonus.全抗性 = (bonus.全抗性 || 0) + Math.floor(10 * affinityBonus);
        break;
      default:
        // 通用加成
        bonus.攻击 = (bonus.攻击 || 0) + Math.floor(5 * affinityBonus);
        bonus.防御 = (bonus.防御 || 0) + Math.floor(5 * affinityBonus);
        break;
    }
  }

  // ==================== 使魔排行 ====================

  /**
   * 获取使魔排行
   * 按使魔战力/等级排序，显示前10名
   * @param userId 用户ID
   * @returns 排行文本
   */
  async getFamiliarRanking(userId: number): Promise<string> {
    // 获取所有玩家数据，按使魔等级和战力排序
    const allPlayers = await this.prisma.player.findMany({
      where: {
        type: { not: '' },
        level: { gt: 0 },
      },
      orderBy: [
        { level: 'desc' },
      ],
      take: 10,
    });

    if (allPlayers.length === 0) {
      return '目前还没有使魔排行数据';
    }

    const lines = [
      '🏆【使魔战力排行】🏆',
      '━━━━━━━━━━━━━━━',
    ];

    // 排行称号
    const rankTitles = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    for (let i = 0; i < allPlayers.length; i++) {
      const p = allPlayers[i];
      const rank = rankTitles[i] || `${i + 1}.`;
      const name = p.name || '未知冒险者';
      const level = p.level || 0;
      const type = p.type || '未知';
      lines.push(`${rank} ${name} | Lv.${level} | ${type}`);
    }

    // 获取当前玩家的排名
    const currentPlayer = allPlayers.find(p => p.userId === userId);
    if (currentPlayer) {
      const currentRank = allPlayers.indexOf(currentPlayer) + 1;
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`你的排名: 第${currentRank}名`);
    } else {
      // 获取当前玩家信息
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;
      if (player.type) {
        // 计算当前玩家在所有玩家中的排名
        const allCount = await this.prisma.player.count({
          where: { type: { not: '' } },
        });
        const betterCount = await this.prisma.player.count({
          where: {
            type: { not: '' },
            level: { gt: player.level || 0 },
          },
        });
        lines.push(`━━━━━━━━━━━━━━━`);
        lines.push(`你的排名: 第${betterCount + 1}/${allCount}名`);
      }
    }

    return lines.join('\n');
  }

  // ==================== 使魔称号 ====================

  /** 称号配置列表 */
  private readonly titleConfigs = [
    { name: '使魔新手', condition: '拥有1个使魔好感度≥25', check: (affinities: Record<string, number>) => Object.values(affinities).filter(a => a >= 25).length >= 1, bonus: '攻击+5' },
    { name: '使魔收藏家', condition: '拥有3个使魔好感度≥25', check: (affinities: Record<string, number>) => Object.values(affinities).filter(a => a >= 25).length >= 3, bonus: '攻击+10，防御+5' },
    { name: '使魔大师', condition: '拥有5个使魔好感度≥25', check: (affinities: Record<string, number>) => Object.values(affinities).filter(a => a >= 25).length >= 5, bonus: '攻击+20，防御+10，速度+5' },
    { name: '挚爱之人', condition: '任意使魔好感度达到100', check: (affinities: Record<string, number>) => Object.values(affinities).some(a => a >= 100), bonus: '全属性+15' },
    { name: '驯服者', condition: '拥有使魔总数≥10', check: (affinities: Record<string, number>) => Object.keys(affinities).length >= 10, bonus: '攻击+10' },
    { name: '百战勇士', condition: '使魔等级达到100级', check: async (prisma: PrismaService, userId: number) => {
      const player = await prisma.player.findUnique({ where: { userId } });
      return player ? (player.level || 0) >= 100 : false;
    }, bonus: '攻击+30，防御+20' },
    { name: '资深驯兽师', condition: '拥有使魔总数≥20', check: (affinities: Record<string, number>) => Object.keys(affinities).length >= 20, bonus: '全属性+25' },
  ];

  /**
   * 领取称号
   * 完成特定条件获得称号
   * @param userId 用户ID
   * @param titleName 称号名称
   * @returns 操作结果文本
   */
  async claimTitle(userId: number, titleName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 查找称号配置
    const titleConfig = this.titleConfigs.find(t => t.name === titleName);
    if (!titleConfig) {
      return `不存在的称号：${titleName}\n可用称号：${this.titleConfigs.map(t => t.name).join('、')}`;
    }

    // 检查是否已拥有该称号
    const titles = this.playerService.safeJsonParse<any[]>(player.titles, []);
    if (titles.some((t: any) => t.name === titleName)) {
      return `你已经拥有称号「${titleName}」了`;
    }

    // 检查条件
    // 收集所有使魔好感度（静态配置 JSON 单一来源）
    const allFamiliars = this.staticData.getAllFamiliars();
    const affinities: Record<string, number> = {};
    for (const familiar of allFamiliars) {
      const affinityKey = `${familiar.name}好感`;
      const affinity = this.playerService.getMarkerValue(markers, affinityKey);
      if (affinity > 0) {
        affinities[familiar.name] = affinity;
      }
    }

    // 检查条件是否满足
    let conditionMet = false;
    if (typeof titleConfig.check === 'function') {
      // 如果是异步函数（需要prisma参数）
      if (titleConfig.check.length > 1) {
        conditionMet = await (titleConfig.check as any)(this.prisma, userId);
      } else {
        conditionMet = (titleConfig.check as any)(affinities);
      }
    }

    if (!conditionMet) {
      return `条件不满足：${titleConfig.condition}`;
    }

    // 领取称号
    titles.push({ name: titleName, equipped: false });
    player.titles = JSON.stringify(titles);
    await this.playerService.savePlayer(player);

    return `恭喜你获得了称号「${titleName}」！\n效果：${titleConfig.bonus}`;
  }

  /**
   * 佩戴称号
   * 选择当前使用的称号
   * @param userId 用户ID
   * @param titleName 称号名称
   * @returns 操作结果文本
   */
  async equipTitle(userId: number, titleName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const titles = this.playerService.safeJsonParse<any[]>(player.titles, []);

    // 查找称号
    const title = titles.find((t: any) => t.name === titleName);
    if (!title) {
      return `你还没有获得称号「${titleName}」\n请先使用「领取称号」来获取`;
    }

    // 取消所有称号的佩戴状态
    for (const t of titles) {
      t.equipped = false;
    }

    // 佩戴指定称号
    title.equipped = true;
    player.titles = JSON.stringify(titles);
    await this.playerService.savePlayer(player);

    return `已佩戴称号「${titleName}」`;
  }

  /**
   * 查看称号列表
   * 显示所有已获得的称号
   * @param userId 用户ID
   * @returns 称号列表文本
   */
  async viewTitles(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const titles = this.playerService.safeJsonParse<any[]>(player.titles, []);

    if (titles.length === 0) {
      return '你还没有获得任何称号\n使用「查看可领取称号」查看所有可领取的称号';
    }

    const lines = [
      `${player.name || '冒险者'} 的称号列表`,
      `━━━━━━━━━━━━━━━`,
    ];

    for (const title of titles) {
      const equippedMark = title.equipped ? '✅' : '  ';
      const titleConfig = this.titleConfigs.find(t => t.name === title.name);
      const bonus = titleConfig ? titleConfig.bonus : '';
      lines.push(`${equippedMark} ${title.name}${bonus ? `（${bonus}）` : ''}`);
    }

    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`使用「佩戴称号 称号名」来佩戴称号`);

    return lines.join('\n');
  }

  /**
   * 查看可领取的称号
   * @param userId 用户ID
   * @returns 可领取称号列表
   */
  async viewAvailableTitles(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    const ownedTitles = this.playerService.safeJsonParse<any[]>(player.titles, []);
    const ownedNames = new Set(ownedTitles.map((t: any) => t.name));

    // 收集所有使魔好感度（静态配置 JSON 单一来源）
    const allFamiliars = this.staticData.getAllFamiliars();
    const affinities: Record<string, number> = {};
    for (const familiar of allFamiliars) {
      const affinityKey = `${familiar.name}好感`;
      const affinity = this.playerService.getMarkerValue(markers, affinityKey);
      if (affinity > 0) {
        affinities[familiar.name] = affinity;
      }
    }

    const lines = [
      '📜 可领取的称号',
      `━━━━━━━━━━━━━━━`,
    ];

    for (const config of this.titleConfigs) {
      const owned = ownedNames.has(config.name);
      const status = owned ? '✅ 已领取' : '⏳ 可领取';
      lines.push(`${config.name}${owned ? '' : '（' + config.condition + '）'}`);
      lines.push(`  效果: ${config.bonus} | ${status}`);
    }

    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`使用「领取称号 称号名」来领取称号`);

    return lines.join('\n');
  }

  // ==================== 使魔等级/技能等级 ====================

  /**
   * 使魔升级
   * 获得经验时使魔也获得经验
   * @param userId 用户ID
   * @param exp 获得的经验值
   * @returns 操作结果文本
   */
  async addFamiliarExp(userId: number, exp: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return '你还没有选择使魔';
    }

    // 使魔获得经验（玩家经验的50%）
    const familiarExp = Math.floor(exp * 0.5);

    // 使用技能熟练度标记来存储使魔经验
    const expKey = `${player.type}技能熟练度`;
    const currentExp = this.playerService.getMarkerValue(markers, expKey);
    const newExp = currentExp + familiarExp;

    // 计算等级变化
    const oldLevel = this.playerService.getSkillLevel(markers, player.type);
    markers[expKey] = newExp;
    const newLevel = this.playerService.getSkillLevel(markers, player.type);

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    let result = `${player.type} 获得了 ${familiarExp} 点经验`;

    if (newLevel > oldLevel) {
      result += `\n🎉 ${player.type} 升级了！Lv.${oldLevel} → Lv.${newLevel}`;
    }

    return result;
  }

  /**
   * 提升技能等级
   * 使用技能提升技能等级，技能等级影响效果
   * @param userId 用户ID
   * @param skillName 技能名称
   * @returns 操作结果文本
   */
  async increaseSkillLevel(userId: number, skillName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return '你还没有选择使魔';
    }

    // 使用技能熟练度标记
    const skillKey = `${player.type}技能熟练度`;
    const currentExp = this.playerService.getMarkerValue(markers, skillKey);
    const currentLevel = this.playerService.getSkillLevel(markers, player.type);

    // 每次使用技能增加10点熟练度
    const newExp = currentExp + 10;
    markers[skillKey] = newExp;
    const newLevel = this.playerService.getSkillLevel(markers, player.type);
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    let result = `技能「${skillName}」熟练度+10`;

    if (newLevel > currentLevel) {
      result += `\n🎉 技能等级提升！Lv.${currentLevel} → Lv.${newLevel}`;
    }

    // 技能等级影响效果：每级提升2%效果
    result += `\n当前技能等级: Lv.${newLevel}（效果加成: ${(newLevel - 1) * 2}%）`;

    return result;
  }

  // ==================== 使魔专属效果 ====================

  /**
   * 军姬X传送判断
   * 军姬2好感≥20时传送无需消耗
   * 对应原版：军姬X传送判断()
   * @param userId 用户ID
   * @returns 是否可以免费传送
   */
  async canFreeTeleport(userId: number): Promise<boolean> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔是否为军姬2
    if (player.type !== '军姬2') {
      return false;
    }

    // 检查好感度是否≥20
    const affinityKey = '军姬2好感';
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);
    return affinity >= 20;
  }

  /**
   * 普拉娜幼崽剪毛
   * 装备剪刀时自动剪毛
   * 对应原版：普拉娜幼崽剪毛()
   * @param userId 用户ID
   * @returns 操作结果文本
   */
  async shearPlana(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否装备了剪刀
    const backpack = this.playerService.getBackpackItems(player);
    const hasScissors = backpack.some((item: any) => item.name === '剪刀');
    if (!hasScissors) {
      return '需要装备「剪刀」才能剪毛';
    }

    // 检查使魔是否为普拉娜幼崽
    if (player.type !== '普拉娜幼崽') {
      return '需要普拉娜幼崽才能剪毛';
    }

    // 检查冷却（每天一次）
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const cooldownMarker = markers2.find((m: any) => m.name === '剪毛');
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      return '剪毛冷却中，每天只能剪一次';
    }

    // 设置冷却
    const newMarkers2 = markers2.filter((m: any) => m.name !== '剪毛');
    newMarkers2.push({
      name: '剪毛',
      expireAt: this.getEndOfDay(now),
    });
    player.markers2 = JSON.stringify(newMarkers2);
    await this.playerService.savePlayer(player);

    // 获得毛发物品
    await this.playerService.addToBackpack(userId, '毛发', 1);

    return '普拉娜幼崽的毛被剪下来了！获得了毛发x1';
  }

  /**
   * 获取当天结束的时间戳
   * @param now 当前时间戳
   * @returns 当天23:59:59的时间戳
   */
  private getEndOfDay(now: number): number {
    const date = new Date(now * 1000);
    date.setHours(23, 59, 59, 999);
    return date.getTime() / 1000;
  }

  /**
   * 纯白之翼自动技能
   * 自动释放使魔技能
   * 对应原版：纯白之翼()
   * @param userId 用户ID
   * @returns 是否自动释放了技能
   */
  async autoCastSkill(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否装备了纯白之翼
    const backpack = this.playerService.getBackpackItems(player);
    if (!backpack.some((item: any) => item.name === '纯白之翼')) {
      return '';
    }

    // 原版 _主程序 L11462 先检查“纯白cd”30秒，再进入纯白之翼子程序。
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const pureWhiteCooldown = markers2.find((m: any) => m.name === '纯白cd');
    if (pureWhiteCooldown && pureWhiteCooldown.expireAt > now) {
      return '';
    }

    // 原版 使魔技能 L169：主动技能公共冷却未结束时不自动释放。
    const skillCooldown = markers2.find((m: any) => m.name === `${player.type}技能冷却`);
    if (skillCooldown && skillCooldown.expireAt > now) {
      return '';
    }

    // 原版 使魔技能 L171：自动训练间隔为5秒。
    const autoTrain = markers2.find((m: any) => m.name === '自动训练');
    if (autoTrain && autoTrain.expireAt > now) {
      return '';
    }

    let normalizedSkill = this.normalizeUniqueSkill(player.uniqueSkill, player.type);
    if (player.type === '兰音') {
      const skillExp = this.playerService.getMarkerValue(markers, '兰音技能熟练度');
      const skillLevel = this.playerService.getSkillLevel(markers, '兰音');
      const hasCoolCore = backpack.some((item: any) => item.name === '冷却核心');
      const publicCooldownZero = hasCoolCore ? skillLevel >= 40 : skillLevel >= 60;
      if (publicCooldownZero) normalizedSkill = '形神合一';
    }
    if (!normalizedSkill || !this.familiarSkills) {
      return '';
    }

    const nextMarkers2 = markers2.filter((m: any) => m.name !== '自动训练' && m.name !== '纯白cd');
    nextMarkers2.push({ name: '自动训练', expireAt: now + 5 });
    nextMarkers2.push({ name: '纯白cd', expireAt: now + 30 });
    player.markers2 = JSON.stringify(nextMarkers2);
    await this.playerService.savePlayer(player);

    // 原版通过“新建延时”投递技能命令；服务端直接调用同一个技能入口，
    // 这样仍复用主动技能自身的门禁、冷却、经验、战斗和文本逻辑。
    try {
      const text = await this.familiarSkills.executeSkill(userId, normalizedSkill);
      return text || '';
    } catch (error: any) {
      this.logger.warn(`纯白之翼自动释放失败: ${error.message}`);
      return '';
    }
  }

  /** 将存量特有技能文本映射为 FamiliarSkillsService 的规范技能名。（战斗内自动释放等跨服务复用，公开） */
  normalizeUniqueSkill(raw: any, type: any): string {
    const value = String(raw ?? '').trim().replace(/[！!。]+$/g, '');
    const aliases: Record<string, string> = {
      ex: '誓约胜利之剑',
      '半月斩': '斩',
    };
    if (aliases[value]) return aliases[value];
    const supported = new Set([
      '六道轮回', '怒吼', '万象', '誓约胜利之剑', '鹰眼', '歼灭', '歼灭模式',
      '绝对守护', '斗转星移', '火力全开', '啾啾猫猫', '银龙附体', '斩',
      '会心一击', '全弹发射', '光翼', '炮冠', '日轮', '安宝加油', '灼烂歼鬼',
      '冻结傀儡', '封印解除', '召唤银龙', '形神合一', '风月入墨', '心无所扰',
      '梦倾天下', '反转童话', '月落寸光', '安乐天使', '福音书', '启示录',
      '铠甲合体', '切换模式', '使魔挑战', '开始挑战', '复活使魔', '大召唤术',
    ]);
    return supported.has(value) ? value : '';
  }

  /**
   * 兰音技能冷却
   * 冷却核心-10cd，技能等级减cd
   * 对应原版：兰音冷却处理()
   * @param userId 用户ID
   * @param baseCooldown 基础冷却时间（秒）
   * @returns 实际冷却时间（秒）
   */
  async lanyinCooldown(userId: number, baseCooldown: number): Promise<number> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (player.type !== '兰音') {
      return baseCooldown;
    }

    let cooldown = baseCooldown;

    // 检查是否装备了冷却核心（-10秒冷却）
    const backpack = this.playerService.getBackpackItems(player);
    if (backpack.some((item: any) => item.name === '冷却核心')) {
      cooldown -= 10;
    }

    // 技能等级减cd（每级-0.5秒）
    const skillKey = '兰音技能熟练度';
    const skillExp = this.playerService.getMarkerValue(markers, skillKey);
    const skillLevel = this.playerService.getSkillLevel(markers, '兰音');
    const levelReduction = Math.floor(skillLevel * 0.5);
    cooldown -= levelReduction;

    // 最低冷却为5秒
    return Math.max(5, cooldown);
  }

  /**
   * 兰音自动释放形神合一
   * 公共冷却为0时自动释放
   * 对应原版：兰音自动释放处理()
   * @param userId 用户ID
   * @returns 是否自动释放了技能
   */
  async autoCastLanyinSkill(userId: number): Promise<boolean> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (player.type !== '兰音') {
      return false;
    }

    // 计算公共冷却
    const skillKey = '兰音技能熟练度';
    const skillExp = this.playerService.getMarkerValue(markers, skillKey);
    const skillLevel = this.playerService.getSkillLevel(markers, '兰音');

    // 检查是否装备冷却核心
    const backpack = this.playerService.getBackpackItems(player);
    const hasCoolCore = backpack.some((item: any) => item.name === '冷却核心');

    // 公共冷却判断：有冷却核心时技能等级≥40则冷却为0，否则技能等级≥60则冷却为0
    let canAutoCast = false;
    if (hasCoolCore && skillLevel >= 40) {
      canAutoCast = true;
    } else if (!hasCoolCore && skillLevel >= 60) {
      canAutoCast = true;
    }

    if (!canAutoCast) {
      return false;
    }

    // 自动释放形神合一
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const cooldownMarker = markers2.find((m: any) => m.name === '形神合一');
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      return false; // 形神合一冷却中
    }

    // 设置形神合一冷却
    const newMarkers2 = markers2.filter((m: any) => m.name !== '形神合一');
    newMarkers2.push({
      name: '形神合一',
      expireAt: now + 60,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return true;
  }

  /**
   * 战斗女仆技能
   * RPG/机枪/震撼弹/云爆弹
   * 对应原版：战斗女仆武器技能()
   * @param userId 用户ID
   * @param weaponType 武器类型（rpg/machinegun/flashbang/thermobaric）
   * @returns 操作结果文本
   */
  async battleMaidSkill(userId: number, weaponType: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (player.type !== '战斗女仆') {
      return '需要战斗女仆才能使用此技能';
    }

    // 检查冷却
    const cooldownName = `战斗女仆_${weaponType}`;
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const cooldownMarker = markers2.find((m: any) => m.name === cooldownName);
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      const remaining = Math.ceil(cooldownMarker.expireAt - now);
      return `技能冷却中，剩余${remaining}秒`;
    }

    // 获取好感度
    const affinity = this.playerService.getMarkerValue(markers, '战斗女仆好感');
    const effect = this.getSkillEffect(affinity);

    let result = '';
    let cooldown = 120;
    let damage = 0;

    switch (weaponType) {
      case 'rpg':
        cooldown = 180;
        damage = Math.floor(300 + affinity * 2 * effect);
        result = `战斗女仆发射RPG！\n对目标造成 ${damage} 点爆炸伤害（冷却3分钟）`;
        break;
      case 'machinegun':
        cooldown = 60;
        damage = Math.floor(80 + affinity * 0.5 * effect);
        result = `战斗女仆端起机枪扫射！\n对目标造成 ${damage} 点伤害（冷却1分钟）`;
        break;
      case 'flashbang':
        cooldown = 120;
        const stunDuration = Math.floor(3 + 2 * effect);
        result = `战斗女仆投出震撼弹！\n目标被眩晕 ${stunDuration} 秒（冷却2分钟）`;
        break;
      case 'thermobaric':
        cooldown = 300;
        damage = Math.floor(500 + affinity * 3 * effect);
        result = `战斗女仆释放云爆弹！\n对全体敌人造成 ${damage} 点巨额伤害（冷却5分钟）`;
        break;
      default:
        return `未知武器类型：${weaponType}，可用类型：rpg、machinegun、flashbang、thermobaric`;
    }

    // 设置冷却
    const newMarkers2 = markers2.filter((m: any) => m.name !== cooldownName);
    newMarkers2.push({
      name: cooldownName,
      expireAt: now + cooldown,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return result;
  }

  /**
   * 恶毒好感度效果
   * 好感≥60全体攻击变溅射
   * 对应原版：恶毒溅射判断()
   * @param userId 用户ID
   * @returns 是否触发溅射效果
   */
  async venomSplash(userId: number): Promise<boolean> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (player.type !== '恶毒') {
      return false;
    }

    // 检查好感度是否≥60
    const affinityKey = '恶毒好感';
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);
    if (affinity < 60) {
      return false;
    }

    // 好感≥60时全体攻击变溅射
    return true;
  }

  /**
   * 伊卡洛斯歼灭模式
   * 额外攻击+3
   * 对应原版：伊卡洛斯额外攻击()
   * @param userId 用户ID
   * @returns 额外攻击次数
   */
  async icalusExtraAttack(userId: number): Promise<number> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (player.type !== '伊卡洛斯') {
      return 0;
    }

    // 检查是否处于歼灭模式（过期判定统一归一化）
    const buffs = this.playerService.safeJsonParse<any[]>(player.buffs, []);
    const inAnnihilationMode = hasActive(buffs, '歼灭模式');
    if (!inAnnihilationMode) {
      return 0;
    }

    // 额外攻击+3
    return 3;
  }

  /**
   * 普拉娜武器显示
   * 攻击时显示武器名
   * 对应原版：普拉娜武器显示()
   * @param userId 用户ID
   * @returns 武器名称文本
   */
  async planaWeaponDisplay(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (player.type !== '普拉娜') {
      return '';
    }

    // 获取当前武器
    const backpack = this.playerService.getBackpackItems(player);
    const weapons = backpack.filter((item: any) => item.type === '武器' || item.name.includes('枪') || item.name.includes('炮'));

    if (weapons.length === 0) {
      return '';
    }

    // 随机选择一个武器显示
    const weapon = weapons[Math.floor(Math.random() * weapons.length)];
    return `（${weapon.name}）`;
  }
}
