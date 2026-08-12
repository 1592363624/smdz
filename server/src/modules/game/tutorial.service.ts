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
  viewBag: '📖 新手指引：这是你的背包，里面存放着所有物品。\n你可以使用「装备 物品名」来装备武器和防具，使用「使用 物品名」来消耗物品。',
  pickup: '📖 新手指引：地上有物品可以拾取！\n使用「拾取 物品名」拾取指定物品，或直接「拾取」拾取所有物品。',
  equipWeapon: '📖 新手指引：装备武器可以提升攻击力！\n使用「装备 石斧」来装备你的第一把武器，然后就可以使用「攻击」来战斗了。',
  equipArmor: '📖 新手指引：装备防具可以提升防御和生命！\n使用「装备 皮帽」或「装备 布衣」来穿戴防具，提升生存能力。',
  familiarData: '📖 新手指引：使魔是你的战斗伙伴！\n使用「召唤使魔」来召唤使魔，使用「选择使魔」切换当前使魔。\n使魔拥有独特的技能，使用「使魔技能」查看详情。',
  attack: '📖 新手指引：攻击怪物可以获得经验和掉落物品！\n先使用「装备 石斧」装备武器，然后使用「攻击」来战斗。\n注意：如果生命值过低，可以使用「躺下」休息恢复。',
  info: '📖 新手指引：这是你的角色信息面板，显示当前属性状态。\n你可以使用「探测」查看当前地图的详细信息，包括怪物、资源和可前往的地点。',
  map: '📖 新手指引：地图显示你当前所在的位置和可前往的区域。\n使用「移动 地图名」或「前往 地图名」来探索新区域。\n注意：部分高级地图需要达到一定等级才能进入。',
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