/**
 * 技能/变身指令域服务（game 模块化重构 P2-7 抽出）
 *
 * 职责：技能导航、使魔技能/通用技能、称号（领取/装备）、形态切换、变身、
 * 纳米服、装甲合体、安琪天使系列（缓天使/福音/绝灭）、牵引光束、控制终端
 * （含白色羁绊终端）、技能查看、生产模式、增幅器说明。
 * 依赖方向：依赖 Player、FamiliarSystemService、FamiliarSkillsService、Prisma、
 * GlobalProficiency、StaticData、CombatState、Map 与支撑层（buildNumberedMenu、
 * hasEquippedSpecial、millisecondsToText、mutatePlayer 等）；跨域直接注入兄弟
 * 子服务 RescueWhite（ensurePlayerWhite），单向边无环。
 * 单一真相源：称号/技能等级口径走 skillLevelInfo；世界等级走 GlobalProficiencyService。
 * 对口原版：_主程序.ecode 技能/变身/称号分支。
 */import { Injectable, Logger, Optional } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { formatDisplayNumber, roundItemQuantity } from '../../../common/utils/game-text.util';
import { round2 } from '.././player-pool.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { MapService } from '.././map.service';
import { FamiliarSystemService } from '.././familiar-system.service';
import { FamiliarSkillsService } from '.././familiar-skills.service';
import { StaticDataService } from '.././static-data.service';
import { CombatStateService } from '.././combat-state.service';
import { GlobalProficiencyService } from '.././global-proficiency.service';
import { GameSupportService } from '.././game-support.service';
import { RescueWhiteService } from './rescue-white.service';

@Injectable()
export class SkillCommandService {
  private readonly logger = new Logger(SkillCommandService.name);

  constructor(
    private readonly support: GameSupportService,
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
    private readonly familiarSystemService: FamiliarSystemService,
    private readonly familiarSkillsService: FamiliarSkillsService,
    private readonly staticData: StaticDataService,
    private readonly combatState: CombatStateService,
    // 跨域兄弟直连（P4 清理：原过渡期经门面引用），单向边无环。
    private readonly rescue: RescueWhiteService,
    @Optional() private readonly globalProficiency?: GlobalProficiencyService,
  ) {}

  async handleSkill(userId: number): Promise<string> {
    // 对齐原版：技能导航菜单（通用技能/使魔技能/查看成就/查看标记/查看标记2）。
    // 原版并无独立的“技能”指令直接倾倒技能说明，统一先走导航，
    // 再由「使魔技能」「通用技能」等具体指令展示内容，避免与它们重复。
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const lines: string[] = [`✨ ${player.name || '冒险者'} 技能导航:`, `━━━━━━━━━━━━━━━`];
    const options: { label: string; cmd: string }[] = [
      { label: '通用技能', cmd: '通用技能' },
      { label: '使魔技能', cmd: '使魔技能' },
      { label: '查看成就', cmd: '查看成就' },
      { label: '查看标记', cmd: '查看标记' },
      { label: '查看标记2', cmd: '查看标记2' },
    ];
    const menu = await this.support.buildNumberedMenu(userId, options, '💡 发送编号数字即可查看对应内容');
    lines.push(...menu);
    return lines.join('\n');
  }

  /**
   * 处理救助命令
   * 对应原版：救助 命令（救起倒地使魔，或维修使魔的载具）
   */

  async handleFamiliarSkills(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, buffs, markers2 } = playerData;

    if (!player.type) {
      return '你还没有选择使魔，请先发送「选择使魔」来选择';
    }

    const familiar = this.staticData.getFamiliarByName(player.type);
    if (!familiar) {
      return `未知的使魔类型: ${player.type}`;
    }

    // 获取好感度
    const affinityKey = `${player.type}好感`;
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);

    // 获取技能等级（原版：熟练度等级 = 玩家.标记中"使魔名称+技能熟练度"，计算等级）
    const skillExp = this.playerService.getMarkerValue(markers, `${player.type}技能熟练度`);
    let skillLevel = this.playerService.getSkillLevel(markers, player.type);

    // 特殊装备加成：千泠 +10，粽子 buff +10（对齐原版 _主程序.ecode L4096-L4100）
    if (this.support.hasEquippedSpecial(playerData, '千泠', 0)) {
      skillLevel += 10;
    }
    const dummyStrength = { value: 0 };
    const dummyRemain = { value: 0 };
    if (this.combatState.buffRequire('粽子', buffs, dummyStrength, Date.now(), dummyRemain)) {
      skillLevel += 10;
    }

    // 计算熟练度文本 "等级(熟练度/等级平方)"
    const roundedExp = roundItemQuantity(skillExp);
    const skillLevelText = `${skillLevel}(${roundedExp}/${skillLevel * skillLevel})`;

    // 获取基础说明 + 特性 + 技能描述（对齐原版：w = 使魔列表[a].说明 + #换行符 + 使魔列表[a].技能说明）
    const lines: string[] = [];
    lines.push(`${player.name}(好感${Math.round(affinity)})`);
    lines.push(`技能等级: ${skillLevelText}`);

    // 特性（description字段通常包含特性）
    if (familiar.description) {
      lines.push(`${familiar.description.replace(/#换行/g, '\n')}`);
    }

    // 基础技能描述（skillDesc）
    if (familiar.skillDesc) {
      let skillDesc = familiar.skillDesc;

      // 替换技能等级占位符（对齐原版 数据显示.ecode L1801-L1844）
      const replacements: Record<string, string> = {
        '【0.25技能等级】': formatDisplayNumber(skillLevel / 4),
        '【0.5技能等级】': formatDisplayNumber(skillLevel / 2),
        '【0.75技能等级】': formatDisplayNumber(skillLevel * 0.75),
        '【1技能等级】': String(skillLevel),
        '【2技能等级】': String(skillLevel * 2),
        '【2.5技能等级】': formatDisplayNumber(skillLevel * 2.5),
        '【3技能等级】': String(skillLevel * 3),
        '【4技能等级】': String(skillLevel * 4),
        '【5技能等级】': String(skillLevel * 5),
        '【10技能等级】': String(skillLevel * 10),
        '【0.005技能等级】': String(Math.round(skillLevel / 200 * 10000) / 10000),
        '【0.01技能等级】': String(Math.round(skillLevel * 0.01 * 10000) / 10000),
        '【0.02技能等级】': String(Math.round(skillLevel * 0.02 * 10000) / 10000),
        '【0.025技能等级】': String(Math.round(skillLevel * 0.025 * 10000) / 10000),
        '【0.03技能等级】': String(Math.round(skillLevel * 0.03 * 10000) / 10000),
        '【0.04技能等级】': String(Math.round(skillLevel * 0.04 * 10000) / 10000),
        '【0.05技能等级】': String(Math.round((skillLevel / 20) * 100) / 100),
        '【0.1技能等级】': String(Math.round((skillLevel / 10) * 100) / 100),
        '【0.2技能等级】': String(Math.round((skillLevel / 5) * 100) / 100),
        '【使魔等级x': `【${player.level}x`,
      };
      for (const [key, value] of Object.entries(replacements)) {
        skillDesc = skillDesc.replace(new RegExp(key.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1'), 'g'), value);
      }
      // 当等级=1时处理剩余的占位符（对齐原版 L1823-L1842）
      if (skillLevel <= 1) {
        const defaultReplacement: Record<string, string> = {
          '【1技能等级】': '每级1',
          '【2技能等级】': '每级2',
          '【2.5技能等级】': '每级2.5',
          '【3技能等级】': '每级3',
          '【4技能等级】': '每级4',
          '【5技能等级】': '每级5',
          '【10技能等级】': '每级10',
          '【0.75技能等级】': '每级0.75',
          '【0.5技能等级】': '每级0.5',
          '【0.25技能等级】': '每级0.25',
          '【0.005技能等级】': '每级0.005',
          '【0.01技能等级】': '每级0.01',
          '【0.02技能等级】': '每级0.02',
          '【0.025技能等级】': '每级0.025',
          '【0.03技能等级】': '每级0.03',
          '【0.04技能等级】': '每级0.04',
          '【0.05技能等级】': '每级0.05',
          '【0.1技能等级】': '每级0.1',
          '【0.2技能等级】': '每级0.2',
          '+每级': '每级+',
          '-每级': '每级-',
        };
        for (const [key, value] of Object.entries(defaultReplacement)) {
          skillDesc = skillDesc.replace(new RegExp(key.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1'), 'g'), value);
        }
      }
      skillDesc = skillDesc.replace(/#换行/g, '\n');
      lines.push(skillDesc);
    }

    // 好感度解锁效果（对齐原版：逐个遍历，显示 "好感N解锁:" + 说明，已解锁显示描述）
    const affinityDesc = familiar.affinityDesc || [];
    const affinityList = asJsonValue<any[]>(affinityDesc, []);

    for (let i = 0; i < affinityList.length; i++) {
      const unlockAt = 20 * (i + 1);
      const desc = affinityList[i];
      if (affinity >= unlockAt) {
        lines.push(`${desc}`);
      } else {
        lines.push(`好感${unlockAt}解锁:${desc}`);
      }
    }

    // 检查冷却状态（如果是主动技能，显示剩余冷却）
    const skillName = familiar.uniqueSkill;
    if (skillName && Array.isArray(markers2)) {
      const cdList = markers2.filter((m: any) => m && m.name === skillName);
      if (cdList.length > 0) {
        const now = Date.now();
        const remain = Math.ceil((cdList[0].expireAt - now) / 1000);
        if (remain > 0) {
          lines.push('');
          lines.push(`${skillName}`);
          lines.push(`${player.name}还需要${remain}秒`);
        }
      }
    }

    return lines.filter(Boolean).join('\n');
  }

  /**
   * 处理通用技能命令
   * 显示所有技能熟练度等级和加成（世界等级、战斗等级、防御等级...）
   * 对应原版：_主程序.ecode L4010-L4085
   */

  async handleCommonSkills(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 世界等级 = 原版 显示熟练度等级(全局标记,"世界")，由全局熟练度换算（不再是独立配置项）
    const wLevel = this.globalProficiency ? await this.globalProficiency.worldLevel() : 1;

    const lines: string[] = [];
    lines.push(`${player.name}`);

    // ---- 世界等级（原版 _主程序 L4012-L4023）----
    // 世界等级由全局熟练度换算，故「怪物等级+」确切成立：刷怪时确实会加该等级
    lines.push(`世界等级:${wLevel}`);
    lines.push(`  怪物等级+${wLevel}\t经验获取+${wLevel / 2}%`);
    // 新人加成：玩家等级 < 世界等级 × 10 时获得（原版：差距 = 1 - 等级/(世界等级×10)）
    if (player.level < wLevel * 10) {
      const gap = 1 - player.level / (wLevel * 10);
      lines.push(`新人加成:`);
      lines.push(`  伤害+${Math.round(10000 / (1 - gap)) / 100}%`);
      lines.push(`  减伤+${Math.round(gap * 10000) / 100}%`);
    }
    // 与最高级玩家的等级差距经验加成（原版 L4018-L4023）
    try {
      const maxPlayer = await this.prisma.player.findFirst({
        orderBy: { level: 'desc' },
        select: { level: true },
      });
      const maxLevel = maxPlayer?.level ?? player.level;
      if (maxLevel - player.level > 1) {
        lines.push(`你和最高级玩家等级差距: ${maxLevel - player.level}`);
        lines.push(`  经验获取+${(maxLevel - player.level) * 2}%`);
      } else {
        lines.push(`  经验获取+0%`);
      }
    } catch {
      lines.push(`  经验获取+0%`);
    }

    // ---- 各属性等级（原版 _主程序 L4024-L4085，标记名 = 名称+"熟练度"）----
    const scale = 1 + player.level / 100;
    // 两位小数统一走 player-pool.util.round2（原局部副本已删除，2026-09-10 口径收敛）
    const scaleLevel = (a: number) => round2(a * scale);

    // 通用技能配置：key=标记后缀，label=行首文本，attr=属性说明与取值函数
    const skills: Array<{ key: string; label: string; attrs: Array<{ desc: string; val: (a: number) => string }> }> = [
      {
        key: '战斗', label: '战斗等级',
        attrs: [
          { desc: '攻击+', val: (a) => String(scaleLevel(a)) },
          { desc: '命中+', val: (a) => String(round2((a / 2) * scale)) },
        ],
      },
      {
        key: '防御', label: '防御等级',
        attrs: [
          { desc: '生命/装甲/护盾+', val: (a) => String(scaleLevel(a)) },
          { desc: '闪避+', val: (a) => String(round2((a / 2) * scale)) },
        ],
      },
      {
        key: '闪避', label: '闪避等级',
        attrs: [
          { desc: '闪避时间+', val: (a) => `${round2((a / (25 + a)) * 100)}%` },
          { desc: '速度+', val: (a) => String(round2((a / 4) * scale)) },
        ],
      },
      {
        key: '采集', label: '采集等级',
        attrs: [{ desc: '采集+', val: (a) => `${round2(a * (1 + player.level / 1000))}%` }],
      },
      {
        key: '任务', label: '任务等级',
        attrs: [{ desc: '任务奖励+', val: (a) => `${a}%` }],
      },
      {
        key: '物理', label: '物理等级',
        attrs: [{ desc: '物攻+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '火焰', label: '火焰等级',
        attrs: [{ desc: '火攻+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '冰冻', label: '冰冻等级',
        attrs: [{ desc: '冰攻+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '雷电', label: '雷电等级',
        attrs: [{ desc: '电攻+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '暴击', label: '暴击等级',
        attrs: [{ desc: '暴击伤害+', val: (a) => `${a}%` }],
      },
      {
        key: '致命', label: '致命等级',
        attrs: [{ desc: '致命一击伤害x', val: (a) => String(round2(1 + a / 500)) }],
      },
      {
        key: '强力', label: '强力等级',
        attrs: [{ desc: '强力一击伤害x', val: (a) => String(round2(1 + a / 400)) }],
      },
      {
        key: '正中', label: '正中等级',
        attrs: [{ desc: '正中一击伤害x', val: (a) => String(round2(1 + a / 300)) }],
      },
      {
        key: '擦过', label: '擦过等级',
        attrs: [{ desc: '擦过一击伤害x', val: (a) => String(round2(1 + a / 200)) }],
      },
      {
        key: '描边', label: '描边等级',
        attrs: [{ desc: '描边一击伤害x', val: (a) => String(round2(1 + a / 100)) }],
      },
      {
        key: '射弹武器', label: '射弹武器等级',
        attrs: [{ desc: '射弹武器攻击+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '能量武器', label: '能量武器等级',
        attrs: [{ desc: '能量武器攻击+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '制导武器', label: '制导武器等级',
        attrs: [{ desc: '制导武器攻击+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '近战武器', label: '近战武器等级',
        attrs: [{ desc: '近战武器攻击+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '幽能武器', label: '幽能武器等级',
        attrs: [{ desc: '幽能武器攻击+', val: (a) => String(scaleLevel(a)) }],
      },
    ];

    for (const skill of skills) {
      const { level, text } = this.skillLevelInfo(markers, skill.key);
      lines.push(`${skill.label}:${text}`);
      for (const attr of skill.attrs) {
        lines.push(`  ${attr.desc}${attr.val(level)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 计算某熟练度标记对应的等级与显示文本
   * 对齐原版 数据显示.ecode L1640-L1665 显示熟练度等级()：
   * 等级 = 满足 熟练度 < 等级² 的最小整数；文本 = "等级(熟练度/等级²)"。
   * @param markers 玩家标记
   * @param name 熟练度名称（读取 markers["名称+熟练度"]）
   */

  skillLevelInfo(
    markers: Record<string, any>,
    name: string,
  ): { level: number; text: string } {
    const prof = Math.max(0, Number(this.playerService.getMarkerValue(markers, `${name}熟练度`)) || 0);
    let level = 1;
    while (prof >= level * level) level += 1;
    const rounded = Math.round(prof * 100) / 100;
    return { level, text: `${level}(${rounded}/${level * level})` };
  }

  /**
   * 处理使魔称号命令
   * 查看使魔称号列表
   * 委托到 FamiliarSystemService.viewTitles 查看可获得的称号
   */

  async handleFamiliarTitles(userId: number): Promise<string> {
    // 委托到熟悉系统服务查看称号列表
    return this.familiarSystemService.viewTitles(userId);
  }

  /**
   * 处理领取称号命令
   * 领取指定的称号
   * 委托到 FamiliarSystemService.claimTitle 领取称号
   */

  async handleClaimTitle(userId: number, titleName: string): Promise<string> {
    // 委托到熟悉系统服务领取指定称号
    return this.familiarSystemService.claimTitle(userId, titleName);
  }

  /**
   * 处理佩戴称号命令
   * 佩戴指定的称号
   * 委托到 FamiliarSystemService.equipTitle 佩戴称号
   */

  async handleEquipTitle(userId: number, titleName: string): Promise<string> {
    // 委托到熟悉系统服务佩戴指定称号
    return this.familiarSystemService.equipTitle(userId, titleName);
  }

  /**
   * 使魔排行（原版 _主程序.ecode L9562-9745 十子榜）
   * 子榜：战斗力/等级/理论输出/最高伤害/击杀/在线时间/财富/宠物战斗力/宠物最高伤害/载具
   * 无参时输出 10 项编号菜单并注册临时输入替换（原版 L9565 w3；红线：编号菜单必须注册）。
   * 玩家类子榜过滤=老玩家(已选使魔)且等级>10（原版 L9571 等）；
   * 统一 top30 输出「N、名称(数值)」，在线时间子榜用时间格式（原版 数字到时间）。
   */

  async handleSwitchMode(userId: number, modeName: string): Promise<string> {
    // 委托到使魔技能服务执行切换模式技能，传入模式名称作为目标参数
    return this.familiarSkillsService.executeSkill(userId, '切换模式', modeName);
  }

  /**
   * 处理纳米生化装命令
   * 纳米生化装模式切换
   * 委托到 FamiliarSkillsService.executeSkill 执行纳米生化装技能
   */

  async handleModeChange(userId: number, modeName: string): Promise<string> {
    // 阿尔缇娜「模式转换」优先（原版 _主程序.ecode L9810-9821：切换战术壳光剑 a模式）
    // 与载具模式转换同名，按使魔类型分流。原版该分支是**精确匹配** `消息数据 == "模式转换"`，
    // 带参数（如「模式转换 战斗」）不会进入 → 此处同样只在未带模式名时拦截。
    // 原版该分支不计「使用技能」，故 skipUseSkillTask。
    if (!modeName) {
      const peek = await this.playerService.getPlayerData(userId);
      if (peek?.player?.type === '阿尔缇娜' || Number(peek?.player?.specialSeq ?? 0) === 7) {
        return this.familiarSkillsService.executeSkill(
          userId, '模式转换', undefined, { skipUseSkillTask: true },
        );
      }
    }

    if (!modeName) {
      return '请指定要转换的模式，格式：模式转换 模式名\n可用模式：战斗、移动、防御、隐匿';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    // 模式列表
    const modes: Record<string, string> = {
      '战斗': '战斗模式 - 提升攻击力',
      '移动': '移动模式 - 提升速度',
      '防御': '防御模式 - 提升装甲和护盾',
      '隐匿': '隐匿模式 - 提升闪避',
    };

    if (!modes[modeName]) {
      return `未知模式「${modeName}」\n可用模式：${Object.keys(modes).join('、')}`;
    }

    // 存储载具模式到 markers
    markers['vehicle_mode'] = modeName;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 将载具切换为${modeName}模式`);
    return `✅ 载具已切换为${modeName}\n${modes[modeName]}`;
  }

  /**
   * 处理转换命令
   * 载具形态转换
   * 对应原版：转换 命令
   */

  async handleTransform(userId: number, targetForm: string): Promise<string> {
    if (!targetForm) {
      return '请指定要转换的形态，格式：转换 形态名';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    // 存储载具形态到 markers
    markers['vehicle_form'] = targetForm;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 将载具转换为${targetForm}形态`);
    return `✅ 载具已转换为【${targetForm}】形态`;
  }

  /**
   * 处理牵引光束命令
   * 使用工业牵引光束拖拽目标
   * 对应原版：牵引 命令
   */

  async handleTransformText(userId: number, text: string): Promise<string> {
    return `📝 文本转换功能开发中...`;
  }

  /**
   * 保存图片（管理员/作者）（原版 _主程序.ecode L10666-10680）。
   * 仅作者权限可用；Web 架构下图片由前端 URL 承载，“保存图片 <名称>”无独立行为。
   */

  async handleNanoSuit(userId: number, action: string): Promise<string> {
    // 委托到使魔技能服务执行纳米生化装技能，传入动作参数
    return this.familiarSkillsService.executeSkill(userId, '纳米生化装', action);
  }

  /**
   * 处理铠甲合体命令
   * 使魔铠甲合体
   * 对应原版：铠甲合体/炎龙/黑犀/飞影/地虎/雪獒 命令
   * 委托到 FamiliarSkillsService.executeSkill 执行铠甲合体技能
   * @param armorName 铠甲名称（可选，如炎龙/黑犀/飞影/地虎/雪獒）
   */

  async handleArmorCombine(userId: number, armorName?: string): Promise<string> {
    if (armorName) {
      return `⚡ ${armorName}铠甲，合体！铠甲激活成功！`;
    }
    // 委托到使魔技能服务执行铠甲合体技能
    return this.familiarSkillsService.executeSkill(userId, '铠甲合体');
  }

  /**
   * 处理使魔挑战命令
   * 查看使魔挑战列表，进入挑战模式
   * 委托到 FamiliarSkillsService.executeSkill 执行使魔挑战技能
   */

  async handleEaseAngel(userId: number, targetName?: string): Promise<string> {
    // 对应原版 _主程序.ecode L995-1041：目标可为自己、当前地图召唤物或其他玩家。
    return this.familiarSystemService.safetyAngel(userId, targetName?.trim() || undefined);
  }

  /**
   * 处理福音书命令
   * 装备技能：增益效果
   * 委托到 FamiliarSkillsService.executeSkill 执行福音书技能
   */

  async handleGospel(userId: number, targetName?: string): Promise<string> {
    // 对应原版 _主程序.ecode L1044-1090：一天一次，目标解析与安乐天使相同。
    return this.familiarSystemService.gospelBook(userId, targetName?.trim() || undefined);
  }

  /**
   * 处理启示录命令
   * 装备技能：攻击提升
   * 委托到 FamiliarSkillsService.executeSkill 执行启示录技能
   */

  async handleApocalypse(userId: number): Promise<string> {
    // 委托到使魔技能服务执行启示录技能，提升攻击力
    return this.familiarSkillsService.executeSkill(userId, '启示录');
  }

  /**
   * 处理切换模式命令
   * 使魔模式切换
   * 委托到 FamiliarSkillsService.executeSkill 执行切换模式技能
   */

  async handleTractorBeam(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具，无法使用牵引光束';
    }

    if (!targetName) {
      return '请指定牵引目标，格式：牵引 目标名';
    }

    // 检查载具是否安装了功能部件（partType=4）
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) return '载具数据不存在';

    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const funcParts = parts.filter((p: any) => p.partType === 4);

    if (funcParts.length === 0) {
      return '载具没有安装功能部件，无法使用牵引光束\n请先安装功能部件';
    }

    // 查找目标（可能是玩家或物品）
    const targetUser = await this.prisma.user.findUnique({
      where: { qqNumber: targetName },
    });

    this.logger.log(`玩家 ${userId} 使用牵引光束拖拽目标 ${targetName}`);

    if (targetUser) {
      return `🔦 牵引光束已锁定目标玩家【${targetUser.nickname || targetUser.username}】\n正在拖拽...\n（牵引功能简化版，实际效果取决于目标状态）`;
    }

    return `🔦 牵引光束已锁定目标【${targetName}】\n正在拖拽...`;
  }

  /**
   * 处理控制终端命令（对齐原版 _主程序.ecode L10714-10871）：
   * 原版控制终端是「白」的羁绊终端——当前地图存在自己的白时可查看/设置她的两个
   * 羁绊技能槽（技能a：武器增伤；技能b：宠物饲养/生存之道/贴心助手），每天可改一次。
   * 白不在附近时回退到新框架的载具控制终端。
   * @param arg 子命令：空=总览；技能a[编号]/技能b[编号]=查看或设置
   */

  async handleControlTerminal(userId: number, arg = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const map = await this.mapService.getMapById(player.mapId);

    // 原版：当前地图存在归属自己的「白」→ 羁绊终端
    if (map) {
      const white = await this.rescue.ensurePlayerWhite(player, map).catch(() => null);
      if (white) {
        return this.handleWhiteBondTerminal(userId, player, markers, String(arg || '').trim());
      }
    }

    if (!player.vehicle) {
      return `${player.name || '冒险者'}白不在附近，无法操作她的控制终端`;
    }

    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) return '载具数据不存在';

    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const currentMode = markers['vehicle_mode'] || '战斗';
    const currentForm = markers['vehicle_form'] || '标准';

    // 统计各类型部件数量
    const typeCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const part of parts) {
      typeCounts[part.partType] = (typeCounts[part.partType] || 0) + 1;
    }

    return [
      `🖥️ 载具控制终端`,
      `━━━━━━━━━━━━━━━`,
      `🚗 ${vehicle.name}`,
      `❤️ 耐久: ${vehicle.currentHp}/${vehicle.maxHp}`,
      `━━━━━━━━━━━━━━━`,
      `📊 当前状态:`,
      `  模式: ${currentMode}`,
      `  形态: ${currentForm}`,
      `  部件: ${parts.length}个安装`,
      `━━━━━━━━━━━━━━━`,
      `📋 可用操作:`,
      `  驾驶 - 切换载具`,
      `  脱出 - 离开载具`,
      `  载具 - 查看状态`,
      `  安装 - 安装部件`,
      `  拆卸 - 拆卸部件`,
      `  架炮 - 架设武器`,
      `  模式转换 - 切换模式`,
      `  转换 - 切换形态`,
      `  牵引 - 使用牵引光束`,
      `  维修 - 修复耐久度`,
      `━━━━━━━━━━━━━━━`,
      `插槽使用:`,
      `  核心: ${typeCounts[0] || 0}/1`,
      `  武器: ${typeCounts[3] || 0}/${vehicle.maxWeapon || 5}`,
      `  防御: ${typeCounts[1] || 0}/${vehicle.maxDefense || 5}`,
      `  行走: ${typeCounts[2] || 0}/${vehicle.maxMove || 5}`,
      `  功能: ${typeCounts[4] || 0}/${vehicle.maxFunction || 5}`,
    ].join('\n');
  }

  /** 白的羁绊技能1（原版 控制终端技能a：按当前武器类型 +15 攻击2）。 */
  static readonly BOND_SKILL_A: Array<{ id: number; name: string; desc: string }> = [
    { id: 1, name: '利器管理', desc: '羁绊者使用近战武器时攻击提高0.15倍' },
    { id: 2, name: '弹道分析', desc: '羁绊者使用射弹武器时攻击提高0.15倍' },
    { id: 3, name: '能量稳定', desc: '羁绊者使用能量武器时攻击提高0.15倍' },
    { id: 4, name: '燃料优化', desc: '羁绊者使用制导武器时攻击提高0.15倍' },
    { id: 5, name: '幽能亲和', desc: '羁绊者使用幽能武器时攻击提高0.15倍' },
  ];

  /** 白的羁绊技能2（原版 控制终端技能b）。 */
  static readonly BOND_SKILL_B: Array<{ id: number; name: string; desc: string }> = [
    { id: 1, name: '宠物饲养', desc: '羁绊者的宠物搜索得到的物品+20%' },
    { id: 2, name: '生存之道', desc: '为羁绊者的远程武器安装一个带特殊加速轨道的消音器，羁绊者使用远程武器攻击时附带攻击伤害的15%随机属性伤害，攻击为隐匿攻击，冷却30秒' },
    { id: 3, name: '贴心助手', desc: '羁绊者使用技能得到的经验+25%' },
  ];


  bondSkillLabel(slot: 'a' | 'b', value: number): string {
    if (!value) return '未指定';
    const list = slot === 'a' ? SkillCommandService.BOND_SKILL_A : SkillCommandService.BOND_SKILL_B;
    return list.find((skill) => skill.id === Number(value))?.name ?? '未指定';
  }

  /**
   * 白的羁绊终端（原版 _主程序.ecode L10714-10871）：
   * 总览展示技能1/技能2 当前设置；技能a/技能b 查看候选并设置，每天（有效期当天）只能改一次。
   */

  async handleWhiteBondTerminal(
    userId: number,
    player: any,
    markers: Record<string, any>,
    arg: string,
  ): Promise<string> {
    const sub = arg.replace(/\d+/g, '');
    const choice = Number((arg.match(/\d+/) || ['0'])[0]) || 0;
    const slot: 'a' | 'b' | '' = sub.includes('技能a') ? 'a' : sub.includes('技能b') ? 'b' : '';

    if (!slot) {
      // 总览（原版 L10840-10869）
      const lines = [
        `【白】`,
        `羁绊者:${player.name || ''}`,
        `技能1:${this.bondSkillLabel('a', Number(markers['bj1'] || 0))}`,
        `技能2:${this.bondSkillLabel('b', Number(markers['bj2'] || 0))}`,
      ];
      const menu = await this.support.buildNumberedMenu(userId, [
        { label: '选择技能1', cmd: '控制终端技能a' },
        { label: '选择技能2', cmd: '控制终端技能b' },
      ], '💡 发送编号数字(如 1)快速操作');
      lines.push(...menu);
      return lines.join('\n');
    }

    const skillList = slot === 'a' ? SkillCommandService.BOND_SKILL_A : SkillCommandService.BOND_SKILL_B;
    const skillLabel = () => this.bondSkillLabel(slot, Number(markers[slot === 'a' ? 'bj1' : 'bj2'] || 0));

    if (!choice) {
      // 候选列表（原版 L10739-10762）：当前设置 + 0未指定 + 各技能说明
      const lines = [`${player.name || '冒险者'}`, `当前:${skillLabel()}`, `0、未指定`, `——————————`];
      for (const skill of skillList) {
        lines.push(`${skill.id}、${skill.name}`);
        lines.push(`  ${skill.desc}`);
        lines.push(`——————————`);
      }
      const options = [
        { label: '未指定', cmd: `控制终端技能${slot}0` },
        ...skillList.map((skill) => ({ label: skill.name, cmd: `控制终端技能${slot}${skill.id}` })),
      ];
      const menu = await this.support.buildNumberedMenu(userId, options, '💡 发送编号数字即可设置对应技能');
      lines.push(...menu);
      return lines.join('\n');
    }

    if (choice < 0 || choice > skillList.length) {
      return `${player.name || '冒险者'}不是被允许选择的项目`;
    }

    // 每天只能修改一次（原版 时间间隔要求("gbj1/gbj2", 有效期当天(), 标记2)）
    const markers2 = asJsonValue<any[]>(player.markers2, []);
    const cooldownName = slot === 'a' ? 'gbj1' : 'gbj2';
    const now = Date.now();
    const endOfDay = new Date();
    endOfDay.setHours(24, 0, 0, 0);
    const active = markers2.find((m: any) => (m?.name ?? m?.名称) === cooldownName);
    const activeExpire = Number(active?.expireAt ?? active?.有效期至 ?? 0) || 0;
    if (activeExpire > now) {
      const remainSec = Math.max(1, Math.ceil((activeExpire - now) / 1000));
      return `${player.name || '冒险者'}今天已经设置过了，还需${this.support.millisecondsToText(remainSec * 1000)}后才能再次修改`;
    }
    const marker = { name: cooldownName, expireAt: endOfDay.getTime() };
    const idx = markers2.findIndex((m: any) => (m?.name ?? m?.名称) === cooldownName);
    if (idx >= 0) markers2[idx] = marker;
    else markers2.push(marker);

    markers[slot === 'a' ? 'bj1' : 'bj2'] = choice;
    player.markers = markers; // Json 列直接写对象
    player.markers2 = markers2; // Json 列直接写数组
    // 指令路径在 PlayerMutateService 快照内，外层统一落库，无需裸 savePlayer。
    return `${player.name || '冒险者'}\n白的技能${slot === 'a' ? 1 : 2}被设置为${skillLabel()}`;
  }

  /**
   * 处理载具操作命令
   * 查看载具操作指南
   * 对应原版：载具操作 命令
   */

  async handleViewSkills(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const lines: string[] = [`✨ ${player.name || '冒险者'} 技能导航:`, `━━━━━━━━━━━━━━━`];
    const options: { label: string; cmd: string }[] = [
      { label: '通用技能', cmd: '通用技能' },
      { label: '使魔技能', cmd: '使魔技能' },
      { label: '查看成就', cmd: '查看成就' },
      { label: '查看标记', cmd: '查看标记' },
      { label: '查看标记2', cmd: '查看标记2' },
    ];
    const menu = await this.support.buildNumberedMenu(userId, options, '💡 发送编号数字即可查看对应内容');
    lines.push(...menu);
    return lines.join('\n');
  }

  /**
   * 处理查看标记命令（对应原版 _主程序.ecode L5561）
   * 列出玩家持久化标记（markers 键值对）。
   */

  async handleProductionMode(userId: number, mode: number): Promise<string> {
    return mode === 0 ? '🏭 已切换为正常生产模式。' : '🏭 已切换为超载生产模式。';
  }

  /**
   * 转换文本
   * 对应原版：转换文本 命令
   */

  async handleAmplifierHelp(userId: number): Promise<string> {
    return [
      `📈 增幅器系统说明`,
      `━━━━━━━━━━━━━━━`,
      `增幅器是一种可以提升玩家属性的特殊装备，佩戴在增幅器插槽中。`,
      `━━━━━━━━━━━━━━━`,
      `【增幅器类型】`,
      `  1. 攻击增幅器 - 提升攻击力`,
      `  2. 防御增幅器 - 提升防御力`,
      `  3. 生命增幅器 - 提升最大生命值`,
      `  4. 速度增幅器 - 提升移动速度`,
      `  5. 暴击增幅器 - 提升暴击率和暴击伤害`,
      `━━━━━━━━━━━━━━━`,
      `【使用方法】`,
      `  装备增幅器：装备 增幅器名`,
      `  查看已装备：信息`,
      `━━━━━━━━━━━━━━━`,
      `增幅器可以通过战斗掉落、商店购买或合成获得。`,
    ].join('\n');
  }

  // ========== 宠物/社交命令 ==========

  /**
   * 处理开始捕捉命令
   * 开始捕捉宠物/使魔，委托到 FamiliarSystemService 的捕捉系统
   * 对应原版：开始捕捉 命令
   */
}
