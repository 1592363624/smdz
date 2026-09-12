/**
 * 宠物/召唤物指令域服务（game 模块化重构 P2-5 抽出）
 *
 * 职责：查看宠物/宠物操作（改名/转移/装备）、全部跟随/主动/被动/产奶/指令、
 * 挤奶结算（settleMilk 及产奶量/好感）、剪毛、开始/停止捕捉、大召唤术。
 * 依赖方向：依赖 FamiliarSystemService（召唤物系统主入口）、FamiliarSkillsService、
 * Player、Map、StaticData、Prisma、CombatState 与支撑层（updateOwnedSummonMode、
 * advanceTask、buildNumberedMenu、addItemToCollection、normalizeMarkers2 等通用出口）；
 * 不依赖其他指令域子服务。
 * 单一真相源：召唤物模式修改统一 updateOwnedSummonMode（支撑层）；
 * 产奶剩余展示统一 game-text.util.formatMsDurationText（remainingMinutes 口径）。
 * 对口原版：_主程序.ecode 宠物/挤奶/捕捉分支。
 */import { Injectable, Logger } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { formatMsDurationText } from '../../../common/utils/game-text.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { MapService } from '.././map.service';
import { FamiliarSystemService } from '.././familiar-system.service';
import { FamiliarSkillsService } from '.././familiar-skills.service';
import { StaticDataService } from '.././static-data.service';
import { CombatStateService } from '.././combat-state.service';
import { GameSupportService } from '.././game-support.service';

@Injectable()
export class PetCommandService {
  private readonly logger = new Logger(PetCommandService.name);

  constructor(
    private readonly support: GameSupportService,
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
    private readonly familiarSystemService: FamiliarSystemService,
    private readonly familiarSkillsService: FamiliarSkillsService,
    private readonly staticData: StaticDataService,
    private readonly combatState: CombatStateService,
  ) {}

  async handleViewPets(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const summons = asJsonValue<any[]>(map.summons, []);
    const lines: string[] = [`🐾 【${map.name}】的宠物/NPC:`, `━━━━━━━━━━━━━━━`];
    const options: { label: string; cmd: string }[] = [];

    if (summons.length === 0) {
      lines.push('  (当前地图没有宠物或NPC)');
    } else {
      summons.forEach((s: any) => {
        const name = s.name || s.qq || '未知';
        lines.push(`  ${name}`);
        // 生成"查看<名称>"快捷，点击查看详情（对应原版 L5454）
        options.push({ label: name, cmd: `查看 ${name}` });
      });
    }

    if (options.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      const menu = await this.support.buildNumberedMenu(userId, options, '💡 发送编号数字即可查看详情');
      lines.push(...menu);
    }
    return lines.join('\n');
  }

  /**
   * 处理查看载具命令（对应原版 _主程序.ecode L5457）
   * 列出当前地图的载具，并按编号生成"查看<名称>"快捷。
   */

  async handlePetOps(userId: number, action: string, args: string[]): Promise<string> {
    return `🐾 宠物操作：
1. 宠物改名 - 为宠物改名
2. 宠物转让 - 转让宠物
3. 宠物驾驶 - 骑乘宠物
4. 宠物喂食 - 喂食宠物
5. 宠物嗅探 - 宠物搜索
6. 宠物觉醒 - 宠物觉醒
7. 宠物攻击 - 宠物攻击
8. 宠物前往 - 宠物前往指定位置
9. 宠物装备 - 宠物装备管理`;
  }

  /**
   * 宠物改名
   * 对应原版：宠物改名 命令
   */

  async handlePetRename(userId: number, petName: string, newName: string): Promise<string> {
    return this.familiarSystemService.renamePet(userId, petName, newName);
  }

  /**
   * 宠物转让
   * 对应原版：宠物转让 命令
   */

  async handlePetTransfer(userId: number, petName: string, targetPlayer: string): Promise<string> {
    return this.familiarSystemService.transferPet(userId, targetPlayer, petName);
  }

  /**
   * 宠物驾驶
   * 对应原版：宠物驾驶 命令
   */

  async handleAllStop(userId: number): Promise<string> {
    const result = await this.support.updateOwnedSummonMode(userId, 'idle');
    return result.count > 0
      ? `🛑 已将 ${result.count} 只宠物留在这里。`
      : '当前地图上没有属于你的宠物';
  }

  /**
   * 全部主动
   * 对应原版：全部主动 命令
   */

  async handleAllActive(userId: number): Promise<string> {
    const result = await this.support.updateOwnedSummonMode(userId, 'active');
    return result.count > 0
      ? `⚔️ 已将 ${result.count} 只宠物设为主动攻击模式。`
      : '当前地图上没有属于你的宠物';
  }

  /**
   * 全部被动
   * 对应原版：全部被动 命令
   */

  async handleAllPassive(userId: number): Promise<string> {
    const result = await this.support.updateOwnedSummonMode(userId, 'passive');
    return result.count > 0
      ? `🛡️ 已将 ${result.count} 只宠物设为被动防御模式。`
      : '当前地图上没有属于你的宠物';
  }

  /**
   * 全部挤奶
   * 对应原版：全部挤奶 命令
   */

  async handleAllMilk(userId: number): Promise<string> {
    return (await this.settleMilk(userId, undefined, true)).text;
  }

  /**
   * 全部指令
   * 对应原版：全部指令 命令
   */

  async handleAllCommands(userId: number): Promise<string> {
    return `📋 全部宠物指令：
跟随、停下、主动、被动、挤奶`;
  }

  /**
   * 自动开采
   * 对应原版：开采自动 命令
   */

  async handleMilk(userId: number, targetName?: string): Promise<string> {
    const result = await this.settleMilk(userId, targetName, false);
    return result.text;
  }

  /** 批量挤奶与单体挤奶共用的结算入口。 */

  async settleMilk(
    userId: number,
    targetName?: string,
    all = false,
  ): Promise<{ text: string; count: number; amount: number }> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return { text: '你不在任何地图上', count: 0, amount: 0 };

    const summons = asJsonValue<any[]>(map.summons || '[]', []);
    const user = typeof this.prisma?.user?.findUnique === 'function'
      ? await this.prisma.user.findUnique({ where: { id: userId } }).catch(() => null)
      : null;
    const ownerIds = new Set([
      userId,
      player.id,
      player.userId,
      player.qqNumber,
      player.externalId,
      user?.qqNumber,
      user?.externalId,
      player.masterQQ,
    ].map((value) => String(value ?? '')).filter(Boolean));
    const isOwned = (pet: any): boolean => ownerIds.has(String(
      pet?.ownerQQ ?? pet?.归属 ?? pet?.owner ?? '',
    ));
    const displayName = (pet: any): string => String(
      pet?.name ?? pet?.名称 ?? pet?.type ?? pet?.类型 ?? '宠物',
    );
    const owned = summons.filter((pet: any) => isOwned(pet));

    if (!all && !targetName) {
      return { text: `${player.name || '冒险者'}请输入要挤奶的宠物名称`, count: 0, amount: 0 };
    }

    const targets = all
      ? owned
      : owned.filter((pet: any) => displayName(pet) === String(targetName).trim());
    if (!all && targets.length === 0) {
      return {
        text: `${player.name || '冒险者'}${map.name}这里没有属于你并且名为${targetName}的NPC或宠物`,
        count: 0,
        amount: 0,
      };
    }

    const markers2 = Array.isArray((playerData as any).markers2)
      ? (playerData as any).markers2
      : asJsonValue<any[]>(player.markers2, []);
    this.support.normalizeMarkers2(markers2);
    const now = Date.now();
    const endOfDay = new Date(now);
    endOfDay.setHours(24, 0, 0, 0);
    const dayEndMs = endOfDay.getTime();
    const cooldownFor = (pet: any): { cooling: boolean; remainingMs: number } => {
      const key = `挤奶${String(pet?.qq ?? pet?.QQ ?? pet?.id ?? '')}`;
      const marker = markers2.find((entry: any) => entry?.名称 === key);
      if (marker) {
        const remainingMs = Number(marker.有效期至 || 0) - now;
        if (remainingMs > 0) return { cooling: true, remainingMs };
        const index = markers2.indexOf(marker);
        if (index >= 0) markers2.splice(index, 1);
      }
      markers2.push({ 名称: key, 有效期至: dayEndMs });
      return { cooling: false, remainingMs: 0 };
    };

    // 原版只要玩家拥有茸，本次总奶量就增加25%，与被挤奶对象无关。
    const hasRong = owned.some((pet: any) => this.isMilkSpecial(pet, '茸', -10));
    const backpack = Array.isArray((playerData as any).backpack)
      ? (playerData as any).backpack
      : this.playerService.getBackpackItems(player);
    let totalMilk = 0;
    let successCount = 0;
    let cooldownText = '';
    let blueDragonReward = false;
    const successNames: string[] = [];

    for (const target of targets) {
      const qq = String(target?.qq ?? target?.QQ ?? target?.id ?? '');
      // 原版：QQ 中带 x 的临时召唤物不能挤奶。
      if (qq.includes('x')) continue;

      const amount = this.getMilkAmount(target);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const cooldown = cooldownFor(target);
      if (cooldown.cooling) {
        if (!all && !cooldownText) {
          cooldownText = `还需要${this.formatMilkRemaining(cooldown.remainingMs)}后才能再次给${displayName(target)}挤奶`;
        }
        continue;
      }

      this.addSummonMilkAffinity(target, ownerIds);
      totalMilk += amount;
      successCount += 1;
      successNames.push(displayName(target));

      if (this.isMilkSpecial(target, '青龙', -9)) blueDragonReward = true;
    }

    if (successCount === 0) {
      if (!all && cooldownText) {
        player.markers2 = markers2; // Json 列直接写数组
        await this.playerService.savePlayer(player);
        return { text: `${player.name || '冒险者'}${cooldownText}`, count: 0, amount: 0 };
      }
      return {
        text: `${player.name || '冒险者'}附近没有可以挤奶的对象了`,
        count: 0,
        amount: 0,
      };
    }

    if (hasRong) totalMilk *= 1.25;
    this.support.addItemToCollection(backpack, { name: '奶', type: '资源', quantity: totalMilk });
    player.backpack = backpack; // Json 列直接写数组
    player.markers2 = markers2; // Json 列直接写数组

    let extraText = '';
    if (blueDragonReward && !this.hasActiveMilkMarker(markers2, 'zq', now)) {
      markers2.push({ 名称: 'zq', 有效期至: dayEndMs });
      player.markers2 = markers2; // Json 列直接写数组
      const upgradeExp = Number(player.upgradeExp || 0);
      if (upgradeExp > 0) {
        player.exp = Number(player.exp || 0) + upgradeExp;
        extraText = `获得了${this.support.round2Text(upgradeExp)}经验\n`;
      }
    }

    await this.mapService.updateDynamicFields(map.id, { summons });
    await this.playerService.savePlayer(player);
    await this.support.advanceTask(userId, '挤奶', successCount);

    const bonusText = hasRong ? '（茸使奶量+25%）' : '';
    const names = successNames.join('、');
    const actionText = all
      ? `${player.name || '冒险者'}给${names}挤了奶，得到了奶×${this.support.round2Text(totalMilk)}`
      : `从${names}挤出了奶，获得了奶×${this.support.round2Text(totalMilk)}`;
    this.logger.log(`玩家 ${userId} 挤奶成功：${names} ×${totalMilk}`);
    return { text: `${extraText}${actionText}${bonusText}`, count: successCount, amount: totalMilk };
  }


  formatMilkRemaining(ms: number): string {
    return formatMsDurationText(ms, 'remainingMinutes');
  }


  hasActiveMilkMarker(markers2: any[], name: string, now: number): boolean {
    const marker = markers2.find((entry: any) => entry?.名称 === name);
    return Boolean(marker && Number(marker.有效期至 || 0) > now);
  }


  isMilkSpecial(pet: any, name: '茸' | '青龙', specialSeq: number): boolean {
    const petName = String(pet?.name ?? pet?.名称 ?? pet?.type ?? pet?.类型 ?? '');
    const vitality = Number(pet?.vitality ?? pet?.活力 ?? 0);
    const seq = Number(pet?.specialSeq ?? pet?.特殊序号 ?? 0);
    return petName === name || petName.includes(name) || vitality === specialSeq || seq === specialSeq;
  }


  getMilkAmount(pet: any): number {
    const name = String(pet?.name ?? pet?.名称 ?? pet?.type ?? pet?.类型 ?? '');
    const qq = String(pet?.qq ?? pet?.QQ ?? '');
    const direct = Number(pet?.milkAmount ?? pet?.milkYield ?? pet?.产奶量 ?? pet?.奶量);
    if (Number.isFinite(direct) && direct > 0) return direct;

    const rawBonus = pet?.bonus ?? pet?.加成;
    const bonus = typeof rawBonus === 'string'
      ? asJsonValue<any>(rawBonus, {})
      : (rawBonus || {});
    const fromPetBonus = Number(bonus?.产奶量 ?? bonus?.milkAmount ?? bonus?.milkYield);
    if (Number.isFinite(fromPetBonus) && fromPetBonus > 0) return fromPetBonus;

    const monster = this.staticData?.getMonsterByName?.(name)
      ?? this.staticData?.getMonsterByName?.(String(pet?.type ?? pet?.类型 ?? ''));
    const monsterBonus = typeof monster?.bonus === 'string'
      ? asJsonValue<any>(monster.bonus, {})
      : (monster?.bonus || {});
    const fromDefinition = Number(monsterBonus?.产奶量 ?? monsterBonus?.milkAmount ?? monsterBonus?.milkYield);
    if (Number.isFinite(fromDefinition) && fromDefinition > 0) return fromDefinition;

    const isMonster = qq.startsWith('怪物')
      || String(pet?.type ?? pet?.类型 ?? '').includes('怪物')
      || Number(pet?.specialSeq ?? pet?.特殊序号 ?? 0) < 0
      || Boolean(monster);
    if (isMonster) {
      return Number(pet?.affinity ?? pet?.好感 ?? 0) || 0;
    }
    return 0.25;
  }


  addSummonMilkAffinity(pet: any, ownerIds: Set<string>): void {
    const owner = String(pet?.ownerQQ ?? pet?.归属 ?? pet?.owner ?? '') || [...ownerIds][0] || '';
    const key = `好感${owner}`;
    const field = pet?.markers !== undefined ? 'markers' : (pet?.标记 !== undefined ? '标记' : 'markers');
    const raw = pet?.[field];
    if (Array.isArray(raw)) {
      const item = raw.find((entry: any) => (entry?.name ?? entry?.名称) === key);
      if (item) {
        if (item.value !== undefined) item.value = Number(item.value || 0) + 1;
        else if (item.数值 !== undefined) item.数值 = Number(item.数值 || 0) + 1;
        else item.value = 1;
      } else {
        raw.push({ name: key, value: 1 });
      }
      pet[field] = raw;
      return;
    }
    const markers = typeof raw === 'string'
      ? asJsonValue<any>(raw, {})
      : (raw && typeof raw === 'object' ? raw : {});
    const existingKey = Object.prototype.hasOwnProperty.call(markers, key)
      ? key
      : Object.prototype.hasOwnProperty.call(markers, `${owner}好感`) ? `${owner}好感` : key;
    markers[existingKey] = Number(markers[existingKey] || 0) + 1;
    pet[field] = typeof raw === 'string' ? JSON.stringify(markers) : markers;
  }

  /**
   * 处理剪毛命令（原版 _主程序.ecode L11267-11331）。
   * 门禁：装备要求（#剪刀=-40，持握）→ 无参用法提示 → 目标查找（归属召唤物按图片名 /
   * @玩家）→ 精英前缀替换 → 按物种当天冷却（"剪毛"+类型，有效期当天）→ 产物入包
   * → 成就四连（剪毛<类型>/剪毛/采集/采集<毛名>）。
   * 普拉娜幼崽关键词委托 FamiliarSystemService.shearPlana（独立冷却流程）。
   */

  async handleShear(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';

    // 装备要求（#剪刀，持握）（原版 L11270-11271：特殊序号-40，需拿在手上）
    const equipments = playerData.equipment || asJsonValue<any[]>(player.equipment, []);
    const weapons = playerData.weapons || asJsonValue<any[]>(player.weapons, []);
    if (!this.combatState.equipRequire(equipments, weapons, Number(player.currentWeapon ?? 0), -40, '剪刀', true)) {
      return `${name},需要装备剪刀并且拿在手上`;
    }

    // 无参 → 用法提示（原版 L11272-11273）
    if (!targetName) {
      return `${name},"剪毛@人/宠物名称"来剪毛，根据对象不同得到的毛发也不同`;
    }

    // 如果目标匹配普拉娜，委托到 FamiliarSystemService 的普拉娜幼崽剪毛操作
    if (/普拉娜|plana/i.test(targetName)) {
      const result = await this.familiarSystemService.shearPlana(userId);
      if (/获得了?毛发|获得毛发/.test(result) && !/冷却|需要|失败/.test(result)) {
        await this.support.advanceTask(userId, '剪毛');
        await this.support.advanceTask(userId, '剪毛普拉娜幼崽');
        await this.support.advanceTask(userId, '采集');
        await this.support.advanceTask(userId, '采集毛发');
      }
      return result;
    }

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';

    // 解析当前地图上的召唤物
    const summons = asJsonValue<any[]>(map.summons || '[]', []);
    const playerIdStr = String(player.userId);

    // 查找可剪毛的宠物（羊、绵羊、普拉娜等）
    const shearablePets = summons.filter((pet: any) => {
      const isOwner = String(pet.ownerQQ ?? pet.归属 ?? pet.owner ?? '') === playerIdStr;
      const isAlive = (pet.hp || pet.currentHp || 0) > 0;
      return isOwner && isAlive;
    });

    if (shearablePets.length === 0) {
      return '当前地图上没有可剪毛的宠物';
    }

    // 选择目标
    const target = targetName
      ? shearablePets.find((pet: any) => [
        pet.name,
        pet.名称,
        pet.image,
        pet.图片,
        pet.type,
        pet.类型,
      ].some((value) => String(value ?? '') === targetName))
      : shearablePets[0];

    if (!target) {
      // 原版 L11285-11287：召唤物未命中则按 @玩家 解析（玩家物种字段未迁移，
      // 玩家对象无毛发可剪，按“附近没有”口径提示）
      if (/^@/.test(targetName) || /^\[@.*\]$/.test(targetName)) {
        return `${name},附近没有${targetName.replace(/^@/, '').replace(/^\[/, '').replace(/\]$/, '')}`;
      }
      return `当前地图上没有名为「${targetName}」的可剪毛宠物`;
    }

    const targetType = String(target.type ?? target.类型 ?? target.name ?? target.名称 ?? '宠物')
      .replace(/^精英/, '');

    // 按物种当天冷却（原版 L11320-11322：时间间隔要求("剪毛"+类型, 有效期当天())）
    const markers2 = asJsonValue<any[]>(player.markers2, []);
    this.support.normalizeMarkers2(markers2);
    const now = Date.now();
    const endOfDay = new Date(now);
    endOfDay.setHours(24, 0, 0, 0);
    const cooldownKey = `剪毛${targetType}`;
    const active = markers2.find((m: any) => (m?.name ?? m?.名称) === cooldownKey);
    const activeExpire = Number(active?.expireAt ?? active?.有效期至 ?? 0) || 0;
    if (activeExpire > now) {
      return `${name}给${targetType}这种动物剪毛冷却${this.support.millisecondsToText(activeExpire - now)}`;
    }
    const marker = { name: cooldownKey, expireAt: endOfDay.getTime() };
    const markerIdx = markers2.findIndex((m: any) => (m?.name ?? m?.名称) === cooldownKey);
    if (markerIdx >= 0) markers2[markerIdx] = marker;
    else markers2.push(marker);
    player.markers2 = markers2; // Json 列直接写数组

    const targetDefinition = this.staticData?.getFamiliarByName?.(targetType)
      ?? this.staticData?.getMonsterByName?.(targetType);
    let hair: any = target.hair ?? target.毛发 ?? target.hairDrop ?? targetDefinition?.hairDrop;
    if (typeof hair === 'string') {
      const parsed = asJsonValue<any>(hair, null);
      if (parsed !== null) {
        hair = parsed;
      } else {
        const match = hair.match(/^(.*?)(-?\d+(?:\.\d+)?)$/);
        hair = {
          name: (match?.[1] || hair).trim() || '毛发',
          count: match ? Number(match[2]) || 1 : 1,
        };
      }
    }
    if (Array.isArray(hair)) hair = hair[0];
    const hairName = String(hair?.name ?? hair?.名称 ?? target.hairName ?? target.毛发名称 ?? '毛发');
    const hairCount = Math.max(1, Number(hair?.count ?? hair?.quantity ?? hair?.数量 ?? 1) || 1);

    // 原版 L11324-L11330：成功后任务同时记录物种、剪毛、采集和产物。
    await this.playerService.savePlayer(player);
    await this.playerService.addToBackpack(userId, hairName, hairCount);
    await this.support.advanceTask(userId, `剪毛${targetType}`, hairCount);
    await this.support.advanceTask(userId, '剪毛', hairCount);
    await this.support.advanceTask(userId, '采集', hairCount);
    await this.support.advanceTask(userId, `采集${hairName}`, hairCount);

    const targetDisplayName = target.name ?? target.名称 ?? target.type ?? target.类型 ?? '宠物';
    this.logger.log(`玩家 ${userId} 从 ${targetDisplayName} 剪毛成功`);
    return `${name}给${targetDisplayName}剪了毛，得到了${hairName}x${hairCount}`;
  }

  // ========== 任务/设置命令 ==========

  /**
   * 处理放弃任务命令
   * 放弃当前已接取的任务，从玩家任务列表中移除
   * 对应原版：放弃任务 命令
   */

  async handleFollowAll(userId: number): Promise<string> {
    const result = await this.support.updateOwnedSummonMode(userId, 'follow');
    if (result.count === 0) {
      return '当前地图上没有属于你的宠物';
    }
    this.logger.log(`玩家 ${userId} 设置了 ${result.count} 只宠物跟随`);
    return `已将 ${result.count} 只宠物设置为跟随模式`;
  }

  /**
   * 处理补魔命令
   * 补充魔力/能量，消耗资源恢复魔法值
   * 对应原版：补魔 命令
   */

  async handleStartCapture(userId: number, targetName: string): Promise<string> {
    // 委托到 FamiliarSystemService 的捕捉系统（start 动作）
    return this.familiarSystemService.capturePet(userId, 'start', targetName);
  }

  /**
   * 处理停止捕捉命令
   * 停止当前的捕捉操作，委托到 FamiliarSystemService 的捕捉系统
   * 对应原版：停止捕捉 命令
   */

  async handleStopCapture(userId: number, targetName?: string): Promise<string> {
    // 委托到 FamiliarSystemService 的捕捉系统（stop 动作）
    return this.familiarSystemService.capturePet(userId, 'stop', targetName);
  }

  /**
   * 修改当前地图上归属玩家、且允许控制的召唤物模式。
   * 原版“全部”命令只处理归属当前玩家的非幼崽/非阵地召唤物，不能把
   * 召唤物自身 QQ 当成归属，否则地图上的公共 NPC 可能被误改。
   */

  async handleMassSummon(userId: number, count: string): Promise<string> {
    // 委托到使魔技能服务执行大召唤术技能（count参数由底层实现处理）
    return this.familiarSkillsService.executeSkill(userId, '大召唤术');
  }

  /**
   * 处理复活使魔命令
   * 对应原版：复活使魔（玩家倒地后的30秒自救）
   */

  async handlePetDrive(userId: number, petName: string, vehicleName = '原'): Promise<string> {
    return this.familiarSystemService.petDrive(userId, petName, vehicleName);
  }

  /**
   * 宠物喂食
   * 对应原版：宠物喂食 命令
   */

  async handlePetFeed(userId: number, petName: string, count = 1): Promise<string> {
    return this.familiarSystemService.petFeed(userId, petName, count);
  }

  /**
   * 宠物嗅探
   * 对应原版：宠物嗅探 命令
   */

  async handlePetSniff(userId: number, targetName: string, monsterName = ''): Promise<string> {
    return this.familiarSystemService.petSniff(userId, targetName, monsterName);
  }

  /**
   * 宠物觉醒
   * 对应原版：宠物觉醒 命令
   */

  async handlePetAwaken(userId: number, petName: string, count = '1'): Promise<string> {
    return this.familiarSystemService.petAwaken(userId, petName, count);
  }

  /**
   * 宠物攻击
   * 对应原版：宠物攻击 命令
   */

  async handlePetAttack(userId: number, targetName: string): Promise<string> {
    return this.familiarSystemService.petAttack(userId, targetName);
  }

  /**
   * 宠物前往
   * 对应原版：宠物前往 命令
   */

  async handlePetGoto(userId: number, targetName: string, mapName = ''): Promise<string> {
    return this.familiarSystemService.petGoto(userId, targetName, mapName);
  }

  /**
   * 宠物装备
   * 对应原版：宠物装备 命令
   */

  async handlePetEquip(userId: number, petName: string, itemArg = ''): Promise<string> {
    return this.familiarSystemService.petEquip(userId, petName, itemArg);
  }

  /**
   * 全部停下
   * 对应原版：全部停下 命令
   */
}
