/**
 * 技能/变身指令域：技能导航、使魔技能/通用技能、称号（领取/装备）、形态切换、变身、纳米服、
 * 装甲合体、安琪天使系列（缓天使/福音/绝灭）、控制终端（含白色羁绊终端）、技能查看、
 * 生产模式、增幅器说明。跨域直连 RescueWhite（ensurePlayerWhite），单向边无环。
 * 单一真相源：称号/技能等级口径走 skillLevelInfo；世界等级走 GlobalProficiencyService；
 * 白的羁绊技能表走 bond-skill.util。对口原版：_主程序.ecode 技能/变身/称号分支。
 */import { Injectable, Logger, Optional } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { CARD_DIVIDER, formatDisplayNumber, roundItemQuantity } from '../../../common/utils/game-text.util';
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
// 白的羁绊技能表（bj1/bj2 技能名、候选列表、标记键）单一真相源
import { BOND_COOLDOWN_KEY, bondMarkerKey, bondSkillList, bondSkillName } from '../bond-skill.util';

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
    // 跨域兄弟直连，单向边无环
    private readonly rescue: RescueWhiteService,
    @Optional() private readonly globalProficiency?: GlobalProficiencyService,
  ) {}

  async handleSkill(userId: number): Promise<string> {
    return this.buildSkillNavigation(userId);
  }

  /**
   * 技能导航菜单（通用技能/使魔技能/查看成就/查看标记/查看标记2）。
   * 原版并无独立的“技能”指令直接倾倒技能说明，统一先走导航，
   * 再由「使魔技能」「通用技能」等具体指令展示内容，避免与它们重复。
   * 「技能」与「查看技能」两条指令共用本实现。
   */
  private async buildSkillNavigation(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const lines: string[] = [`✨ ${player.name || '冒险者'} 技能导航:`, CARD_DIVIDER];
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
   * 使魔技能说明：好感度 + 技能等级(熟练度) + 特性/技能描述 + 好感解锁项 + 主动技能剩余冷却。
   * 对应原版：_主程序.ecode L4086-L4106 + 数据显示.ecode L1770-L1846 显示使魔技能()。
   * 输出组装口径见方法内「基础说明 + 特性 + 技能描述」注释。
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

    // description 字段通常承载特性
    if (familiar.description) {
      lines.push(`${familiar.description.replace(/#换行/g, '\n')}`);
    }

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

    // 主动技能若仍在冷却，末尾附剩余秒数
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
   * 通用技能：显示所有技能熟练度等级与加成（世界等级、战斗等级、防御等级…）
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
    // 两位小数统一走 player-pool.util.round2，勿在此另建取整实现
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
   * 某熟练度标记对应的等级与显示文本；对齐原版 数据显示.ecode L1640-L1665 显示熟练度等级()：
   * 等级 = 满足 熟练度 < 等级² 的最小整数；文本 = "等级(熟练度/等级²)"。
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

  /** 使魔称号列表 → FamiliarSystemService.viewTitles */
  async handleFamiliarTitles(userId: number): Promise<string> {
    return this.familiarSystemService.viewTitles(userId);
  }

  /** 所有称号及领取状态 → FamiliarSystemService.viewAvailableTitles */
  async handleAvailableTitles(userId: number): Promise<string> {
    return this.familiarSystemService.viewAvailableTitles(userId);
  }

  /** 领取指定称号 → FamiliarSystemService.claimTitle */
  async handleClaimTitle(userId: number, titleName: string): Promise<string> {
    return this.familiarSystemService.claimTitle(userId, titleName);
  }

  /** 佩戴指定称号 → FamiliarSystemService.equipTitle */
  async handleEquipTitle(userId: number, titleName: string): Promise<string> {
    return this.familiarSystemService.equipTitle(userId, titleName);
  }

   /**
    * 切换模式技能（模式名称作为目标参数）→ FamiliarSkillsService.executeSkill
    * 使魔排行（原版 _主程序.ecode L9562-9745 十子榜）
    */
  async handleSwitchMode(userId: number, modeName: string): Promise<string> {
    return this.familiarSkillsService.executeSkill(userId, '切换模式', modeName);
  }

  /** 模式转换（阿尔缇娜专属技能）→ executeSkill('模式转换') */
  async handleModeChange(userId: number, modeName: string): Promise<string> {
    // 原版 _主程序.ecode L9810-9821：仅精确匹配「模式转换」的阿尔缇娜专属技能
    // （战术壳光剑 a模式 0/1），不计「使用技能」。带参数不进入该分支。
    if (String(modeName || '').trim()) {
      return `${await this.peekPlayerName(userId)}这是阿尔缇娜的技能`;
    }
    return this.familiarSkillsService.executeSkill(
      userId, '模式转换', undefined, { skipUseSkillTask: true },
    );
  }

  private async peekPlayerName(userId: number): Promise<string> {
    const data = await this.playerService.getPlayerData(userId);
    return String(data?.player?.name || '冒险者');
  }

  /**
   * 处理转换命令（原版 _主程序.ecode L9823-L9866）。
   * - 伊芙利特（特殊序号11）：好感≥20 时切换 攻击模式 0/1（斧形态/炮形态）
   * - 其他使魔：「这是伊芙利特的技能」
   * 不是载具形态切换。
   */

  async handleTransform(userId: number, targetForm?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const name = player.name || '冒险者';

    if (Number(player.specialSeq ?? 0) !== 11 && String(player.type || '') !== '伊芙利特') {
      return `${name}这是伊芙利特的技能`;
    }

    const affinity = Number(player.affinity ?? 0)
      || Number(markers?.['伊芙利特好感'] || markers?.['好感'] || 0);
    if (affinity < 20) {
      return `${name}需要好感大于等于20`;
    }

    const sets = this.parseSets(player.sets);
    const current = Number(player.attackMode ?? sets.attackMode ?? sets.攻击模式 ?? 0);
    const next = current === 1 ? 0 : 1;
    sets.attackMode = next;
    sets.攻击模式 = next;
    player.sets = sets;
    player.attackMode = next;
    await this.playerService.savePlayer(player);

    if (next === 1) {
      return `${name}切换成了炮形态，“炮击森林出口”来指定攻击的区域`;
    }
    return `${name}切换成了斧形态`;
  }

  private parseSets(value: any): any {
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }

  /**
   * 转换文本（原版 _主程序.ecode L9824-L9847）：
   * 「转换文本 QQ 编号」查看他人背包第 N 件的展示与数据串。
   */
  async handleTransformText(userId: number, text: string): Promise<string> {
    const payload = String(text || '').trim();
    if (!payload) {
      return '“转换文本@人 编号”';
    }
    const parts = payload.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return '“转换文本@人 编号”';
    }
    const targetKey = String(parts[0]).trim();
    const index = Math.floor(Number(parts[1]));
    if (!targetKey || !Number.isFinite(index) || index < 1) {
      return '“转换文本@人 编号”';
    }
    const target = await this.prisma.player.findFirst({
      where: {
        OR: [
          { userId: Number(targetKey) || -1 },
          { name: targetKey },
        ],
      },
    });
    if (!target) {
      return `${targetKey}在玩家列表不存在`;
    }
    const backpack = asJsonValue<any[]>((target as any).backpack, []);
    if (backpack.length < index) {
      return `${target.name || targetKey}的背包只有${backpack.length}个成员`;
    }
    const item = backpack[index - 1];
    const itemName = String(item?.name ?? '');
    const data = String(item?.data ?? '').split('#换行').join('【换行2】');
    return [
      `${itemName}${item?.type === '装备' ? '(装备)' : ''}`,
      data,
    ].filter(Boolean).join('\n');
  }

   /**
    * 纳米生化装模式切换 → FamiliarSkillsService.executeSkill('纳米生化装', 动作)
    * 保存图片（管理员/作者）（原版 _主程序.ecode L10666-10680）。
    */
  async handleNanoSuit(userId: number, action: string): Promise<string> {
    return this.familiarSkillsService.executeSkill(userId, '纳米生化装', action);
  }

  /**
   * 铠甲合体（对应原版：铠甲合体/炎龙/黑犀/飞影/地虎/雪獒 命令）
   * @param armorName 铠甲名称（可选，如炎龙/黑犀/飞影/地虎/雪獒）
   */
  async handleArmorCombine(userId: number, armorName?: string): Promise<string> {
    if (!armorName) return this.familiarSkillsService.executeSkill(userId, '铠甲合体');
    return this.activateArmor(userId, armorName);
  }

  /**
   * 「X铠甲合体！」（原版 _主程序.ecode L10690-10712）：
   * 必须**正穿着**「X铠甲召唤器」（腰部装备），已激活过不再重复，成功即把
   * `标记.铠甲` 置成 1..5（炎龙/黑犀/飞影/地虎/雪獒，@Constant.ecode L3-7）。
   *
   * 这个标记是五件铠甲唯一的效果开关：加成侧（bonus.service 的 铠甲 分支）与
   * 战斗侧（雪獒充能）都只读它。原先本指令只回一句文案、什么都不写 →
   * 「装备之后发送…来激活，攻击+10%、穿透+6%」这类描述五条全都永不成立。
   * 「更换装备后失效」的清零在换装与切换装备预设两处（item.service / equip-command.service）。
   */
  private async activateArmor(userId: number, armorName: string): Promise<string> {
    const armorSeqByName: Record<string, number> = { 炎龙: 1, 黑犀: 2, 飞影: 3, 地虎: 4, 雪獒: 5 };
    const armorSeq = armorSeqByName[String(armorName).trim()];
    if (!armorSeq) return `${armorName}没有对应的铠甲`;
    const summonerName = `${armorName}铠甲召唤器`;
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const worn: any[] = Array.isArray(playerData.equipment)
      ? playerData.equipment
      : asJsonValue<any[]>(player.equipment, []);
    // 原版 装备要求(玩家, , "X铠甲召唤器")：只按名字在穿戴栏里找，不限部位
    if (!worn.some((e: any) => String(e?.name ?? '').includes(summonerName))) {
      return `${player.name || '冒险者'}需要装备“${summonerName}”`;
    }
    if (Number(this.playerService.getMarkerValue(markers, '铠甲') ?? 0) !== 0) {
      return `${player.name || '冒险者'}已经激活过了`;
    }
    this.playerService.setMarker(markers, '铠甲', armorSeq);
    player.markers = markers; // markers 为原生 Json 列，直接写对象
    await this.playerService.savePlayer(player);
    return `⚡ ${summonerName}（${player.name || '冒险者'}）${armorName}铠甲激活`;
  }

  /** 缓天使（安乐天使）：目标可为自己、当前地图召唤物或其他玩家（原版 _主程序.ecode L995-1041） */
  async handleEaseAngel(userId: number, targetName?: string): Promise<string> {
    return this.familiarSystemService.safetyAngel(userId, targetName?.trim() || undefined);
  }

  /** 福音书：一天一次，目标解析与安乐天使相同（原版 _主程序.ecode L1044-1090） */
  async handleGospel(userId: number, targetName?: string): Promise<string> {
    return this.familiarSystemService.gospelBook(userId, targetName?.trim() || undefined);
  }

  /** 启示录：装备技能，提升攻击力 → executeSkill('启示录') */
  async handleApocalypse(userId: number): Promise<string> {
    return this.familiarSkillsService.executeSkill(userId, '启示录');
  }

  // 牵引光束的实现见 MovementVehicleService.handleTractorBeam（原版 _主程序.ecode L7722-L7808）。

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

    // 按部件类型计数，用于插槽展示
    const typeCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const part of parts) {
      typeCounts[part.partType] = (typeCounts[part.partType] || 0) + 1;
    }

    return [
      `🖥️ 载具控制终端`,
      CARD_DIVIDER,
      `🚗 ${vehicle.name}`,
      `❤️ 耐久: ${vehicle.currentHp}/${vehicle.maxHp}`,
      CARD_DIVIDER,
      `📊 当前状态:`,
      `  模式: ${currentMode}`,
      `  形态: ${currentForm}`,
      `  部件: ${parts.length}个安装`,
      CARD_DIVIDER,
      `📋 可用操作:`,
      `  驾驶 - 切换载具`,
      `  脱出 - 离开载具`,
      `  载具 - 查看状态`,
      `  安装 - 安装部件`,
      `  拆卸 - 拆卸部件`,
      `  架炮 - 恶毒专属：架起/收起炮击阵地`,
      `  模式转换 - 阿尔缇娜专属：战术壳光剑攻/防切换`,
      `  转换 - 伊芙利特专属：斧形态/炮形态切换`,
      `  牵引货舱 / 牵引能量 - 用牵引光束远程拉取补给`,
      `  维修 - 修复耐久度`,
      CARD_DIVIDER,
      `插槽使用:`,
      `  核心: ${typeCounts[0] || 0}/1`,
      `  武器: ${typeCounts[3] || 0}/${vehicle.maxWeapon || 5}`,
      `  防御: ${typeCounts[1] || 0}/${vehicle.maxDefense || 5}`,
      `  行走: ${typeCounts[2] || 0}/${vehicle.maxMove || 5}`,
      `  功能: ${typeCounts[4] || 0}/${vehicle.maxFunction || 5}`,
    ].join('\n');
  }

  /**
   * 标记值 → 技能名（原版 控制终端技能a/b 展示口径）。
   * 唯一真相源是 bond-skill.util 的 bondSkillName；本方法仅保留为实例出口
   * （既有调用方与冒烟测试经此访问），不得在此重建技能表。
   */
  bondSkillLabel(slot: 'a' | 'b', value: number): string {
    return bondSkillName(slot, value);
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
    // ⚠️ 与原版偏差：原版用 b==0 兼作「打开候选列表」，导致 0 号「未指定」是死选项
    // （点了只会重刷列表，技能无法取消）。此处改为「无数字=打开候选列表；0=真正置为未指定」，
    // 并让 0 同样受每天一次的冷却约束（原版 0 不落库，故不受冷却限制）。
    const digits = arg.match(/\d+/);
    const slot: 'a' | 'b' | '' = sub.includes('技能a') ? 'a' : sub.includes('技能b') ? 'b' : '';

    if (!slot) {
      // 总览（原版 L10840-10869）
      const lines = [
        `【白】`,
        `羁绊者:${player.name || ''}`,
        `技能1:${this.bondSkillLabel('a', Number(markers[bondMarkerKey('a')] || 0))}`,
        `技能2:${this.bondSkillLabel('b', Number(markers[bondMarkerKey('b')] || 0))}`,
      ];
      const menu = await this.support.buildNumberedMenu(userId, [
        { label: '选择技能1', cmd: '控制终端技能a' },
        { label: '选择技能2', cmd: '控制终端技能b' },
      ], '💡 发送编号数字(如 1)快速操作');
      lines.push(...menu);
      return lines.join('\n');
    }

    const skillList = bondSkillList(slot);
    const skillLabel = () => this.bondSkillLabel(slot, Number(markers[bondMarkerKey(slot)] || 0));

    if (!digits) {
      // 候选列表（原版 L10739-10762 / L10804-10807）：当前设置 + 0未指定 + 各技能说明。
      // 编号（0=未指定、1..N=技能 id）必须由同一份 entries 同时驱动「渲染」与「临时输入注册」，
      // 两半各渲染一份会导致编号错位（相差 1），玩家照上半发号就失效。
      const lines = [`${player.name || '冒险者'}`, `当前:${skillLabel()}`];
      const menu = await this.support.buildDetailedNumberedMenu(
        userId,
        [
          { index: 0, label: '未指定', cmd: `控制终端技能${slot}0` },
          ...skillList.map((skill) => ({
            index: skill.id,
            label: skill.name,
            desc: skill.desc,
            cmd: `控制终端技能${slot}${skill.id}`,
          })),
        ],
        '💡 发送编号数字即可设置对应技能',
      );
      lines.push(...menu);
      return lines.join('\n');
    }

    const choice = Number(digits[0]);
    if (choice < 0 || choice > skillList.length) {
      return `${player.name || '冒险者'}不是被允许选择的项目`;
    }

    // 每天只能修改一次（原版 时间间隔要求("gbj1/gbj2", 有效期当天(), 标记2)）
    const markers2 = asJsonValue<any[]>(player.markers2, []);
    const cooldownName = BOND_COOLDOWN_KEY[slot];
    const now = Date.now();
    const endOfDay = new Date();
    endOfDay.setHours(24, 0, 0, 0);
    const active = markers2.find((m: any) => m?.name === cooldownName);
    const activeExpire = Number(active?.expireAt ?? 0) || 0;
    if (activeExpire > now) {
      const remainSec = Math.max(1, Math.ceil((activeExpire - now) / 1000));
      return `${player.name || '冒险者'}今天已经设置过了，还需${this.support.millisecondsToText(remainSec * 1000)}后才能再次修改`;
    }
    const marker = { name: cooldownName, expireAt: endOfDay.getTime() };
    const idx = markers2.findIndex((m: any) => m?.name === cooldownName);
    if (idx >= 0) markers2[idx] = marker;
    else markers2.push(marker);

    markers[bondMarkerKey(slot)] = choice;
    player.markers = markers; // Json 列直接写对象
    player.markers2 = markers2; // Json 列直接写数组
    // 指令路径运行在 PlayerMutateService 快照内，由外层统一落库，此处不裸 savePlayer。
    return `${player.name || '冒险者'}\n白的技能${slot === 'a' ? 1 : 2}被设置为${skillLabel()}`;
  }

  /** 技能导航菜单：通用技能/使魔技能/查看成就/查看标记/查看标记2（编号直达） */
  async handleViewSkills(userId: number): Promise<string> {
    return this.buildSkillNavigation(userId);
  }

   /**
    * 生产模式切换回执：0=正常生产，非0=超载生产
    * 处理查看标记命令（对应原版 _主程序.ecode L5561）
    */
  async handleProductionMode(userId: number, mode: number): Promise<string> {
    return mode === 0 ? '🏭 已切换为正常生产模式。' : '🏭 已切换为超载生产模式。';
  }

  /** 增幅器系统说明（类型与用法文案，纯展示） */
  async handleAmplifierHelp(userId: number): Promise<string> {
    return [
      `📈 增幅器系统说明`,
      CARD_DIVIDER,
      `增幅器是一种可以提升玩家属性的特殊装备，佩戴在增幅器插槽中。`,
      CARD_DIVIDER,
      `【增幅器类型】`,
      `  1. 攻击增幅器 - 提升攻击力`,
      `  2. 防御增幅器 - 提升防御力`,
      `  3. 生命增幅器 - 提升最大生命值`,
      `  4. 速度增幅器 - 提升移动速度`,
      `  5. 暴击增幅器 - 提升暴击率和暴击伤害`,
      CARD_DIVIDER,
      `【使用方法】`,
      `  装备增幅器：装备 增幅器名`,
      `  查看已装备：信息`,
      CARD_DIVIDER,
      `增幅器可以通过战斗掉落、商店购买或合成获得。`,
    ].join('\n');
  }
}
