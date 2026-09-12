/**
 * 新手指引服务
 * 对应原版数据显示.ecode 中的新手指引子程序
 * 当玩家未完成新手指引时，对特定操作返回引导文本
 */

import { Injectable } from '@nestjs/common';
import { PlayerService } from './player.service';

/**
 * 新手指引文本映射
 * 每种操作类型对应一段引导提示，在玩家首次执行该操作时显示
 */
const TUTORIAL_TEXTS: Record<string, string> = {
  // 引导只讲用法、不描述"背包里有哪些物品"——正文已列出真实背包，引导再列举具体物品会自相矛盾
  viewBag: '📖 发送「查看背包1」查看第1个物品的详情；发送「装备 物品名」穿戴装备，发送「丢弃 物品名」丢弃物品。',
  pickup: '📖 你注意到地上有个闪闪发光的东西！\n使用「拾取 物品名」拾取指定物品\n使用「拾取 全部」拾取所有物品\n\n地上的物品可能是怪物掉落的，也可能是其他玩家留下的。',
  // 装备类引导只讲用法、不描述"你拿起了某件具体物品"——装备的具体物品由装备结算文案给出，
  // 引导若指名道姓（旧文案写死石制工具），穿上别的东西时会自相矛盾（2026-09-12 用户实测）。
  equipWeapon: '📖 只有当前手持武器的属性生效，可以发送「切换武器」来切换。\n发送「卸下 武器名」来卸下身上的武器。',
  equipArmor: '📖 同部位的装备会自动替换。\n发送「卸下 装备名」来卸下身上对应部位的装备。',
  familiarData: '📖 使魔是你的战斗伙伴！\n使用「召唤使魔」来召唤使魔，使用「选择使魔」切换当前使魔。\n使魔拥有独特的技能，使用「使魔技能」查看详情。',
  attack: '📖 你举起武器，准备战斗！\n眼前的史莱姆缓缓蠕动着，看起来并不强。\n\n使用「攻击」来攻击当前地图的怪物，击败它们可以获得经验和掉落物品。\n\n注意：如果生命值过低，可以使用「躺下」休息恢复。',
  info: '📖 这是你的角色信息面板。\n你可以看到自己的等级、经验、生命值、攻击力等属性。\n\n使用「探测」可以查看当前地图的详细信息，了解周围的环境。',
  // 同上：地图引导不描述"你周围是哪张地图"（正文已给出真实地图），只讲用法
  map: '📖 发送「移动 地图名」前往相邻地图，发送「探测」查看当前位置的怪物、NPC 与资源。',
  move: '📖 你迈开脚步，走向新的区域。\n在使魔大战的世界中，每个地图都有不同的怪物和资源。\n\n使用「地图」查看当前所在位置的信息。',
  talk: '📖 你看到前方有个人影，看起来是个NPC。\n使用「对话 NPC名」与NPC交谈，他们可能会给你任务或者有用的信息。\n\n试试和新手村的「新手引导员」对话吧！',
  craft: '📖 制造系统可以让你把收集到的材料加工成有用的物品。\n使用「制造」查看可制造的物品列表。\n\n收集足够的资源后，你可以制造武器、防具和各种工具。',
  quest: '📖 任务系统可以帮助你更好地了解游戏世界。\n使用「领取任务」查看可领取的任务。\n\n完成任务可以获得丰厚的奖励！',
  explore: '📖 探索是使魔大战的核心玩法之一。\n每个地图都有独特的怪物、资源和秘密等待你去发现。\n\n使用「探测」来查看当前地图的详细信息。',
};

@Injectable()
export class TutorialService {
  constructor(private readonly playerService: PlayerService) {}

  /**
   * 获取新手指引文本
   * 检查玩家是否开启了新手指引（markers.指引 == 0 表示开启）
   * 如果已关闭或已完成指引，返回空字符串
   * @param type 操作类型：viewBag, pickup, equipWeapon, equipArmor, familiarData, attack, info, map
   * @param markers 玩家标记对象
   * @returns 引导文本（空字符串表示不需要引导）
   */
  getTutorial(type: string, markers: any): string {
    // 检查玩家是否开启了新手指引
    // markers.指引 == 0 表示开启，== 1 表示已关闭
    const guideValue = markers['指引'];
    if (guideValue !== 0 && guideValue !== undefined) {
      return '';
    }

    // 检查该操作是否已有对应的完成标记
    // 格式：指引_操作类型，存在表示已引导过
    const tutorialMarker = `指引_${type}`;
    if (markers[tutorialMarker] !== undefined) {
      return '';
    }

    // 返回对应的引导文本
    const tutorialText = TUTORIAL_TEXTS[type];
    if (!tutorialText) {
      return '';
    }

    return tutorialText;
  }

  /**
   * 标记某操作类型的新手指引已完成
   * 设置 markers.指引_操作类型 = 1，下次不再显示该操作的引导
   * @param markers 玩家标记对象
   * @param type 操作类型
   */
  markTutorialDone(markers: any, type: string): void {
    const tutorialMarker = `指引_${type}`;
    markers[tutorialMarker] = 1;
  }

  /**
   * 取出引导文本并标记该类型引导已消费（写入 markers 的「指引_类型」并落库）。
   *
   * 唯一消费入口：各指令 handler 必须在**动作执行之后**调用（对齐原版"引导只追加、不拦截"：
   * 原版 _主程序.ecode L4262/L4289 装备引导、物品操作.ecode L811 查看背包引导均在正文之后拼接）。
   * 旧实现在 GameCommandHandler 内私有一份 checkTutorial，且部分分支在动作前拦截 return，
   * 导致「首次操作被引导吞掉」（2026-09-12 装备事故）；现收敛到本方法，禁止各处再自写一套。
   * @param userId 用户ID
   * @param type 操作类型（viewBag/pickup/equipWeapon/equipArmor/familiarData/attack/info/map）
   * @returns 引导文本（空字符串表示无需引导）
   */
  async consumeTutorial(userId: number, type: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const markers: any = playerData?.markers ?? {};
    const text = this.getTutorial(type, markers);
    if (!text) return '';
    // 标记该引导已完成，下次不再显示（markTutorialDone 直接写传入的 markers，勿再重复赋值）
    this.markTutorialDone(markers, type);
    // 命令化写入口：只投递「markers 这一列被改了」的意图，由邮箱内基于最新活态应用。
    // 不传整行对象，因此不存在「旧快照字段顺带覆盖活态」的可能。
    await this.playerService.patchPlayer(userId, { markers }, 'tutorial');
    return text;
  }

  /**
   * 关闭新手指引
   * 设置 markers.指引 = 1，不再显示任何引导
   * @param markers 玩家标记对象
   */
  disableTutorial(markers: any): void {
    markers['指引'] = 1;
  }

  /**
   * 开启新手指引
   * 设置 markers.指引 = 0，重新显示引导
   * @param markers 玩家标记对象
   */
  enableTutorial(markers: any): void {
    markers['指引'] = 0;
  }

  /**
   * 检查新手指引是否开启
   * @param markers 玩家标记对象
   * @returns true=指引开启, false=指引关闭
   */
  isTutorialEnabled(markers: any): boolean {
    const guideValue = markers['指引'];
    return guideValue === 0 || guideValue === undefined;
  }

  /**
   * 处理新手教程命令
   * 显示当前新手指引状态，或开启/关闭新手指引
   * @param userId 用户ID
   * @param action 操作类型（空=查看状态，on=开启，off=关闭）
   * @returns 提示文本
   */
  async handleTutorial(userId: number, action: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (action === 'on' || action === '开启') {
      this.enableTutorial(markers);
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);
      return '✅ 新手指引已开启，现在进行各种操作时将显示引导提示。';
    }

    if (action === 'off' || action === '关闭') {
      this.disableTutorial(markers);
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);
      return '✅ 新手指引已关闭。';
    }

    // 查看状态
    const enabled = this.isTutorialEnabled(markers);
    return enabled
      ? '📖 新手指引当前为开启状态。\n使用「新手教程 off」或「tutorial off」关闭。\n使用「新手教程 on」或「tutorial on」重新开启。'
      : '📖 新手指引当前为关闭状态。\n使用「新手教程 on」或「tutorial on」重新开启。';
  }
}