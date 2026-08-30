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
  viewBag: '📖 你打开背包，里面有一些基础物资：\n  石制工具 - 一把石制的工具，可以用来战斗\n  布帽 - 简单的布帽，能提供少量防护\n  布衣 - 粗糙的布衣，聊胜于无\n\n试试「装备 石制工具」来装备你的第一把武器！',
  pickup: '📖 你注意到地上有个闪闪发光的东西！\n使用「拾取 物品名」拾取指定物品\n使用「拾取 全部」拾取所有物品\n\n地上的物品可能是怪物掉落的，也可能是其他玩家留下的。',
  equipWeapon: '📖 你拿起石制工具，感觉沉甸甸的。\n石制工具的攻击力虽然不高，但对付新手村的史莱姆绰绰有余。\n\n装备完成后，使用「攻击」来试试你的实力吧！',
  equipArmor: '📖 穿戴好防具，你感觉安心了许多。\n布帽保护头部，布衣防护身体，这些都是冒险者的基本装备。\n\n试试「装备 布帽」来戴上帽子，再「装备 布衣」穿上衣服。',
  familiarData: '📖 使魔是你的战斗伙伴！\n使用「召唤使魔」来召唤使魔，使用「选择使魔」切换当前使魔。\n使魔拥有独特的技能，使用「使魔技能」查看详情。',
  attack: '📖 你举起武器，准备战斗！\n眼前的史莱姆缓缓蠕动着，看起来并不强。\n\n使用「攻击」来攻击当前地图的怪物，击败它们可以获得经验和掉落物品。\n\n注意：如果生命值过低，可以使用「躺下」休息恢复。',
  info: '📖 这是你的角色信息面板。\n你可以看到自己的等级、经验、生命值、攻击力等属性。\n\n使用「探测」可以查看当前地图的详细信息，了解周围的环境。',
  map: '📖 地图显示了你当前所在的位置。\n新手村周围连接着迷雾森林，那里有更强大的怪物。\n\n使用「移动 迷雾森林」前往新区域探索，但要注意提升等级哦！',
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
      player.markers = JSON.stringify(markers);
      await this.playerService.savePlayer(player);
      return '✅ 新手指引已开启，现在进行各种操作时将显示引导提示。';
    }

    if (action === 'off' || action === '关闭') {
      this.disableTutorial(markers);
      player.markers = JSON.stringify(markers);
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