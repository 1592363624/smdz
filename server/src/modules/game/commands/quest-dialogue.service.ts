/**
 * 任务/对话/帮助指令域服务（game 模块化重构 P3-1 抽出）
 *
 * 职责：查看单位/NPC 对话（露娜/永兴/小恶魔）、任务接取/完成/放弃、图鉴、
 * 游戏介绍/术语/帮助/更新记录、私聊/反馈/发文字/计算器、菜单/功能菜单/
 * 游戏菜单、刷新数据/重载数据、设置系列（指引/采集/活力/倍率等）、
 * 新手使魔门/自动使魔技能触发、确认帮助、生产入口。
 * 依赖方向：依赖 Player、Map、Shortcut（临时输入）、Prisma、Task、StaticData、
 * SystemConfig、FamiliarSystem、Handbook、Tutorial、Achievement、CombatSystem、
 * Chat、Feedback、FamiliarSkills 与支撑层；过渡期经门面引用触达 rescue 域
 * ensurePlayerWhite 与 movement 域 performArrival（对应组拆出后改为直接注入）。
 * 单一真相源：编号菜单统一支撑层 buildNumberedMenu；快捷输入统一 ShortcutService。
 * 对口原版：_主程序.ecode 任务/对话/设置分支。
 */import { Injectable, Logger, Optional } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { lookupFromStaticData, mergeBackpackItem } from '.././item-normalize.util';
import { buildFamiliarGateMenu } from '.././familiar-menu.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { CombatSystemService } from '.././combat-system.service';
import { MapService } from '.././map.service';
import { AchievementService } from '.././achievement.service';
import { FamiliarSystemService } from '.././familiar-system.service';
import { FamiliarSkillsService } from '.././familiar-skills.service';
import { TutorialService } from '.././tutorial.service';
import { StaticDataService } from '.././static-data.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { ChatService } from '../../chat/chat.service';
import { FeedbackService } from '../../feedback/feedback.service';
import { TaskService } from '.././task.service';
import { ShortcutService } from '.././shortcut.service';
import { HandbookService } from '.././handbook.service';
import { GameSupportService } from '.././game-support.service';
import { GameService } from '.././game.service';

/** 任务来源（NPC → 任务名列表），getQuestSources 的返回条目类型 */
export interface QuestSource {
  npcName: string;
  taskNames: string[];
  publisher?: string;
}

@Injectable()
export class QuestDialogueService {
  private readonly logger = new Logger(QuestDialogueService.name);

  /**
   * 过渡期门面引用：仅用于触达尚未迁出的跨域方法（对应组拆出后改为直接注入）。
   * 由 GameService.onModuleInit 注入（构造后赋值，不构成 DI 环）。
   */
  private facade?: GameService;

  /** GameService.onModuleInit 注入门面引用。 */
  attachFacade(facade: GameService): void {
    this.facade = facade;
  }

  constructor(
    private readonly support: GameSupportService,
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly combatSystem: CombatSystemService,
    private readonly mapService: MapService,
    private readonly achievementService: AchievementService,
    private readonly familiarSystemService: FamiliarSystemService,
    private readonly familiarSkillsService: FamiliarSkillsService,
    private readonly tutorialService: TutorialService,
    private readonly staticData: StaticDataService,
    private readonly systemConfigService: SystemConfigService,
    private readonly chatService: ChatService,
    private readonly feedbackService: FeedbackService,
    private readonly taskService: TaskService,
    private readonly shortcutService: ShortcutService,
    @Optional() private readonly handbookService?: HandbookService,
  ) {}

  async handleViewUnit(userId: number, unitName: string): Promise<string> {
    const name = String(unitName || '').trim();
    if (!name) return '';
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '';

    const parse = (value: any): any[] => asJsonValue<any[]>(value, []);
    const markerOf = (unit: any, markerName: string): number => {
      const raw = unit?.markers ?? unit?.标记 ?? {};
      const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
      if (Array.isArray(parsed)) {
        const item = parsed.find((x: any) => (x?.name ?? x?.名称) === markerName);
        return Number(item?.value ?? item?.数值 ?? item?.count ?? 0);
      }
      return Number(parsed?.[markerName] ?? 0);
    };

    // NPC/召唤物
    const unit = parse(map.npcs).find((n: any) => (n?.name ?? n?.名称) === name)
      || parse(map.summons).find((s: any) =>
        [s?.name, s?.名称, s?.image, s?.图片].some((v: any) => String(v ?? '') === name));
    if (unit) {
      const lines = [`【${String(unit?.name ?? unit?.名称 ?? name)}】`];
      lines.push(`类型:${String(unit?.type ?? unit?.类型 ?? '未知')}`);
      const hp = Number(unit?.hp ?? unit?.当前生命 ?? 0);
      const maxHp = Number(unit?.maxHp ?? unit?.最大生命 ?? 0);
      if (maxHp > 0) lines.push(`生命:${hp}/${maxHp}`);
      const affinity = markerOf(unit, `好感${userId}`);
      if (affinity) lines.push(`对你的好感:${this.support.round2Text(affinity)}`);
      const owner = String(unit?.ownerQQ ?? unit?.归属 ?? '');
      if (owner) {
        const ownerUser = await this.prisma.user.findUnique({ where: { id: Number(owner) } }).catch(() => null);
        lines.push(`归属:${ownerUser?.nickname || ownerUser?.username || owner}`);
      }
      return lines.join('\n');
    }

    // 怪物（含临时怪）
    try {
      const monsters = await this.mapService.getMapMonsters(map.id);
      const monster = (monsters || []).find((m: any) =>
        [m?.name, m?.名称].some((v: any) => String(v ?? '') === name));
      if (monster) {
        const lines = [`【${String(monster?.name ?? name)}】`];
        lines.push(`类型:${String((monster as any)?.type ?? (monster as any)?.类型 ?? '怪物')}`);
        if (monster.level) lines.push(`等级:${monster.level}`);
        if (monster.maxHp) lines.push(`生命:${monster.hp}/${monster.maxHp}`);
        if (monster.attack) lines.push(`攻击:${monster.attack}`);
        if (monster.defense) lines.push(`防御:${monster.defense}`);
        return lines.join('\n');
      }
    } catch { /* 怪物查询失败回退 */ }
    return '';
  }

  /**
   * 处理玩家攻击命令
   * 对应原版：攻击 命令
   * 委托给完整的战斗子系统 combatSystem.weaponAttack 执行完整攻击流程
   * 包括：武器攻击 → 伤害计算（含暴击/命中） → 使魔特效 → 怪物死亡处理 → 经验获得 → 掉落生成
   */

  async handleTalk(userId: number, npcName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 特殊NPC剧情映射（新手流程固定NPC，不依赖地图数据）
    // 原版中这些NPC由"生成人物"指令动态生成，地图 npcs 字段可能为空，
    // 因此将固定剧情前置处理，保证新手引导中的「对话 新手引导员」始终可用。
    const specialNpcs: Record<string, { title: string; dialogs: Record<string, string> }> = {
      '新手引导员': {
        title: '新手引导员·小薇',
        dialogs: {
          'hello': '你好呀，新人！我是新手引导员小薇，欢迎来到使魔大战的世界！\n\n你从出生点醒来，先打开背包看看身上的物资吧，\n再和我聊聊，了解一下这个世界。',
          'intro': '这个世界的怪物可不是好惹的，先从背包里拿出你的石制工具吧！\n\n💡 使用「装备 石制工具」来装备武器\n💡 使用「攻击」来试试身手\n💡 使用「背包」查看你拥有的物品',
          'quest': '等你准备好了，我有个任务要交给你。\n任务我已经帮你接好了，先看看任务列表吧。\n\n使用「查看任务」查看任务详情，完成要求后奖励会自动发放。',
          'done': '你已经学会了基本操作，去探索更广阔的世界吧！\n\n记住：\n  - 使用「移动 地图名」前往新区域\n  - 使用「对话 NPC名」与NPC交谈\n  - 遇到困难可以「求助」其他玩家',
        }
      },
      '老村长': {
        title: '老村长',
        dialogs: {
          'hello': '咳咳，年轻人，你就是新来的冒险者吧？\n\n我是这个新手村的村长，已经在这里生活了几十年了。\n最近村子周围的怪物越来越多了，我需要你的帮助。',
          'intro': '你看到村子东边的走廊了吗？那里原本是通往神殿的通道，\n但是最近被一群史莱姆占据了。\n去那里看看吧，说不定能找到一些有用的东西。',
          'quest': '年轻人，如果你愿意的话，帮我清理掉走廊里的史莱姆。\n作为回报，我会告诉你关于使魔的秘密。',
          'done': '你做得很好，年轻人！\n现在我告诉你，使魔是这个世界最神奇的伙伴。\n使用「召唤使魔」来召唤你的第一个使魔吧！',
          'story': '很久很久以前，使魔大战爆发了……\n算了，这些故事以后再说。\n你现在的任务是提升实力，去探索这个世界的秘密。',
        }
      },
      '流浪商人': {
        title: '流浪商人·阿福',
        dialogs: {
          'hello': '嘿嘿，新面孔啊！我是流浪商人阿福，\n我在各个大陆之间旅行，贩卖各种稀奇古怪的东西。\n\n要不要看看我的商品？使用「购物」来打开商店。',
          'intro': '我这里的商品可都是好东西！\n有武器、防具、药品，还有一些特殊的道具。\n\n不过嘛……好东西可不便宜，你先去赚点钱再来吧。',
          'quest': '如果你能帮我收集一些稀有的材料，我可以给你一个优惠价。\n先去探索一下周围的地图，看看能找到什么好东西吧。',
          'done': '你收集到了不错的材料？厉害厉害！\n作为奖励，我可以给你打个八折，嘿嘿。',
        }
      },
      '旅行者': {
        title: '神秘的旅行者',
        dialogs: {
          'hello': '嘘……别出声。\n我正在观察走廊里的那些史莱姆，它们的行为很奇怪。\n\n你也是来探索这条走廊的吗？',
          'intro': '这条走廊被称为「试炼之路」，每个新人都要经过这里。\n走廊里有各种资源和机关，当然也有怪物。\n\n先提升自己的实力，再向走廊深处前进吧。',
          'quest': '如果你能前往走廊深处探索，帮我看看那里的情况。\n但我警告你，走廊深处有一种特殊的史莱姆，\n它们比普通史莱姆要强大得多。',
          'done': '你探索了走廊深处？太好了！\n那条走廊蕴含着许多秘密，好好探索吧。',
        }
      },
      '行商': {
        title: '流浪行商·阿福',
        dialogs: {
          'hello': '嘿，新人！我这里有些好东西，要不要看看？',
          'intro': '我这里有各种武器和防具，不过价格嘛……嘿嘿。',
          'quest': '如果你有材料，可以找我制作装备，我的锻造技术可是一流的！',
          'done': '欢迎下次光临！',
        }
      },
      '白': {
        title: '白',
        dialogs: {
          'hello': '这里是哪里？我好像睡了很久……\n你是我醒来后见到的第一个人，谢谢你唤醒了我。',
          'intro': '我感觉到这条走廊上有奇怪的气息，我们要小心前行。\n我的力量还没有完全恢复，需要你的帮助。',
          'quest': '你愿意和我一起探索这条走廊吗？我感觉到深处有什么东西在呼唤着我。',
          'done': '谢谢你一直陪着我，和你在一起让我感觉很安心。',
        }
      },
    };
    // 指定了NPC且命中特殊NPC → 视为可对话（无需地图数据中存在该NPC）。
    // 白只有在休眠仓剧情已经触发，或当前地图确实存在白时才可对话，
    // 避免未唤醒时直接推进“对话白”任务。
    const isKnownSpecialNpc = !!npcName && !!specialNpcs[npcName];

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);

    // 解析地图NPC列表
    const npcs = asJsonValue<any[]>(map ? map.npcs : [], []);
    const parsedSummons = asJsonValue<any>(map ? map.summons : [], []);
    const mapSummons = Array.isArray(parsedSummons) ? parsedSummons : [];
    const whiteAvailable = Number(markers['召唤白'] || 0) > 0
      || npcs.some((unit: any) => (unit?.name ?? unit?.名称) === '白')
      || mapSummons.some((unit: any) => (unit?.name ?? unit?.名称) === '白');
    const isSpecialNpc = isKnownSpecialNpc && (npcName !== '白' || whiteAvailable);
    if (!map && !isSpecialNpc) return '你不在任何地图上！';

    // 地图怪物（原版 对话 分支 L1469-1478：召唤物没匹配上时继续按名称匹配怪物，
    // 「主线-继续询问」的“对话史莱姆”正是走这条路径）。
    // 注意：不能拿「NPC 数 + 召唤物数 == 0」做对话门禁，否则只有怪物的地图
    // （如森林出口）会连怪物一起挡掉，玩家永远无法完成“对话史莱姆”类任务。
    let mapMonsters: any[] = [];
    if (map) {
      try {
        mapMonsters = (await this.mapService.getMapMonsters(map.id)) || [];
      } catch { mapMonsters = []; }
    }

    // 如果没有指定NPC名称，显示可对话对象列表（附带编号快捷选项，发数字即可对话）
    if (!npcName) {
      const lines = [`💬 【${map.name}】可对话对象:`];
      // 编号快捷对话选项：label=展示文本，cmd=实际触发的「对话 名称」
      const options: { label: string; cmd: string }[] = [];
      const usedCmds = new Set<string>();
      const pushOption = (name: string, note?: string) => {
        const cmd = `对话 ${name}`;
        if (usedCmds.has(cmd)) return;
        usedCmds.add(cmd);
        lines.push(`  ${name}${note ? ` - ${note}` : ''}`);
        options.push({ label: cmd, cmd });
      };
      for (const npc of npcs) {
        const name = npc.name || '未知';
        pushOption(name, npc.description);
      }
      // 召唤物（白/行商/宠物等运行时单位）也是原版对话对象
      for (const summon of mapSummons) {
        const name = String(summon?.name ?? summon?.名称 ?? '');
        if (!name) continue;
        if (name === '白' && !whiteAvailable) continue;
        pushOption(name, '召唤物');
      }
      // 怪物（同名只列一次，原版同名单位匹配第一只）
      for (const monster of mapMonsters) {
        if ((monster?.hp ?? 0) <= 0) continue;
        const name = String(monster?.name ?? monster?.名称 ?? '');
        if (!name) continue;
        const level = Number(monster?.level ?? monster?.等级 ?? 0);
        pushOption(name, level > 0 ? `怪物 Lv.${level}` : '怪物');
      }
      // 地图无NPC/召唤物/怪物数据时，列出新手固定NPC供玩家选择
      // 注意：快捷对话必须用特殊NPC的 key（如 新手引导员），不能用标题（如 新手引导员·小薇），
      // 因为 handleTalk 通过 specialNpcs[key] 解析特殊NPC。
      if (options.length === 0) {
        const specialList: { key: string; desc: string }[] = [
          { key: '新手引导员', desc: '新手村的引导员' },
          { key: '老村长', desc: '新手村的村长' },
          { key: '流浪商人', desc: '贩卖各种物品的商人' },
          { key: '旅行者', desc: '神秘的旅行者' },
          { key: '白', desc: '从休眠仓中唤醒的少女' },
        ];
        for (const sp of specialList) {
          if (sp.key === '白' && !whiteAvailable) continue;
          lines.push(`  ${specialNpcs[sp.key].title} - ${sp.desc}`);
          options.push({ label: `对话 ${specialNpcs[sp.key].title}`, cmd: `对话 ${sp.key}` });
        }
      }
      if (options.length === 0) return '当前地图没有可对话的NPC';
      lines.push(``);
      const menuLines = await this.support.buildNumberedMenu(userId, options, '💡 发送编号数字(如 1)即可与对应NPC对话');
      if (menuLines.length === 0) {
        lines.push(`使用「对话 NPC名」与NPC对话`);
      } else {
        lines.push(...menuLines);
      }
      return lines.join('\n');
    }

    // ===== 对话目标解析（对齐原版 对话 分支 _主程序.ecode L1478-1570）=====
    // 优先级：地图NPC → 地图召唤物（白/行商/宠物等运行时单位）→ 地图怪物 → 特殊NPC占位。
    let targetNpc: any = npcs.find((n: any) => (n?.name ?? n?.名称) === npcName) || null;
    let unitKind: 'npc' | 'summon' | 'monster' | 'special' = targetNpc ? 'npc' : 'special';
    if (!targetNpc) {
      const summonIdx = mapSummons.findIndex((s: any) =>
        [s?.name, s?.名称, s?.image, s?.图片].some((v: any) => String(v ?? '') === npcName));
      if (summonIdx >= 0) {
        targetNpc = mapSummons[summonIdx];
        unitKind = 'summon';
      }
    }
    // 白：优先找地图实体；历史存档（只有 召唤白 标记）按需补建实体。
    if (!targetNpc && npcName === '白' && map) {
      const white = await this.facade!.ensurePlayerWhite(player, map).catch(() => null);
      if (white) {
        targetNpc = white;
        unitKind = 'summon';
      }
    }
    if (!targetNpc && mapMonsters.length > 0) {
      // 原版 L1469-1478：召唤物没匹配上时按名称找怪物。优先存活个体。
      const matchByName = (list: any[]) =>
        list.find((m: any) => [m?.name, m?.名称].some((v: any) => String(v ?? '') === npcName));
      const monster = matchByName(mapMonsters.filter((m: any) => (m?.hp ?? 0) > 0))
        || matchByName(mapMonsters);
      if (monster) {
        targetNpc = monster;
        unitKind = 'monster';
      }
    }
    if (!targetNpc && isSpecialNpc) {
      targetNpc = { name: npcName, title: specialNpcs[npcName].title, type: 'npc', description: '' };
      unitKind = 'special';
    }
    if (!targetNpc) {
      return `当前地图没有名为【${npcName}】的NPC`;
    }

    // 原版 _主程序.ecode L1566-1567：找到对话对象后才推进「对话」和「对话+名称」。
    // “主线-继续询问”的“对话史莱姆3”等要求由此结算。放在服务层统一处理，指令入口
    // 与编号菜单入口都能生效，也避免按返回文本猜测对话是否成功。
    await this.taskService.advance(userId, '对话').catch(() => '');
    await this.taskService.advance(userId, `对话${npcName}`).catch(() => '');

    // 地图实体（召唤物/怪物/NPC）走原版对话结构（菜单+编号临时输入）；
    // 特殊NPC（新手引导员等新框架剧情NPC）保留对话阶段推进。
    if (unitKind !== 'special') {
      return this.buildUnitDialogue(player, userId, npcName, targetNpc, unitKind);
    }

    // 根据NPC类型生成对话文本
    const npcType = targetNpc.type || 'generic';
    const npcTitle = targetNpc.title || '未知NPC';
    const dialogLines: string[] = [];

    // 基础问候
    const greetings = [
      `你好，${player.name || '冒险者'}！`,
      `欢迎来到${map ? map.name : '新手村'}！`,
      `有什么事吗？`,
    ];
    dialogLines.push(`【${npcTitle}】`);
    dialogLines.push(`━━━━━━━━━━━━━━━`);
    dialogLines.push(greetings[Math.floor(Math.random() * greetings.length)]);

    // 特殊NPC对话剧情（对话阶段推进）
    {
      // 根据教程进度和与当前NPC的对话历史确定对话阶段
      const tutorialValue = markers['教程'] || 0;
      // 检查与该NPC的独立对话进度（支持每个NPC独立的对话推进）
      const talkProgress = markers[`对话_${npcName}`] || 0;
      let dialogPhase: string;
      if (talkProgress >= 3) {
        dialogPhase = 'done';
      } else if (talkProgress >= 2) {
        dialogPhase = 'quest';
      } else if (talkProgress >= 1) {
        dialogPhase = 'intro';
      } else {
        dialogPhase = 'hello';
      }
      // 如果用独立对话进度得出的阶段与教程阶段冲突，取较高级的那个
      // 例如：教程已到done阶段，但从未和该NPC对话过，仍展示高级内容
      if (tutorialValue >= 3 && dialogPhase !== 'done') {
        dialogPhase = 'done';
      }

      // 检查新手指引中的对话引导
      const tutorialText = this.tutorialService.getTutorial('talk', markers);
      if (tutorialText) {
        markers['指引_talk'] = 1;
        player.markers = markers; // Json 列直接写对象
        await this.playerService.savePlayer(player);
      }

      // 检查当前NPC是否在特殊NPC列表中
      const specialNpc = specialNpcs[npcName];
      if (specialNpc) {
        // 使用特殊NPC的标题替换默认标题
        const dialogText = specialNpc.dialogs[dialogPhase] || specialNpc.dialogs['hello'];
        dialogLines.push(dialogText);

        // 更新与该NPC的对话进度
        markers[`对话_${npcName}`] = (talkProgress + 1);
        player.markers = markers; // Json 列直接写对象
        await this.playerService.savePlayer(player);

        // 对话进度提示
        if (talkProgress < 3) {
          dialogLines.push(`━━━━━━━━━━━━━━━`);
          dialogLines.push(`💡 继续对话可了解更多信息`);
        }
        // 跳过后续通用NPC对话逻辑
      } else {
        // 非特殊NPC，使用通用对话逻辑
        dialogLines.push(this.genericNpcChatLine(npcType));
      }
    }

    // NPC描述文本
    if (targetNpc.description) {
      dialogLines.push(`━━━━━━━━━━━━━━━`);
      dialogLines.push(`${targetNpc.description}`);
    }

    // 对齐原版（_主程序.ecode L1492-1493）：NPC 对话末尾生成编号快捷菜单，
    // 用临时输入替换让玩家发数字即可继续。原版对所有对话对象统一提供「1、查看 2、攻击」入口。
    // 此处按需求提供「1、对话 2、任务」：1=继续对话推进对话阶段，2=查看任务。
    const menuLines = await this.support.buildNumberedMenu(userId, [
      { label: `对话 ${npcName}`, cmd: `对话 ${npcName}` }, // 1=继续对话，推进对话阶段
      { label: '任务', cmd: '查看任务' },                      // 2=查看任务
    ], '💡 发送编号数字(如 1)快速操作');
    dialogLines.push(`━━━━━━━━━━━━━━━`);
    dialogLines.push(...menuLines);

    return dialogLines.join('\n');
  }

  /** 特殊占位 NPC 的通用对话台词（新框架剧情 NPC，非原版对话配置）。 */

  genericNpcChatLine(npcType: string): string {
    switch (npcType) {
      case 'merchant':
      case 'shop':
        return `我这里有些好东西，你可以用「购物」来查看。`;
      case 'quest':
      case 'task':
        return `我有个任务需要你的帮助，使用「领取任务」来看看吧。`;
      case 'blacksmith':
      case 'smith':
        return `我可以帮你修理装备，使用「修理」来修复你的物品。`;
      case 'healer':
        return `我可以为你治疗伤口，躺下休息能恢复生命。`;
      case 'guide':
        return `欢迎来到使魔大战的世界！使用「帮助」查看游戏指南。`;
      default:
        return `今天天气不错，适合出门冒险！`;
    }
  }

  /**
   * 地图单位对话（对齐原版 对话 分支 _主程序.ecode L1489-1570）：
   * 对话文本取对话配置（怪物=敌对聊天，其余=友好聊天），末尾生成原版编号菜单：
   * 怪物 = 查看/攻击(+跟我来)；NPC = 查看/领取任务 + 行商购物/花园宝宝捕捉/露娜求助/
   * 跟随开关(不要跟着我了/跟上我)/救助/挤奶/控制终端(白)。
   */

  async buildUnitDialogue(
    player: any,
    userId: number,
    npcName: string,
    unit: any,
    kind: 'npc' | 'summon' | 'monster',
  ): Promise<string> {
    const nameOf = String(unit?.name ?? unit?.名称 ?? '') || npcName;
    const typeOf = String(unit?.type ?? unit?.类型 ?? '') || nameOf;
    const qqOf = String(unit?.qq ?? unit?.QQ ?? '');
    const isMonsterUnit = kind === 'monster' || qqOf.startsWith('怪物');

    const markerOf = (markerName: string): number => {
      const raw = unit?.markers ?? unit?.标记 ?? {};
      const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
      if (Array.isArray(parsed)) {
        const item = parsed.find((x: any) => (x?.name ?? x?.名称) === markerName);
        return Number(item?.value ?? item?.数值 ?? item?.count ?? 0);
      }
      return Number(parsed?.[markerName] ?? 0);
    };
    const ownerOf = String(unit?.ownerQQ ?? unit?.归属 ?? unit?.owner ?? '');
    const ownerIds = new Set([String(userId), String(player?.id ?? '')].filter(Boolean));
    const isOwned = ownerIds.has(ownerOf);

    const dialogLines: string[] = [`【${nameOf}】`, `━━━━━━━━━━━━━━━`];
    // 对话文本（原版 取对话：怪物取敌对聊天，其余取友好聊天）
    const chatText = this.staticData.getDialogue(
      String(player?.name || ''),
      unit,
      nameOf,
      isMonsterUnit ? 0 : 1,
    );
    if (chatText && chatText !== '……') dialogLines.push(chatText);

    // 幼崽成长展示（原版 L1531-1538 计算幼崽）
    try {
      this.familiarSystemService?.checkAndUpdateGrowth?.(unit);
    } catch { /* 成长解析失败不影响对话 */ }
    if (markerOf('幼崽') !== 0) {
      const babyLabel = typeOf.includes('幼崽') ? typeOf : `${typeOf}宝宝`;
      dialogLines.push(`${babyLabel},${this.support.millisecondsToText(markerOf('幼崽'))}后长大`);
      const ownerUser = ownerOf
        ? await this.prisma.user.findUnique({ where: { id: Number(ownerOf) } }).catch(() => null)
        : null;
      if (ownerUser) dialogLines.push(`主人:${ownerUser.nickname || ownerUser.username || ownerOf}`);
    }

    // 咏星类跟随单位展示好感（原版 L1496-1498）
    if (typeOf === '咏星') {
      dialogLines.push(`对你的好感:${this.support.round2Text(markerOf(`好感${userId}`))}`);
    }

    // 菜单（原版 L1512-1560）
    const options: { label: string; cmd: string }[] = [];
    const literalAliases: string[] = [];
    if (isMonsterUnit) {
      options.push({ label: '查看', cmd: `查看 ${nameOf}` });
      options.push({ label: '攻击', cmd: `攻击 ${nameOf}` });
      if (typeOf.includes('小恶魔')) {
        options.push({ label: '跟我来', cmd: '对话小恶魔跟随' });
      } else if (typeOf.includes('咏星')) {
        options.push({ label: '跟我来', cmd: '对话咏星跟随' });
      }
    } else {
      options.push({ label: '查看', cmd: `查看 ${nameOf}` });
      options.push({ label: '领取任务', cmd: `领取任务 ${nameOf}` });
      if (nameOf === '行商') {
        options.push({ label: '购物', cmd: '购物' });
      } else if (nameOf === '花园宝宝' || nameOf === '小白狐') {
        options.push({ label: '捕捉', cmd: `捕捉 ${nameOf}` });
      } else if (qqOf === 'npc1g' || nameOf === '神之工匠') {
        options.push({ label: '融合', cmd: '融合' });
      } else if (qqOf === '怪物露娜1g' || nameOf === '露娜') {
        options.push({ label: '求助', cmd: '求助' });
        const backpack = this.playerService.getBackpackItems(player);
        if (backpack.some((item: any) => (item?.name ?? item?.名称 ?? '') === '未知物品')) {
          options.push({ label: '询问幽能', cmd: '对话露娜未知' });
        }
      } else {
        // 跟随开关（原版 L1540-1547：跟随标记==0 → 不要跟着我了，否则跟上我）
        if (markerOf('跟随') === 0) {
          options.push({ label: '不要跟着我了', cmd: `设置跟随 ${nameOf}` });
          literalAliases.push(`不要跟着我了@设置跟随 ${nameOf}`);
        } else {
          options.push({ label: '跟上我', cmd: `设置跟随 ${nameOf}` });
          literalAliases.push(`跟上我@设置跟随 ${nameOf}`);
        }
        if (isOwned) {
          options.push({ label: '救助', cmd: '救助' });
          literalAliases.push(`救助@救助`);
          options.push({ label: '挤奶', cmd: `挤奶 ${nameOf}` });
          literalAliases.push(`挤奶@挤奶 ${nameOf}`);
          if (typeOf === '白') {
            options.push({ label: '控制终端', cmd: '控制终端' });
          }
        }
      }
    }

    dialogLines.push(`━━━━━━━━━━━━━━━`);
    const menuLines = await this.support.buildNumberedMenu(
      userId,
      options,
      '💡 发送编号数字(如 1)快速操作',
      literalAliases,
    );
    dialogLines.push(...menuLines);
    return dialogLines.join('\n');
  }

  /** 毫秒 → 可读时间文本（对应原版 数字到时间 的秒/分秒简化）。 */

  async handleDialogueLuna(userId: number, arg: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, backpack } = playerData;

    // 获取当前地图，确认露娜在场
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const summons = asJsonValue<any[]>(map.summons, []);
    const luna = summons.find((s: any) => s.qq === '怪物露娜1g' || s.name === '露娜');
    if (!luna) {
      return '你环顾四周，露娜并不在这里。\n她偶尔会出现在某些地图上，找到她才能用未知物品兑换奖励。';
    }

    // 解析兑换选项：无参数时展示选项，参数为1/2时执行兑换
    const choice = parseInt(arg.replace(/[^\d]/g, ''), 10) || 0;

    // 统计背包中的"未知物品"数量
    const unknownItems = backpack.filter((item: any) => item.name === '未知物品' || item.name.includes('未知物品'));
    const unknownCount = unknownItems.reduce((sum: number, item: any) => sum + (item.count || 1), 0);

    if (choice === 0) {
      // 展示兑换菜单
      if (unknownCount <= 0) {
        return '【露娜】\n━━━━━━━━━━━━━━━\n这是……具现装置的产物？！\n这种东西对你来说也没用，不如交给我，我可以用你想要的东西作为奖励。\n\n不过你现在好像没有「未知物品」，去具现装置那里看看吧。';
      }
      return `【露娜】\n━━━━━━━━━━━━━━━\n这是……具现装置的产物？！\n这种东西对你来说也没用，不如交给我，我可以用你想要的东西作为奖励。\n\n你拥有「未知物品」×${unknownCount}，想兑换什么？\n1、工业建筑箱\n2、专属装备补给箱\n\n输入「对话露娜未知 1」或「对话露娜未知 2」进行兑换`;
    }

    if (unknownCount <= 0) {
      return '你的背包中没有「未知物品」，无法兑换。';
    }

    // 确定兑换目标
    const rewardName = choice === 1 ? '工业建筑箱' : '专属装备补给箱';
    if (choice !== 1 && choice !== 2) {
      return '请输入正确的选项：1=工业建筑箱，2=专属装备补给箱';
    }

    // 扣除未知物品，给予奖励物品
    let remaining = unknownCount;
    player.backpack = backpack
      .map((item: any) => {
        if (item.name === '未知物品' || item.name.includes('未知物品')) {
          const take = Math.min(item.count || 1, remaining);
          remaining -= take;
          return { ...item, count: (item.count || 1) - take };
        }
        return item;
      })
      .filter((item: any) => (item.count || 0) > 0);

    // 发放奖励物品（统一走 mergeBackpackItem：同名堆叠 + type 以静态定义为唯一真相源）
    const rewardItem = { name: rewardName, count: unknownCount };
    mergeBackpackItem(player.backpack, rewardItem, lookupFromStaticData(this.staticData));

    // 增加露娜熟练度
    markers['露娜熟练度'] = (markers['露娜熟练度'] || 0) + unknownCount * 10;
    player.markers = markers; // Json 列直接写对象
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 与露娜兑换：${unknownCount}个未知物品 → ${rewardName}`);
    return `【露娜】\n━━━━━━━━━━━━━━━\n非常感谢！\n（露娜熟练度+${unknownCount * 10}，用${unknownCount}个未知物品跟她换了${rewardName}）`;
  }

  /**
   * 处理来倒目的（延时移动）
   * 对应原版：来倒目的 命令
   * 由系统延时任务触发，格式为"地图名$来源地图"，将玩家移动到指定地图
   * 若目标为"四圣祭坛"且四个祭坛均无怪物，则刷出神兽麒麟
   */

  async handleArriveAt(userId: number, arg: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 解析参数："目标地图$来源地图"
    const parts = (arg || '').split('$');
    const targetName = parts[0]?.trim();
    if (!targetName) {
      return '移动输入的数据不正确';
    }

    // 查找目标地图
    const targetMap = await this.mapService.getMapByName(targetName);
    if (!targetMap) {
      return `目标地图「${targetName}」不存在`;
    }

    // 统一走普通移动/飞行共用的到达结算（含观测产出/四圣祭坛麒麟/普拉娜剪毛等到达触发），
    // 确保地图增益、探索和任务只处理一次。
    const arrivalResult = await this.facade!.performArrival(userId, targetMap.id, targetMap.name);
    return arrivalResult;
  }

  /**
   * 处理家园命令
   * 家园系统的入口，支持子命令
   */

  async handleDialogueYongxing(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 在 GameMonster 表（临时怪物）中查找"咏星"
    const tempMonsters = await this.mapService.getMapMonsters(map.id);
    const targetMonster = tempMonsters.find((m: any) => m.name === '咏星');
    if (!targetMonster) {
      return `${player.name} 附近没有咏星`;
    }

    // 好感检查（对应原版：好感+玩家QQ >= 100）
    const affinity = this.playerService.getMarkerValue(markers, `好感${player.userId}`) || 0;
    if (affinity < 100) {
      return `${player.name} 需要100好感，当前${affinity}`;
    }

    const monster = targetMonster;
    // 转为召唤物：归属玩家、specialSeq=-2、follow 跟随
    const summon = {
      name: monster.name,
      qq: monster.qq || `怪物${monster.name}1g`,
      type: monster.type || '咏星',
      specialSeq: -2,
      ownerQQ: player.userId.toString(),
      follow: true,
      mode: 'follow',
      hp: monster.hp ?? 0,
      maxHp: monster.maxHp ?? monster.hp ?? 100,
    };
    // 从 GameMonster 表移除该临时怪物（已转为召唤物）
    await this.mapService.removeMapMonster(map.id, monster.id);

    // mutateSummons 锁内闭环：重读最新 summons → 复查幂等 → push 新召唤物 → 差异落库
    await this.mapService.mutateSummons(map.id, (fresh) => {
      if (fresh.some((s: any) => s.qq === summon.qq)) return;
      fresh.push(summon);
    });

    // 记录成就「拐妹子」
    await this.achievementService.addAchievement(player, '拐妹子', 1);
    return `咏星愿意跟随你了！`;
  }

  /**
   * 处理对话小恶魔跟随命令（对应原版 _主程序.ecode L1397）
   * 找到当前地图"怪物小恶魔1"并直接转为归属于玩家的召唤物（跟随）。
   */

  async handleDialogueLittleDemon(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 在 GameMonster 表（临时怪物）中查找小恶魔（qq=怪物小恶魔1）
    const tempMonsters = await this.mapService.getMapMonsters(map.id);
    const targetMonster = tempMonsters.find((m: any) => m.qq === '怪物小恶魔1' || m.name === '小恶魔');
    if (!targetMonster) {
      return `${player.name} 附近没有小恶魔`;
    }

    const monster = targetMonster;
    const summon = {
      name: monster.name || '小恶魔',
      qq: '怪物001xg',
      type: monster.type || '小恶魔',
      specialSeq: -2,
      ownerQQ: player.userId.toString(),
      follow: true,
      mode: 'follow',
      hp: monster.hp ?? 0,
      maxHp: monster.maxHp ?? monster.hp ?? 100,
    };
    // 从 GameMonster 表移除该临时怪物（已转为召唤物）
    await this.mapService.removeMapMonster(map.id, monster.id);

    // mutateSummons 锁内闭环：重读最新 summons → 复查幂等 → push 新召唤物 → 差异落库
    await this.mapService.mutateSummons(map.id, (fresh) => {
      if (fresh.some((s: any) => s.qq === summon.qq)) return;
      fresh.push(summon);
    });

    return `那就让我看看你的本事吧！小恶魔开始跟随你。`;
  }

  /**
   * 处理设置肉食比例命令（对应原版 _主程序.ecode L5277）
   * 设置家园地图中"肉食植物能享用的生肉与生肉产出的比例"（存于家园地图标记）。
   */

  async handleSetMeatRatio(userId: number, ratioStr: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const ratio = parseInt(ratioStr, 10);
    if (!player.houseName) {
      return `${player.name} 你现在还没有家园，不能干这个`;
    }
    if (!ratio || ratio <= 0 || ratio > 100) {
      return `${player.name} 使用「设置肉食比例90」来设置肉食植物能享用的生肉与生肉产出的比例`;
    }

    // 根据家园名称找到对应地图（getMapByName 找不到会 throw NotFoundException，需 try/catch）
    let homeMap: any = null;
    try {
      homeMap = await this.mapService.getMapByName(player.houseName);
    } catch {
      homeMap = null;
    }
    if (!homeMap) {
      return `${player.name} 找不到你的家园地图「${player.houseName}」`;
    }

    // 将比例写入家园地图的标记（对应原版：置成就熟练度("肉食比例", 地图.标记, a1)）
    // mutateMapFields 锁内闭环：重读最新 markers → 写入 → 差异落库
    await this.mapService.mutateMapFields(homeMap.id, ['markers'], (f) => {
      (f.markers as Record<string, number>)['肉食比例'] = ratio;
    });

    return `${player.name} ${player.houseName}的肉食植物现在能享用${ratio}%的生肉产出`;
  }

  /**
   * 处理召唤货舱命令
   * 在当前地图召唤货舱（可采集资源），如果没有则生成一个临时货舱
   */
  /**
   * 发射信号枪（原版 _主程序.ecode L6281-6296）。
   * 门禁：数量<=0 用法提示 → 背包需有信号枪 → 10 秒冷却。
   * 成功：成就"召唤货舱"+1 → 活跃度+1 → 6 秒延时「召h货1藏」结算（completeCargoSummon）。
   * 注意：原版信号枪只用于召唤货舱（资源补给），引怪由覅攻击pd（采集/传送触发）承担。
   */

  async handleAcceptQuest(userId: number, questName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const npcs = asJsonValue<any[]>(map.npcs, []);
    const summons = asJsonValue<any[]>(map.summons, []);
    // 白：历史存档（只有 召唤白 标记）按需补建实体，保证任务池可解析。
    const wantedName = String(questName || '').trim();
    if (!wantedName || wantedName === '白') {
      const white = await this.facade!.ensurePlayerWhite(player, map).catch(() => null);
      if (white && !summons.some((s: any) => String(s?.qq ?? s?.QQ ?? '') === String(white.qq ?? ''))) {
        summons.push(white);
      }
    }
    const units = [...npcs, ...summons];
    const sources = this.getQuestSources(units);

    if (!questName) {
      const available: Array<{ task: any; publisher?: string; npcName: string }> = [];
      for (const source of sources) {
        const tasks = await this.taskService.getAvailableTasks(userId, source.taskNames, source.publisher);
        for (const task of tasks) {
          if (!available.some((item) => item.task.name === task.name)) {
            available.push({ task, publisher: source.publisher, npcName: source.npcName });
          }
        }
      }

      if (available.length === 0) {
        return '当前地图没有可领取的任务';
      }

      const lines = [`📋 【${map.name}】可领取任务:`];
      const options: { label: string; cmd: string }[] = [];
      for (const item of available) {
        lines.push(`  ${item.task.name}`);
        lines.push(`    发布人: ${item.npcName}`);
        lines.push(`    等级要求: ${item.task.level || 1}`);
        if (item.task.description) lines.push(`    ${item.task.description}`);
        options.push({ label: `领取任务 ${item.task.name}`, cmd: `领取任务 ${item.task.name}` });
      }
      lines.push(``);
      const menuLines = await this.support.buildNumberedMenu(userId, options, '💡 发送编号数字(如 1)即可领取对应任务');
      lines.push(...(menuLines.length > 0 ? menuLines : [`使用「领取任务 任务名」领取任务`]));
      return lines.join('\n');
    }

    // 参数为 NPC 名：从该单位的任务池随机接取（原版 随机文本 + 领取文案）。
    const source = sources.find((item) => item.npcName === wantedName);
    if (source) {
      // 原版 L7360-7371：已经领取了该 NPC 的任务 → 先去完成。
      let activeTasks: any[] = [];
      try {
        // tasks 现为原生 Json 列（可能直接是数组），用 asJsonValue 容错读取
        const parsedTasks = asJsonValue<any[]>(player.tasks, []);
        if (Array.isArray(parsedTasks)) activeTasks = parsedTasks;
      } catch { /* 任务数据异常按空处理 */ }
      if (source.publisher && activeTasks.some((t: any) =>
        String(t?.publisher ?? t?.发布人 ?? '') === String(source.publisher))) {
        return `${player.name || ''}你已经领取了${source.npcName}的任务了，先去完成吧`;
      }
      // 原版 L7346-7358：对其他人好感满100的 NPC 不再发任务。
      const unit = units.find((u: any) => this.questUnitName(u) === wantedName
        || String(u?.qq ?? u?.QQ ?? '') === String(source.publisher ?? ''));
      if (unit) {
        const npcMarkers = this.parseNpcMarkers(unit);
        const currentKey = `好感${userId}`;
        const otherMax = Object.entries(npcMarkers).some(([key, value]) =>
          key.startsWith('好感') && key !== currentKey && Number(value) >= 100);
        if (otherMax) {
          return `【${source.npcName}】不想理你(对其他人好感100)`;
        }
      }
      const available = await this.taskService.getAvailableTasks(userId, source.taskNames, source.publisher);
      if (available.length === 0) {
        return `${player.name || ''},${source.npcName}现在没有可以给你的任务`;
      }
      const selected = available[Math.floor(Math.random() * available.length)];
      return this.taskService.acceptTask(userId, selected.name, source.publisher, source.npcName);
    }

    // 参数为任务名：在各单位任务池中找到发布人后领取；找不到按静态任务直接领取。
    const namedSource = sources.find((item) => item.taskNames.includes(questName));
    const publisher = namedSource?.publisher;
    return this.taskService.acceptTask(userId, questName, publisher);
  }

  /** 读取地图单位的标记对象（兼容对象/数组/JSON字符串三种存法）。 */

  parseNpcMarkers(unit: any): Record<string, any> {
    const raw = unit?.markers ?? unit?.标记 ?? {};
    const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
    if (Array.isArray(parsed)) {
      return Object.fromEntries(parsed.map((item: any) => [
        item?.name ?? item?.名称,
        Number(item?.value ?? item?.数值 ?? item?.count ?? 0),
      ]).filter(([name]) => Boolean(name)));
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  }

  /**
   * 将地图运行时单位映射为原版“对话列表”的任务池。
   * 静态 NPC 配置使用 taskId，运行时召唤物同时兼容任务/任务池字段；
   * publisher 保留 QQ/id，用于任务发布人互斥和好感奖励回写。
   */

  getQuestSources(units: any[]): QuestSource[] {
    const sources: QuestSource[] = [];
    for (const unit of units || []) {
      if (!unit || typeof unit !== 'object') continue;

      const npcName = this.questUnitName(unit);
      const type = String(unit.type ?? unit.类型 ?? '').trim();
      const directTaskPool = unit.taskId ?? unit.taskID ?? unit.任务池 ?? unit.任务;
      const configNames = [
        String(unit.dialog ?? unit.对话 ?? '').trim(),
        `${type}对话`,
        `${npcName}对话`,
        type,
        npcName,
      ].filter(Boolean);

      let taskPool: any = directTaskPool;
      let config: any;
      for (const configName of configNames) {
        config = this.staticData.getNpcByName(configName);
        if (config) {
          if (taskPool === undefined || taskPool === null || taskPool === '') {
            taskPool = config.taskId ?? config.taskID ?? config.任务池 ?? config.任务;
          }
          break;
        }
      }

      // 对齐原版 领取任务（_主程序.ecode L7372-7384）：单位无专属对话配置或其任务池
      // 为空时，统一回退“通用对话”任务池（白回退 白对话，其余回退 通用对话），
      // 因此行商/露娜等地图 NPC 也能发放通用任务。
      if (taskPool === undefined || taskPool === null || taskPool === '') {
        const fallbackName = type === '白' || npcName === '白' ? '白对话' : '通用对话';
        const generic = this.staticData.getNpcByName(fallbackName);
        taskPool = generic?.taskId ?? generic?.taskID ?? generic?.任务池 ?? generic?.任务;
      }

      const taskNames = this.splitQuestNames(taskPool)
        .filter((name) => !!this.staticData.getTaskByName(name));
      if (taskNames.length === 0) continue;

      const publisherValue = unit.qq ?? unit.QQ ?? unit.id ?? unit.编号;
      const publisher = publisherValue === undefined || publisherValue === null || publisherValue === ''
        ? undefined
        : String(publisherValue);
      sources.push({ npcName: npcName || type || '未知对象', taskNames, publisher });
    }
    return sources;
  }


  splitQuestNames(value: any): string[] {
    const raw = Array.isArray(value)
      ? value.flatMap((item) => typeof item === 'string' ? item : [item?.name ?? item?.名称 ?? ''])
      : [value];
    return [...new Set(raw
      .flatMap((item) => String(item ?? '').split(/[，,、\n]+/))
      .map((item) => item.trim())
      .filter(Boolean))];
  }


  questUnitName(unit: any): string {
    return String(
      unit?.name
      ?? unit?.名称
      ?? unit?.image
      ?? unit?.图片
      ?? unit?.title
      ?? unit?.type
      ?? unit?.类型
      ?? '',
    ).trim();
  }

  /**
   * 查看任务
   * 查看当前已接取的任务列表
   */

  async handleCompleteQuest(userId: number, questName: string): Promise<string> {
    const result = await this.taskService.completePendingTask(userId, questName);
    return result || '正常任务完成后奖励已自动发放';
  }

  /**
   * 躺下（原版 _主程序.ecode L7086-7096）。
   * 门禁：死亡 → 行动无限制（理由6=自动开采中也可躺下）→ 建筑要求（床）→“需要床”。
   * 成功：置“躺下”标记 + 陪睡宠物数写入 sets.sleepover（有洛写负数，离线经验再×1.1）
   * + 躺下起床显示(1)（每秒经验/经验加成/陪睡加成/最终每秒获得，原版 数据显示.ecode L288-325）。
   * 注：躺下只结算经验，不回复 HP。
   */

  async handleAbandonQuest(userId: number, questName: string): Promise<string> {
    return this.taskService.abandonTask(userId, questName);
  }

  /**
   * 菜单（原版 接口1.ecode L325-330）。
   * 原版按“是否开启游戏”分流：游戏开启 → 游戏菜单/功能菜单；关闭 → 计算/快捷输入。
   * Web 端游戏常开，固定输出游戏菜单/功能菜单两层入口。
   */

  async handleHandbook(userId: number, arg: string): Promise<string> {
    if (!this.handbookService) {
      // 测试桩未注入图鉴服务时给出最低可用提示，避免栈崩
      return '图鉴服务未启用';
    }
    const playerData = await this.playerService.getPlayerData(userId).catch(() => null);
    const player = (playerData as any)?.player ?? playerData;
    const markers = (playerData as any)?.markers ?? {};
    const familiarName = String((playerData as any)?.player?.type ?? (playerData as any)?.type ?? (player as any)?.type ?? '');
    const skillLevel = this.playerService.getSkillLevel(markers, familiarName);
    const affinity = this.playerService.getMarkerValue(markers, familiarName + '好感');

    // 怪物「详细数据」分支需要玩家的掉落加成与宝石缎带状态；
    // 这些依赖较重（装备/载具/增益汇总），失败时回退 0，不影响图鉴其余部分。
    let playerDropRate = 0;
    let playerDropQuality = 0;
    let hasGemRibbon = false;
    try {
      const bonus = this.combatSystem.buildAttackerBonus((playerData as any).player, playerData as any);
      playerDropRate = Number(bonus?.掉落率 ?? 0);
      playerDropQuality = Number(bonus?.掉落品质 ?? 0);
      hasGemRibbon = this.support.hasEquippedSpecial(playerData, '宝石缎带', 0);
    } catch {
      // 图鉴是只读展示，加成取不到时按 0 展示基础掉落即可
    }

    // 世界等级与各物种熟练度不再由本方法透传：HandbookService 直接读
    // GlobalProficiencyService（原版「全局标记」），避免"接口留了数据没接"的中间层。
    return this.handbookService.handle(arg, {
      userId,
      playerName: String((playerData as any)?.player?.name ?? (playerData as any)?.name ?? (player as any)?.name ?? '冒险者'),
      markers,
      skillLevel,
      familiarName,
      affinity,
      playerDropRate,
      playerDropQuality,
      hasGemRibbon,
    });
  }
  // ========== 物品操作命令 ==========

  /**
   * 处理切换武器命令
   * 对应原版 _主程序.ecode L4303-4432 切换武器()：
   * 无参数/数字越界→列出武器清单；数字→按编号切换；其他→按武器名切换（"拳头"=空手）
   */

  async handleGameIntro(userId: number): Promise<string> {
    // 主菜单项（编号 + 触发指令）。全部为已验证存在、可正常执行的指令。
    const menu: { label: string; cmd: string }[] = [
      { label: '召唤使魔', cmd: '召唤使魔' },
      { label: '查看使魔', cmd: '使魔数据' },
      { label: '更换使魔', cmd: '选择使魔' },
      { label: '查看背包', cmd: '背包' },
      { label: '使魔数据', cmd: '使魔数据' },
      { label: '复活使魔', cmd: '复活使魔' },
      { label: '查看植入体', cmd: '查看植入体' },
      { label: '个人设置', cmd: '设置' },
      { label: '查看增幅器', cmd: '查看增幅器' },
      { label: '观察附近', cmd: '观察附近' },
      { label: '切换武器', cmd: '切换武器' },
      { label: '命名使魔', cmd: '命名使魔' },
      { label: '使魔商店', cmd: '使魔商店' },
      { label: '使魔家园', cmd: '使魔家园' },
      { label: '快速移动', cmd: '飞到' },
      { label: '传送到地图', cmd: '传送' },
      { label: '探测雷达', cmd: '探测雷达' },
      { label: '查看任务', cmd: '查看任务' },
      { label: '游戏图鉴', cmd: '图鉴' },
      { label: '游戏解释', cmd: '游戏解释' },
      { label: '制造', cmd: '制造' },
      { label: '载具模拟', cmd: '载具模拟' },
      { label: '使魔挑战', cmd: '使魔挑战' },
      { label: '宠物操作', cmd: '宠物操作' },
      { label: '装备预设', cmd: '装备预设' },
      { label: '使魔排行', cmd: '使魔排行' },
      { label: '使魔称号', cmd: '使魔称号' },
      { label: '更新历史', cmd: '更新历史' },
      { label: '逆向', cmd: '逆向' },
      { label: '扫荡', cmd: '扫荡' },
      { label: '配方', cmd: '配方' },
      { label: '全部指令', cmd: '帮助' },
    ];

    const lines: string[] = [
      `🎮 使魔大战 - 主菜单`,
      `━━━━━━━━━━━━━━━`,
      `发送下方编号数字即可进入对应功能：`,
    ];
    // 生成编号临时输入替换（1@指令#2@指令...），玩家发数字即可触发
    const tempGroups: string[] = [];
    for (let i = 0; i < menu.length; i++) {
      lines.push(`  ${i + 1}. ${menu[i].label}`);
      tempGroups.push(`${i + 1}@${menu[i].cmd}`);
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`💡 发送编号数字(如 1)即可快速进入功能`);
    lines.push(`也可以直接发送指令名，如「背包」「攻击」「移动 地图名」`);

    // 设置临时输入替换（2分钟有效，发数字即触发对应指令）
    if (tempGroups.length > 0) {
      await this.shortcutService.setTempInput(userId, tempGroups.join('#'));
    }

    return lines.join('\n');
  }

  /**
   * 新玩家"选第一个使魔"门禁（对应原版 _主程序.ecode L11464-11480）
   * 原版：新玩家(老玩家==假)发任何指令都会被强制拦截，返回"选择你的第一个使魔来开始游戏"，
   * 列出所有不可召唤=假的使魔并生成编号快捷（数字@选择使魔<名称>），选中后才正式开局。
   *
   * @param userId 玩家用户ID
   * @returns 未选使魔时返回门禁菜单文本；已选使魔返回 null
   */

  async handleGameTerms(userId: number, termName: string): Promise<string> {
    // 术语词典
    const terms: Record<string, string> = {
      '使魔': '玩家培养的宠物/伙伴，可以协助战斗和采集资源',
      '家园': '玩家自己建造的领地，可以建造建筑、种植作物、生产资源',
      '载具': '玩家组装的交通工具，提供移动速度加成和特殊功能',
      '好感度': '使魔对玩家的亲密度，影响使魔技能效果和忠诚度',
      '魔力': '玩家施放技能所需的能量值，可以通过药剂或休息恢复',
      '副本': '独立的战斗场景，包含怪物和宝藏',
      '圈地': '在家园系统中选择一块土地开始建造家园',
      '地基': '家园建造的基础阶段，需要消耗材料逐步建造',
      '产出': '建筑和作物自动生产的资源，需要定期收取',
      '捕捉': '驯服野生怪物作为自己的宠物/使魔',
      '饲料': '捕捉宠物时消耗的物品，用于吸引和驯服怪物',
      '补魔': '使用魔力药剂恢复魔力值',
      '挤奶': '从可产奶的宠物（如奶牛）中获取牛奶',
      '剪毛': '从可产毛的宠物（如普拉娜幼崽）中获取毛发',
    };

    if (!termName) {
      // 没有指定术语，显示所有可用术语列表
      const termList = Object.keys(terms).map((name, i) => `  ${i + 1}. ${name}`).join('\n');
      return [
        `📖 游戏名词解释`,
        `━━━━━━━━━━━━━━━`,
        `可用术语：`,
        termList,
        `━━━━━━━━━━━━━━━`,
        `发送「游戏解释 术语名」查看详细解释`,
      ].join('\n');
    }

    const explanation = terms[termName];
    if (!explanation) {
      return `未找到术语「${termName}」的解释，发送「游戏解释」查看所有可用术语`;
    }

    return `📖 【${termName}】\n${explanation}`;
  }

  /**
   * 处理更多帮助命令
   * 显示更多帮助信息，包括游戏进阶玩法说明
   * 对应原版：更多 命令
   */

  async handleMoreHelp(userId: number): Promise<string> {
    return [
      `📚 更多帮助信息`,
      `━━━━━━━━━━━━━━━`,
      `【家园系统】`,
      `  圈地 - 开始建造家园`,
      `  开挖地基 - 消耗材料开挖地基`,
      `  建造地基 - 消耗材料建造地基`,
      `  建造房子 - 消耗材料建造房子`,
      `  家园 - 查看家园状态`,
      `  家园产出 - 收取家园产出资源`,
      `━━━━━━━━━━━━━━━`,
      `【宠物系统】`,
      `  开始捕捉 怪物名 - 开始捕捉怪物`,
      `  停止捕捉 怪物名 - 停止捕捉`,
      `  捕捉 怪物名 - 直接捕捉`,
      `  全部跟随 - 让所有宠物跟随`,
      `  宠物操作 - 查看宠物操作菜单`,
      `━━━━━━━━━━━━━━━`,
      `【载具系统】`,
      `  组装 核心名 - 创建载具`,
      `  驾驶 载具名 - 驾驶载具`,
      `  载具 - 查看载具状态`,
      `  载具操作 - 查看操作指南`,
      `━━━━━━━━━━━━━━━`,
      `【其他系统】`,
      `  贸易 - 打开贸易市场`,
      `  签到 - 每日签到`,
      `  信息 - 查看角色信息`,
      `  背包 - 查看背包`,
      `  增幅器 - 查看增幅器说明`,
    ].join('\n');
  }

  /**
   * 处理更新历史命令
   * 显示游戏更新日志/更新历史
   * 对应原版：更新历史 命令
   */

  async handleChangelog(userId: number): Promise<string> {
    return [
      `📜 更新历史`,
      `━━━━━━━━━━━━━━━`,
      `【v1.0.0】`,
      `  - 实现家园系统（圈地、开挖地基、建造地基、建造房子）`,
      `  - 实现宠物捕捉系统`,
      `  - 实现载具组装与驾驶系统`,
      `  - 实现贸易市场系统`,
      `  - 实现每日签到系统`,
      `  - 实现战斗系统`,
      `━━━━━━━━━━━━━━━`,
      `【v0.9.0】`,
      `  - 实现基础攻击与战斗循环`,
      `  - 实现物品与装备系统`,
      `  - 实现地图与怪物系统`,
      `  - 实现玩家创建与升级系统`,
      `━━━━━━━━━━━━━━━`,
      `【v0.8.0】`,
      `  - 项目初始化`,
      `  - 实现基础框架搭建`,
      `━━━━━━━━━━━━━━━`,
      `更多更新内容请关注后续版本`,
    ].join('\n');
  }

  /**
   * 处理贸易命令
   * 玩家间贸易市场系统，支持查看市场、上架物品、下架物品、购买物品
   * 对应原版：贸易 命令
   */

  async handleHelpMe(userId: number, question: string): Promise<string> {
    if (!question) {
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;
      const map = await this.mapService.getMapById(player.mapId);
      const summons = this.support.parseJsonArray(map?.summons);
      const luna = summons.find((summon: any) =>
        String(summon?.qq ?? summon?.QQ ?? '') === '怪物露娜1g',
      );
      if (!luna) return `${player.name || '冒险者'}和谁求助呢？`;

      if (this.shortcutService?.setTempInput) {
        await this.shortcutService.setTempInput(userId, '1@求助确认');
      }
      return `【${luna.name || luna.名称 || '露娜'}】\n有解决不了的麻烦需要我帮忙的吗？\n1、求助确认`;
    }

    // 获取玩家信息
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取用户QQ号
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userQQ = user?.qqNumber || '';

    // 记录求助日志
    this.logger.log(`玩家 ${userId} (${userQQ}) 求助: ${question}`);

    // 返回求助信息（在实际游戏中，这里应发送到世界频道）
    return [
      `📢 求助信息已发送`,
      `━━━━━━━━━━━━━━━`,
      `玩家: ${player.name || '冒险者'}`,
      `问题: ${question}`,
      `━━━━━━━━━━━━━━━`,
      `你的求助已记录，请等待其他玩家帮助`,
    ].join('\n');
  }

  /**
   * 处理配方命令
   * 查看配方列表，从 GameCrafting 表中查询所有可制造配方，按类型分类显示
   */

  async handlePrivateChat(userId: number, targetName: string, content: string): Promise<string> {
    if (!targetName || !content) {
      return '请指定私聊对象和内容，格式：私聊 用户名 内容';
    }
    // 查找目标用户：优先按用户名/昵称精确匹配，支持数字ID
    const target = /^\d+$/.test(targetName)
      ? await this.prisma.user.findUnique({ where: { id: Number(targetName) } })
      : (await this.prisma.user.findFirst({ where: { username: targetName } })) ||
        (await this.prisma.user.findFirst({ where: { nickname: targetName } }));
    if (!target) {
      return `未找到玩家「${targetName}」`;
    }
    if (target.id === userId) {
      return '不能给自己发送私聊消息';
    }
    // 复用聊天服务的持久化 + 实时推送逻辑
    const msg = await this.chatService.sendPrivateMessage(userId, target.id, content);
    return `已私聊给 ${target.nickname || target.username}：${content}`;
  }

  /**
   * 处理反馈指令（指令通道，简化版）
   * 格式：反馈 内容  或  反馈 bug 标题|内容
   * 完整交互（分类选择/附件上传/回复）请使用网页内的反馈面板
   */

  async handleFeedback(userId: number, raw: string): Promise<string> {
    if (!raw) {
      return '请描述你遇到的问题或建议，格式：反馈 内容\n如需上传图片/分类，请使用网页内的「反馈」面板';
    }
    const feedback = await this.feedbackService.create(userId, {
      title: raw.slice(0, 30),
      category: 'general',
      content: raw,
      attachments: [],
    });
    return `反馈已提交，工单号 #${feedback.id}，我们会尽快处理。`;
  }

  /**
   * 领取任务（对齐原版 领取任务 分支 _主程序.ecode L7321-7404）：
   * - 无参数：列出当前地图各单位（NPC/召唤物/跟随的白）任务池中可领取的任务；
   * - 参数为 NPC 名：从该 NPC 的任务池随机接取一个（原版 随机文本），
   *   已有该 NPC 任务时提示“你已经领取了X的任务了，先去完成吧”；
   * - 参数为任务名：直接领取该任务。
   */

  async handleTextSend(userId: number, content: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查当前文本发送模式状态
    const currentMode = markers['文本发送模式'] || 0;

    if (!content) {
      // 没有指定模式，显示当前状态并切换
      const newMode = currentMode === 0 ? 1 : 0;
      markers['文本发送模式'] = newMode;
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);

      const modeText = newMode === 1 ? '文本发送模式' : '普通发送模式';
      this.logger.log(`玩家 ${userId} 切换发送模式为: ${modeText}`);
      return `已切换至「${modeText}」`;
    }

    // 处理文本内容发送
    if (currentMode === 0) {
      // 当前是普通模式，切换到文本模式并发送
      markers['文本发送模式'] = 1;
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);
    }

    // 在当前模式下发送文本内容
    this.logger.log(`玩家 ${userId} 发送文本: ${content}`);
    return `📨 文本消息已发送:\n${content}`;
  }

  /**
   * 处理查看指定玩家命令
   * 按QQ号或名称查找玩家，显示基本信息
   * 对应原版：查看玩家 命令
   */

  async handleCalculate(userId: number, expression: string): Promise<string> {
    const raw = String(expression ?? '').trim();
    if (!raw) {
      return '输入算式进行计算，如“计算1+1”，运算符号：+-*/(加减乘除)、^(乘方)、sin/tan/cos(三角函数)';
    }
    let expr = raw
      .replace(/\s+/g, '')
      .replace(/[x×]/gi, '*')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/。/g, '.')
      .replace(/、/g, '/');
    // 三角函数先归一为单字符记号，便于白名单校验
    expr = expr.replace(/sin/gi, 'S').replace(/cos/gi, 'C').replace(/tan/gi, 'T');
    if (!/^[0-9+\-*/().^SCT]+$/.test(expr)) {
      return `计算${raw}:\n错误：表达式包含不支持的字符`;
    }
    // 记号还原为 Math.sin( 等；无括号的三角函数（如 sin30）不予支持
    const mathExpr = expr
      .split('S(').join('Math.sin(')
      .split('C(').join('Math.cos(')
      .split('T(').join('Math.tan(')
      .split('^').join('**');
    if (/[SCT]/.test(mathExpr)) {
      return `计算${raw}:\n错误：三角函数需要括号，如 sin(30)`;
    }
    let value: number;
    try {
      // 白名单仅剩数字/运算符/括号与本次注入的 Math.* 调用，无标识符注入面
      value = Function('"use strict"; return (' + mathExpr + ')')();
    } catch (e: any) {
      return `计算${raw}:\n错误：${e?.message || '表达式无效'}`;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `计算${raw}:\n错误：结果无效`;
    }
    const display = expr.replace(/S/g, 'sin').replace(/C/g, 'cos').replace(/T/g, 'tan');
    return `计算${display}:\n${Math.round(value * 1e10) / 1e10}`;
  }

  /**
   * 数据刷新（原版 接口1.ecode L294-304）。
   * 原版把玩家在内存列表中重排到首位；Web 端等价动作是重读玩家最新数据。
   */

  async handleMenu(userId: number): Promise<string> {
    if (this.shortcutService?.setTempInput) {
      await this.shortcutService.setTempInput(userId, '1@游戏菜单#2@功能菜单');
    }
    return ['1、游戏菜单', '2、功能菜单'].join('\n');
  }

  /**
   * 功能菜单（原版 接口1.ecode L332-334）：7 项编号临时输入替换。
   * 子项映射：3@配平 → 生产配平、5@快捷输入 → 快捷 查看、7@管理菜单 → 管理；
   * 1@分赃/4@分赃2/6@制造助手 在原版即为无实现的菜单占位项，保持一致。
   * 原版回显漏列第 7 项，新版补全。
   */

  async handleFunctionMenu(userId: number): Promise<string> {
    if (this.shortcutService?.setTempInput) {
      await this.shortcutService.setTempInput(userId, '1@分赃#2@计算#3@生产配平#4@分赃2#5@快捷 查看#6@制造助手#7@管理');
    }
    return ['菜单', '1、分赃', '2、计算', '3、配平', '4、分赃2', '5、快捷输入', '6、制造助手', '7、管理菜单'].join('\n');
  }

  /**
   * 游戏菜单（原版 接口1.ecode L335-338）。
   * Web 端游戏常开（无群开关概念），直接输出；几率测试在原版即为无实现的占位项。
   */

  async handleGameMenu(userId: number): Promise<string> {
    if (this.shortcutService?.setTempInput) {
      await this.shortcutService.setTempInput(userId, '1@使魔大战#2@几率测试#3@数据刷新#4@重新读取数据#5@快捷 查看');
    }
    return ['游戏菜单', '1、使魔大战', '2、几率测试', '3、数据刷新', '4、重新读取数据', '5、快捷输入'].join('\n');
  }

  /**
   * 计算（原版 接口1.ecode L338-355）。
   * 表达式归一（x→*、全角括号→半角、。→.、、→/、去空格）→ 三角函数 sin/cos/tan
   * （需括号）→ 白名单字符校验后求值，支持 + - * / ^（乘方）。
   */

  async handleRefreshData(userId: number): Promise<string> {
    await this.playerService.getPlayerData(userId);
    return '已刷新。';
  }

  /**
   * 重新读取数据（原版 接口1.ecode L305-323）。
   * 原版展示本地存档文件时间并提供 a@确认重新读取数据 / b@备份数据 确认菜单；
   * Web 端数据实时落库（无 3 分钟存档延迟），保留确认入口，备份数据依赖本地文件未迁移。
   */

  async handleReloadData(userId: number): Promise<string> {
    if (this.shortcutService?.setTempInput) {
      await this.shortcutService.setTempInput(userId, 'a@确认重新读取数据');
    }
    return '确定要重新读取数据吗？这可能能解决指令不回复的问题\n（Web 端数据实时落库，无 3 分钟存档延迟）';
  }

  /**
   * 确认重新读取数据（原版 接口1.ecode L309-323）：强制重读玩家最新数据。
   * 原版有“距上次回复超5分钟”的活跃门禁，Web 端实时落库无丢失风险，直接执行。
   */

  async handleConfirmReloadData(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    return `${playerData.player.name || '冒险者'}已经重新读取了你的存档数据`;
  }

  // ========== 其他命令 ==========

  /**
   * 处理游戏主菜单命令
   * 显示使魔大战的主菜单，并通过临时输入替换生成编号子菜单（对齐原版 _主程序.ecode L1573）。
   * 玩家直接发编号数字即可进入对应功能，无需记忆指令名。
   * 对应原版：使魔大战 命令
   */

  async handleSettings(userId: number, settingName?: string, settingValue?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 未指定设置项：显示当前设置状态
    if (!settingName) {
      const globalVitality = await this.systemConfigService.get<boolean>('game.vitality.enabled', true);
      const globalGather = await this.systemConfigService.get<boolean>('game.gather.enabled', false);
      const lines = [
        `${player.name || '冒险者'}选择你需要修改的设置`,
        `在线状态：触发本游戏任意回复后10分钟内`,
        `新手指引：新手操作提示（默认开启，无法关闭）`,
        `采集：自动采集：在非战斗状态时静默采集资源且不会消耗地图上的资源，但是速度很慢，非在线状态也能采集；手动采集：手动采集资源`,
        `显示倍率:显示本次攻击时你的最终攻击加成倍率`,
        ``,
        `1、新手指引：${this.playerService.getMarkerValue(player.markers, '指引') === 0 ? '开' : '关'}`,
        `2、自动采集：${globalGather ? '开' : '关'}（管理员全局设置）`,
        `3、使用活力：${globalVitality ? '开' : '关'}（管理员全局设置）`,
        `4、宠物不扶：${this.playerService.getMarkerValue(player.markers, '不扶') === 1 ? '开' : '关'}`,
        `5、显示倍率：${this.playerService.getMarkerValue(player.markers, 'bl') === 1 ? '开' : '关'}`,
      ];
      // 原版 _主程序.ecode L5199：无参查看时生成 1@设置指引…8@设置购物 编号
      // 临时输入替换，玩家直接发数字即可切换对应设置（菜单链闭环）。
      if (this.shortcutService?.setTempInput) {
        await this.shortcutService.setTempInput(
          userId,
          '1@设置指引#2@设置采集#3@设置活力#4@设置不扶#5@设置倍率',
        );
      }
      return lines.join('\n');
    }

    // 指定设置项：按「开/关/数字」解析并写入 markers
    // 已知将被移除/锁定的设置项：随机数、背景音乐、自动购物已不再出现在菜单中；
    // 使用活力、自动采集由管理员全局控制；新手指引永远开启。
    const settingKey = settingName;

    if (settingKey === '随机数' || settingKey === '设置随机' || settingKey === 'setting-random') {
      return `随机数功能已移除，无法设置`;
    }
    if (settingKey === '背景音乐' || settingKey === '设置音乐' || settingKey === 'setting-music') {
      return `背景音乐功能已移除，无法设置`;
    }
    if (settingKey === '自动购物' || settingKey === '设置购物' || settingKey === 'setting-shop') {
      return `自动购物功能已移除，无法设置`;
    }

    if (settingKey === '使用活力' || settingKey === '设置活力' || settingKey === 'setting-vitality') {
      const enabled = await this.systemConfigService.get<boolean>('game.vitality.enabled', true);
      const statusText = enabled ? '开启' : '关闭';
      return `使用活力由管理员全局设置，当前为${statusText}，用户无法自行修改`;
    }
    if (settingKey === '自动采集' || settingKey === '设置采集' || settingKey === 'setting-gather') {
      const enabled = await this.systemConfigService.get<boolean>('game.gather.enabled', false);
      const statusText = enabled ? '开启' : '关闭';
      return `自动采集由管理员全局设置，当前为${statusText}，用户无法自行修改`;
    }

    if (settingKey === '新手指引' || settingKey === '设置指引' || settingKey === 'setting-guide') {
      return `新手指引默认开启，无法关闭`;
    }

    const settingVal = settingValue;
    let newValue: number;

    if (settingVal === undefined || settingVal.trim() === '') {
      return `请为「${settingName}」设置值：「开/关」或数字`;
    }

    if (settingVal === '开' || settingVal === 'on' || settingVal === 'true' || settingVal === '1') {
      newValue = 1;
    } else if (settingVal === '关' || settingVal === 'off' || settingVal === 'false' || settingVal === '0') {
      newValue = 0;
    } else {
      newValue = parseInt(settingVal, 10);
      if (isNaN(newValue)) {
        return `无效的设置值「${settingVal}」，请使用「开/关」或数字`;
      }
    }

    // 新手指引已不再允许修改（永远开启）
    if (settingKey === '指引') {
      return `新手指引默认开启，无法关闭`;
    }

    // 宠物不扶、显示倍率仍为用户可设置项（markers）
    const actualKey = settingKey === '新手指引' ? '指引' : settingKey;
    if (actualKey !== settingKey) {
      // 防坑：老旧 경로로 '指引' 直接传入也禁止修改
      return `新手指引默认开启，无法关闭`;
    }
    player.markers[actualKey] = newValue;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 设置 ${settingKey} = ${newValue}`);

    const statusText = newValue === 1 ? '关闭' : '开启';
    const displayText = `设置「${settingKey}」已${statusText}`;
    return displayText;
  }

  /**
   * 切换玩家标记类设置（存储在 markers 中）
   * 对应原版 _主程序.ecode「设置」系列指令的切换逻辑：
   * 读取当前值，若处于“开”则切换为“关”，否则切换为“开”
   * @param userId 用户ID
   * @param key 标记键名
   * @param onValue 标记中表示“开”的数值
   * @param offValue 标记中表示“关”的数值
   * @param onText 切换到“开”时返回的提示文本
   * @param offText 切换到“关”时返回的提示文本
   */

  async toggleSetting(
    userId: number,
    key: string,
    onValue: number,
    offValue: number,
    onText: string,
    offText: string,
  ): Promise<string> {
    // 同 handleEquipEnhance：读改写整体进用户写队列、基于活态执行。
    // 开关类指令本只该改一个键，但在锁外裸读档会把整列 markers 用旧快照写回，
    // 抹掉同一时刻尚未落库的好感/计数增量。
    return this.support.mutatePlayer(userId, async (ctx: any) => {
      const { player } = ctx;
      const markers: Record<string, number> = ctx.markers
        ?? asJsonValue<Record<string, number>>(player.markers, {});
      const isOn = this.playerService.getMarkerValue(markers, key) === onValue;
      markers[key] = isOn ? offValue : onValue;
      player.markers = markers;
      await this.playerService.savePlayer(player);
      return `${player.name || '冒险者'}，${isOn ? offText : onText}`;
    });
  }

  /**
   * 设置新手指引开关
   * 对应原版：设置指引
   * 标记「指引」：0=开启, 1=关闭
   */

  async handleSettingsGuide(userId: number): Promise<string> {
    return this.toggleSetting(userId, '指引', 0, 1, '开启了新手指引', '关闭了新手指引');
  }

  /**
   * 设置随机数开关
   * 对应原版：设置随机
   * 标记「自动战斗」：1=显示随机数, 0=不显示
   */

  async handleSettingsRandom(userId: number): Promise<string> {
    return this.toggleSetting(userId, '自动战斗', 1, 0, '开启了随机数', '关闭了随机数');
  }

  /**
   * 设置自动采集开关
   * 对应原版：设置采集
   * 标记「自动采集」：1=开启, 0=关闭
   */

  async handleSettingsGather(userId: number): Promise<string> {
    return this.toggleSetting(userId, '自动采集', 1, 0, '开启了自动采集', '关闭了自动采集');
  }

  /**
   * 设置活力消耗开关
   * 对应原版：设置活力
   * 标记「使用活力」：0=击杀怪物消耗活力, 1=不消耗
   */

  async handleSettingsVitality(userId: number): Promise<string> {
    return this.toggleSetting(userId, '使用活力', 0, 1, '活力现在击杀怪物会消耗', '活力现在击杀怪物不会消耗');
  }

  /**
   * 设置宠物是否扶起主人
   * 对应原版：设置不扶
   * 标记「不扶」：1=宠物不扶, 0=宠物会扶起
   */

  async handleSettingsNoHelp(userId: number): Promise<string> {
    return this.toggleSetting(userId, '不扶', 1, 0, '你现在不会被宠物扶起', '存活的宠物现在会扶你起来');
  }

  /**
   * 设置背景音乐开关
   * 对应原版：设置音乐
   * 标记「bgm」：0=播放bgm, 1=不播放
   */

  async handleSettingsMusic(userId: number): Promise<string> {
    return this.toggleSetting(userId, 'bgm', 0, 1, '播放bgm', '不播放bgm');
  }

  /**
   * 设置显示攻击倍率开关
   * 对应原版：设置倍率
   * 标记「bl」：1=显示倍率, 0=不显示
   */

  async handleSettingsMultiplier(userId: number): Promise<string> {
    return this.toggleSetting(userId, 'bl', 1, 0, '显示倍率', '不显示倍率');
  }

  /**
   * 设置自动购物对象
   * 对应原版：设置购物
   * 记录在 markers['自动购物'] 中，用于「购物自动」指令对自家行商自动购买
   * @param userId 用户ID
   * @param value 购物对象关键词（为空时表示查看当前设置）
   */

  async handleSettingsShop(userId: number, value?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!value) {
      const current = markers['自动购物'];
      return `${player.name || '冒险者'}#换行「设置购物工业、窝」来自动从行商处购买名称包含「工业」和「窝」的物品#换行「购物自动」来使用#换行只能对自己家里的行商使用#换行你当前的设置：${current || ''}`;
    }

    // 对应文本操作.ecode L55-77：原版仅拒绝消息控制字符；等号会被转成可保存的文本。
    const invalidNames: Array<[string, string]> = [
      ['#', '不能包含#'],
      ['!', '不能包含英文感叹号'],
      ['`', '不能包含`'],
      ['\n', '不能包含换行符'],
      ['\r', '不能包含换行符'],
      ['@', '不能包含@'],
      ['&', '不能包含&'],
      ['^', '不能包含^'],
      ['%', '不能包含%'],
    ];
    for (const [token, hint] of invalidNames) {
      if (value.includes(token)) {
        return `${player.name || '冒险者'}${hint}`;
      }
    }
    value = value.replace(/=/g, '【等号】');

    markers['自动购物'] = value;
    player.markers = markers;
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}自动购物的对象设置为${value}`;
  }

  /**
   * 设置玩家位置（管理员）
   * 对应原版：设置位置
   * 将指定玩家移动到地图列表下标或地图名称对应的地图
   * @param userId 调用者用户ID
   * @param value 参数：「目标 地图列表数组下标/地图名称」
   */

  async handleSettingsLocation(userId: number, value?: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) {
      return '权限不足，需要管理员权限';
    }

    if (!value) {
      return '不能输入空参数，「设置位置@人 地图列表数组下标/地图名称」';
    }

    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length !== 2) {
      return '不能输入空参数，「设置位置@人 地图列表数组下标/地图名称」';
    }

    // 解析目标玩家（支持 @QQ 或 QQ 号）
    const targetKey = parts[0].replace(/^@/, '');
    const targetPlayer = await this.prisma.player.findFirst({
      where: { masterQQ: targetKey },
    });
    if (!targetPlayer) {
      return `${targetKey} 在玩家列表不存在`;
    }

    // 解析目标地图（数字下标或名称）
    const mapKey = parts[1];
    let targetMap: any;
    if (/^\d+$/.test(mapKey)) {
      const maps = await this.mapService.getAllMaps();
      const index = parseInt(mapKey, 10);
      if (index < 1 || index > maps.length) {
        return `设置的地图编号超出定义范围：${mapKey}:${maps.length}`;
      }
      targetMap = maps[index - 1];
    } else {
      targetMap = await this.mapService.getMapByName(mapKey).catch(() => null);
      if (!targetMap) {
        return `${mapKey} 在地图列表不存在`;
      }
    }

    const oldMapId = targetPlayer.mapId;
    targetPlayer.mapId = targetMap.id;
    targetPlayer.location = targetMap.name;
    await this.playerService.savePlayer(targetPlayer);
    this.logger.log(`管理员 ${userId} 将玩家 ${targetKey} 从地图 ${oldMapId} 移动到 ${targetMap.name}`);

    return `把${targetPlayer.name || targetKey}的位置设置为${targetMap.name}`;
  }

  /**
   * 设置玩家/宠物标记（管理员）
   * 对应原版：设置标记
   * 支持修改玩家或宠物/召唤物的成就/标记/增益/标记2/配方
   * @param userId 调用者用户ID
   * @param value 参数：「@人/宠物id 标记名称 数值 位置(成就/标记/增益/标记2/配方) 持续时间」
   */

  async handleSettingsMarker(userId: number, value?: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) {
      return '权限不足，需要管理员权限';
    }

    if (!value) {
      return '不能输入空参数，「设置标记@人/宠物id 标记名称 数值 位置(成就/标记/增益/标记2/配方) 持续时间」';
    }

    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length < 4) {
      return '不能输入空参数，「设置标记@人/宠物id 标记名称 数值 位置(成就/标记/增益/标记2/配方) 持续时间」';
    }

    const target = parts[0];
    const markerName = parts[1];
    const markerValue = parseInt(parts[2], 10);
    const position = parts[3]; // 成就/标记/增益/标记2/配方
    const duration = parts.length > 4 ? parseInt(parts[4], 10) : 0;

    if (isNaN(markerValue)) {
      return `标记数值「${parts[2]}」不是有效数字`;
    }

    // 宠物/召唤物（id 以「怪物」或「召唤物」开头）
    if (target.startsWith('怪物') || target.startsWith('召唤物')) {
      const maps = await this.mapService.getAllMaps();
      for (const map of maps) {
        const summons = asJsonValue<any[]>(map.summons, []);
        const summon = summons.find((s: any) => s.qq === target || s.id === target);
        if (summon) {
          if (position === '成就' || position === '配方') {
            return `召唤物/宠物的${position}不可以修改(因为没效果)`;
          }
          if ((position === '标记2' || position === '增益') && !duration) {
            return `${position === '标记2' ? '设置标记2' : '设置增益'}需要提供第五个参数：持续时间`;
          }
          // mutateSummons 锁内闭环：重读最新 summons → 按 qq/id 重定位 → 写标记 → 差异落库
          await this.mapService.mutateSummons(map.id, (fresh) => {
            const idx = fresh.findIndex((s: any) => s.qq === target || s.id === target);
            if (idx === -1) return;
            const t = fresh[idx];
            if (!t.markers) t.markers = {};
            if (position === '标记') {
              t.markers[markerName] = markerValue;
            } else if (position === '标记2' || position === '增益') {
              if (!t.markers2) t.markers2 = {};
              t.markers2[markerName] = { value: markerValue, expireAt: Date.now() / 1000 + duration };
            }
          });
          return `${map.name}的${summon.name}的${markerName}标记被修改为${markerValue}`;
        }
      }
      return `世界地图上未找到id为${target}的宠物或者召唤物`;
    }

    // 玩家（@QQ 或 QQ 号）
    const targetKey = target.replace(/^@/, '');
    const targetPlayer = await this.prisma.player.findFirst({
      where: { masterQQ: targetKey },
    });
    if (!targetPlayer) {
      return `${targetKey} 在玩家列表不存在`;
    }

    const markers = asJsonValue<Record<string, any>>(targetPlayer.markers, {});
    const markers2 = asJsonValue<any[]>(targetPlayer.markers2, []);
    if (position === '标记' || position === '成就') {
      markers[markerName] = markerValue;
      targetPlayer.markers = markers; // Json 列直接写对象
    } else if (position === '标记2' || position === '增益') {
      if (!duration) {
        return `${position === '标记2' ? '设置标记2' : '设置增益'}需要提供第五个参数：持续时间`;
      }
      const now = Date.now() / 1000;
      markers2.push({ name: markerName, value: markerValue, expireAt: now + duration });
      targetPlayer.markers2 = markers2; // Json 列直接写数组
    } else if (position === '配方') {
      const recipes = asJsonValue<Record<string, any>>(targetPlayer.recipes, {});
      recipes[markerName] = markerValue;
      targetPlayer.recipes = recipes; // Json 列直接写对象
    }
    await this.playerService.savePlayer(targetPlayer);

    return `${targetPlayer.name || targetKey}的${markerName}${position}被修改为${markerValue}`;
  }

  /**
   * 开启副本
   * 使用副本钥匙在当前地图开启副本，生成临时怪物
   * @param userId 用户ID
   * @returns 副本开启信息
   */

  async getFirstFamiliarGate(userId: number): Promise<string | null> {
    // 轻量预检：此方法在每条指令的 dispatch 入口都会被调用，而绝大多数玩家
    // 早已选过使魔。一次 select type 的单列查询即可短路返回，避免每条消息
    // 都走 getPlayerData 的全量读档（整行 + 集合解析，远程库下是显著开销）。
    const lite = await this.prisma.player.findUnique({
      where: { userId },
      select: { type: true },
    });
    if (lite?.type) return null;

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    // 已选择使魔（type 非空）→ 不拦截；玩家行不存在时 lite 为 null，
    // 也会走到这里，交由 getPlayerData 的既有行为兜底处理
    if (player.type) return null;

    // 列出所有可召唤使魔（不可召唤=假 的才可被选为第一个使魔），
    // 文本格式与 选择使魔 无参列表共用同一构建器（原版 L11467-11480 两列编号菜单）
    const allFamiliars = this.staticData.getAllFamiliars().filter((f: any) => !f.noSummon);
    const menu = buildFamiliarGateMenu(allFamiliars);

    // 生成编号临时输入替换（发数字即触发 选择使魔<名称>）
    if (menu.tempInput) {
      await this.shortcutService.setTempInput(userId, menu.tempInput);
    }

    return menu.text;
  }

  /** 服务器本地日期串（对应原版 是否同天 的"同一天"判定粒度） */

  async triggerAutoFamiliarSkill(userId: number): Promise<string> {
    const lines: string[] = [];
    const autoSkillText = await this.familiarSystemService.autoCastSkill(userId);
    if (autoSkillText) lines.push(autoSkillText);

    const petSearchText = await this.familiarSkillsService.searchPetItems(userId);
    if (petSearchText) lines.push(petSearchText);

    return lines.join('\n');
  }

  /**
   * 生成编号快捷菜单（"编号选项"统一入口）
   * 对齐原版"快捷输入"的临时输入替换机制：为每个选项生成 编号@触发指令 的临时替换，
   * 玩家发送对应编号数字即可触发指令，无需记忆指令名。
   * 统一展示格式：1、选项A  2、选项B ...
   * @param userId 玩家用户ID
   * @param options 选项列表 [{ label: 展示文本, cmd: 触发指令(为空则仅展示不生成快捷) }]
   * @param hint 底部提示语（默认：💡 发送编号数字(如 1)即可快速操作）
   * @returns 生成的编号菜单展示行（含分隔线和提示），调用方直接 push 到输出即可
   */

  async handleConfirmHelp(userId: number, targetName: string): Promise<string> {
    // 对应原版：求助确认（_主程序.ecode L9877）
    // 机制：当前地图存在"露娜"召唤物（QQ=怪物露娜1g），若其归属为"1"（无人认领），
    // 则玩家可请求露娜帮忙，持续到下一个整点；成功后露娜归属改为玩家、好感置满。
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    const map = await this.support.getCurrentMap(userId);
    const summons = asJsonValue<any[]>(map.summons, []);
    // 露娜的标识：qq=怪物露娜1g（与 schedule.service 生成露娜时一致）
    const lunaIdx = summons.findIndex((s: any) => s.qq === '怪物露娜1g');
    if (lunaIdx === -1) {
      return `${player.name} 附近没有可以求助的对象`;
    }

    const luna = summons[lunaIdx];
    if (luna.ownerQQ === '1' || luna.ownerQQ === undefined || luna.ownerQQ === null) {
      // 露娜尚无人认领：玩家请求成功，好感置满、归属改玩家
      // 原版：置成就熟练度("好感"+QQ, 露娜.标记, 100) —— 这里以玩家标记记录对露娜的好感
      this.playerService.setMarker(markers, `好感怪物露娜1g`, 100);
      // mutateSummons 锁内闭环：重读最新 summons → 按 qq 重定位 → 锁内复查归属 → 写回 → 差异落库
      const claimed = await this.mapService.mutateSummons(map.id, (fresh) => {
        const idx = fresh.findIndex((s: any) => s.qq === '怪物露娜1g');
        if (idx === -1) return false;
        const owner = fresh[idx].ownerQQ;
        if (!(owner === '1' || owner === undefined || owner === null)) return false;
        fresh[idx].ownerQQ = player.userId.toString();
        return true;
      });
      if (!claimed) {
        return `${player.name} 露娜刚被别人认领了`;
      }
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);
      await this.taskService.advance(userId, '求助');
      return `${player.name} 好吧，从现在开始到下一个整点之前，我可以帮你解决战斗上的问题。`;
    } else {
      return `${player.name} 我正在帮 ${luna.ownerQQ} 解决问题，你之后再找我吧。`;
    }
  }

  /**
   * 自动购物
   * 对应原版：购物自动 命令
   */

  async handleProduce(userId: number, productName: string): Promise<string> {
    // 委托到 FamiliarSystemService 的家园产出操作
    // productName 参数在完整实现中可用于指定生产特定资源
    return this.familiarSystemService.handleHome(userId, '产出');
  }

  // ========== 副本命令 ==========

  /**
   * 处理副本清空命令
   * 清空当前副本的怪物，重置副本状态
   * 对应原版：清空副本 命令
   */

  async handleViewQuests(userId: number, selector = ''): Promise<string> {
    return this.taskService.listTasks(userId, selector);
  }

  /**
   * 提交任务
   * 完成的任务进行提交，获得奖励
   */
}
