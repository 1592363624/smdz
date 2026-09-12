/**
 * 时间结算/登录指令域服务（game 模块化重构 P2-4 抽出）
 *
 * 职责：离线/离线补偿结算（calculateTimeElapsed 及 WS 断连/重连钩子）、
 * 每日登录与签到、充值、行动提示（getActionHints）、今日字符串（localTodayString）。
 * 依赖方向：依赖 Player、CombatSystem、CombatState、Stats、Vitality、Task、
 * StaticData、支撑层（hasTrainerAccess/setMarkers2/incrementMarker/mutatePlayer）；
 * 不依赖任何指令域子服务。
 * 单一真相源：活力恢复公式走 VitalityService；池回复走 player-pool.util；
 * 增益标记写入统一支撑层 setMarkers2（秒口径）。
 * 对口原版：_主程序.ecode 时间流逝计算与登录奖励分支。
 */import { Injectable, Logger, Optional } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { formatDisplayNumber } from '../../../common/utils/game-text.util';
import { lookupFromStaticData, mergeBackpackItem } from '.././item-normalize.util';
import { capPoolValue } from '.././player-pool.util';
import { PlayerService } from '.././player.service';
import { CombatSystemService } from '.././combat-system.service';
import { StaticDataService } from '.././static-data.service';
import { TaskService } from '.././task.service';
import { StatsService } from '.././stats.service';
import { CombatStateService } from '.././combat-state.service';
import { VitalityService } from '.././vitality.service';
import { PlayerMutateService } from '.././player-mutate.service';
import { GameSupportService } from '.././game-support.service';

@Injectable()
export class TimeSettleService {
  private readonly logger = new Logger(TimeSettleService.name);

  constructor(
    private readonly support: GameSupportService,
    private readonly playerService: PlayerService,
    private readonly combatSystem: CombatSystemService,
    private readonly staticData: StaticDataService,
    private readonly taskService: TaskService,
    private readonly statsService: StatsService,
    private readonly combatState: CombatStateService,
    @Optional() private readonly vitalityService?: VitalityService,
    @Optional() private readonly playerMutate?: PlayerMutateService,
  ) {}

  async calculateTimeElapsed(
    userId: number,
    opts?: { force?: boolean; showBanner?: boolean },
  ): Promise<string> {
    try {
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;

      const now = Date.now();
      // lastOpTime/readTime 为 BigInt（schema BigInt），统一转 Number 参与运算
      const toNum = (v: any) => {
        if (v === null || v === undefined) return 0;
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const storedOpTime = toNum(player.lastOpTime) || toNum(player.readTime);

      // ===== 时间基准初始化（原版 加成计算.ecode L1596-1597）=====
      // 【原文 L1596】玩家.时间差 = (s - 玩家.读取时间) / #转秒
      // 【原文 L1597】玩家.读取时间 = 原始时间戳
      // 原版是「先算时间差、再无条件回写读取时间」，没有"时间差过小就不回写"的分支。
      // 本框架额外加了 10 秒防抖（不足 10 秒不结算、也不推进时间戳，让时间继续累积），
      // 这就带来一个死锁：新档/旧档/GM 清空数据后 lastOpTime 与 readTime 都是 0，
      // 若按旧写法 fallback 成 now，则 timeDiff 恒为 0 → 每次都从第 10 秒阈值处 return，
      // 永远走不到末尾的「写回 lastOpTime」→ 活力恢复/离线回血回盾回甲/躺下经验全部永久失效。
      // 因此这里必须先落一次基准时间戳（本次不补偿，等价于原版读档后第一次操作）。
      if (storedOpTime <= 0) {
        player.lastOpTime = BigInt(now);
        await this.playerService.savePlayer(player);
        return '';
      }

      // 计算时间差（秒）
      const timeDiff = Math.max(0, (now - storedOpTime) / 1000);

      // 如果时间差小于10秒，不进行补偿（避免频繁操作时的误补偿）；
      // force=true（WS 断开/重连的强制结算）跳过防抖，把时间基准精确推进到该时刻
      if (timeDiff < 10 && !opts?.force) {
        return '';
      }

      // 获取回复率（每秒回复量）
      const regenHp = player.regenHp || 0;
      const regenShield = player.regenShield || 0;
      const regenArmor = player.regenArmor || 0;

      // 死亡（当前生命<=0）不结算三池回复——原版 _计算玩家 L2383 用
      // .如果真(玩家.当前生命 > 0) 包住整段回复：死掉的玩家离线不会回血/盾/甲，
      // 必须靠 复活使魔/救助 等复活，不会因离线回复自动复活。
      const hpBefore = player.hp || 0;
      const shieldBefore = player.shield || 0;
      const armorBefore = player.armor || 0;
      if (hpBefore > 0) {
        // 三池口径红线（Issue #12-6 装甲实际回复对不上）：回复基数与封顶一律用
        // 「计算上限」（buildAttackerBonus 的 生命/护盾/装甲，含装备加成 = 面板分母），
        // 禁用基础 maxHp/maxShield/maxArmor——否则装备加成下回复永远够不到面板上限。
        // 回复速率同样取计算值（bonus.三回复已按原版 L2343-2345 /10 折算，
        // 含装备词条 生命恢复/装甲修复/护盾回复 贡献），与属性面板"每秒回复"口径一致。
        let capHp = player.maxHp || 100;
        let capShield = player.maxShield || 0;
        let capArmor = player.maxArmor || 0;
        let rateHp = regenHp;
        let rateShield = regenShield;
        let rateArmor = regenArmor;
        let rateHp2 = player.regenHp2 || 0;
        let rateShield2 = player.regenShield2 || 0;
        let rateArmor2 = player.regenArmor2 || 0;
        try {
          const regenBonus = this.combatSystem.buildAttackerBonus(player, playerData) as any;
          if (Number(regenBonus.生命) > 0) capHp = Number(regenBonus.生命);
          if (Number(regenBonus.护盾) > 0) capShield = Number(regenBonus.护盾);
          if (Number(regenBonus.装甲) > 0) capArmor = Number(regenBonus.装甲);
          // 回复速率取计算值（为 0 也是合法口径，如脏弹禁止回复），仅 NaN/缺失时兜底
          const pickRate = (v: any, fallback: number) =>
            Number.isFinite(Number(v)) && v !== undefined && v !== null ? Number(v) : fallback;
          rateHp = pickRate(regenBonus.生命回复, rateHp);
          rateShield = pickRate(regenBonus.护盾回复, rateShield);
          rateArmor = pickRate(regenBonus.装甲回复, rateArmor);
          // 回复2 为百分比词条（原版 时间差×回复2/100×属性.三池），取计算口径的百分比项
          rateHp2 = Number(regenBonus.生命回复2 ?? rateHp2) || 0;
          rateShield2 = Number(regenBonus.护盾回复2 ?? rateShield2) || 0;
          rateArmor2 = Number(regenBonus.装甲回复2 ?? rateArmor2) || 0;
        } catch { /* 加成缺失按基础值兜底 */ }

        // 应用回复公式：回复量 = 回复率 × 时间差（每秒回复"回复率"点）
        // 对齐原版 _计算玩家 L2401-2403：
        //   当前护盾 += 时间差 × 属性.护盾回复 + 时间差 × 属性.护盾回复2/100 × 属性.护盾
        const hpRegen = Math.floor(rateHp * timeDiff + rateHp2 / 100 * capHp * timeDiff);
        const shieldRegen = Math.floor(rateShield * timeDiff + rateShield2 / 100 * capShield * timeDiff);
        const armorRegen = Math.floor(rateArmor * timeDiff + rateArmor2 / 100 * capArmor * timeDiff);

        // 限制回复量不超过计算上限（含装备加成的面板分母）
        // 出口归一化：封顶到计算上限 + 两位小数 + 残值归零（cap<=0 时仅归一化）
        player.hp = capPoolValue(hpBefore + hpRegen, capHp);
        player.shield = capPoolValue(shieldBefore + shieldRegen, capShield);
        player.armor = capPoolValue(armorBefore + armorRegen, capArmor);
      }

      // ===== 躺下经验结算（原版 _计算玩家 L2478-2491） =====
      // a1 = 等级/100 × 时间差 × (1+属性.经验/100) × (1+|陪睡|×0.5) [若有鹭(陪睡<0)再×1.1]
      // 仅当 标记"躺下"==1 时生效；离线≥600秒时显示提示文本
      try {
        const markersObj = asJsonValue<any>(player.markers, {});
        if (markersObj['躺下'] === 1) {
          const setsObj = asJsonValue<any>(player.sets, {});
          const sleepover = Math.abs(Number(setsObj.sleepover) || 0);
          const isHaveCrane = (Number(setsObj.sleepover) || 0) < 0; // 负数为有鹭
          let lieExp = (player.level || 1) / 100 * timeDiff
            * (1 + (player.expBonus || 0) / 100)
            * (1 + sleepover * 0.5);
          if (isHaveCrane) lieExp *= 1.1;
          if (lieExp > 0) {
            player.exp = (player.exp || 0) + lieExp;
            if (timeDiff >= 600) {
              this.logger.log(`躺下离线经验 userId=${userId}, 离线${Math.floor(timeDiff / 60)}分钟, +${lieExp}经验`);
            }
          }
        }
      } catch (e: any) {
        this.logger.warn(`躺下经验结算失败: ${e.message}`);
      }

      // ===== 活力恢复（原版 _计算玩家 L2625-2643） =====
      // 活力与生命/护盾/装甲回复相互独立，即使三池回复率都为0也必须结算。
      let vitalityTipText = '';
      const vitalityMarkers2 = asJsonValue<any[]>(
        player.markers2, [],
      );
      try {
        const markersObj = asJsonValue<any>(player.markers, {});
        const vitalityMax = this.vitalityService
          ? this.vitalityService.getVitalityMax(markersObj)
          : Math.max(100, Number(this.playerService.getMarkerValue(markersObj, '活力2')) || 100);
        if (this.vitalityService) {
          player.vitality = this.vitalityService.recover(player.vitality, timeDiff, vitalityMax);
        } else {
          player.vitality = Math.min(
            vitalityMax,
            (player.vitality || 0) + timeDiff / 1200 * (1 + (vitalityMax - 100) / 200),
          );
        }
        if (Number(this.playerService.getMarkerValue(markersObj, '活力2')) < vitalityMax) {
          markersObj['活力2'] = vitalityMax;
          player.markers = markersObj; // Json 列直接写对象
        }
        // ===== 活力快满提示（原版 加成计算.ecode L2637-2640）=====
        // 【原文 L2637】.如果真 (玩家.活力 >= a1 * 0.8)
        // 【原文 L2638】    .如果真 (时间间隔要求 ("活力提示", 600, 玩家.标记2, 原始时间戳, , ) == 假)
        // 【原文 L2639】        玩家.额外文本 = 玩家.额外文本 + "#换行【活力快满了:" + 加斜杠 (玩家.活力, a1, 真) + "】"
        // 加斜杠(x, y, 真) 为取整显示，故这里用 Math.round 还原"当前/上限"。
        if ((player.vitality || 0) >= vitalityMax * 0.8) {
          const nowSec = now / 1000;
          const tipMark = vitalityMarkers2.find((m: any) => m && m.name === '活力提示');
          if (!tipMark || !tipMark.expireAt || tipMark.expireAt <= nowSec) {
            this.support.setMarkers2(vitalityMarkers2, '活力提示', nowSec + 600);
            player.markers2 = vitalityMarkers2; // Json 列直接写数组
            vitalityTipText = `【活力快满了:${Math.round(player.vitality || 0)}/${Math.round(vitalityMax)}】`;
          }
        }
      } catch (e: any) {
        this.logger.warn(`活力恢复结算失败: ${e.message}`);
      }

      // 更新最后操作时间（BigInt 字段）
      player.lastOpTime = BigInt(now);

      // 保存玩家数据
      await this.playerService.savePlayer(player);

      // 构建回复结果文本（显示走两位小数闸，消除 126.39999999999998 型浮点尾巴）
      const fmtDelta = (v: number) => formatDisplayNumber(v);
      const regenLines: string[] = [];
      const actualHpRegen = (player.hp || 0) - hpBefore;
      const actualShieldRegen = (player.shield || 0) - shieldBefore;
      const actualArmorRegen = (player.armor || 0) - armorBefore;

      if (actualHpRegen > 0) regenLines.push(`生命回复 +${fmtDelta(actualHpRegen)}`);
      if (actualShieldRegen > 0) regenLines.push(`护盾回复 +${fmtDelta(actualShieldRegen)}`);
      if (actualArmorRegen > 0) regenLines.push(`装甲回复 +${fmtDelta(actualArmorRegen)}`);
      // 活力提示属于玩家的额外文本，与三池回复同批输出（原版写入 玩家.额外文本）
      if (vitalityTipText) regenLines.push(vitalityTipText);

      if (regenLines.length > 0) {
        // 离线时长展示：≥60秒显示分钟，否则显示秒
        const minutes = Math.floor(timeDiff / 60);
        const seconds = Math.floor(timeDiff % 60);
        const durationText = minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
        this.logger.log(`时间补偿 userId=${userId}, 离线${durationText}, ${regenLines.join(', ')}`);
        // Web 在线语义：WS 仍连接（在线）时不输出「你离开了」横幅——离开计时以
        // WS 断开为起点（断开钩子强制结算推进 lastOpTime），重连时统一结算推送。
        // 活力快满提示与离开无关，在线时保留输出。测试桩 statsService 可能为空对象，需守卫。
        const wsOnline =
          typeof (this.statsService as any)?.isOnline === 'function' &&
          this.statsService.isOnline(userId);
        if (wsOnline && !opts?.showBanner) {
          return vitalityTipText;
        }
        return `⏰ 你离开了 ${durationText}\n${regenLines.join('\n')}`;
      }

      return '';
    } catch (error) {
      this.logger.error(`时间流逝计算失败 userId=${userId}: ${error.message}`);
      return '';
    }
  }

  /**
   * WS 断开（该用户最后一个连接关闭）时由 ChatGateway 调用：
   * 强制结算一次并把 lastOpTime 推进到断开时刻——「离开计时」由此精确起算。
   * 回复文本丢弃（此刻无人接收）。
   */

  async settleTimeElapsedOnDisconnect(userId: number): Promise<void> {
    try {
      await this.mutateForTimeElapsed(userId, { force: true });
    } catch (e: any) {
      this.logger.warn(`WS断开结算失败 userId=${userId}: ${e.message}`);
    }
  }

  /**
   * WS 重连（该用户首个连接建立）时由 ChatGateway 调用：
   * 结算断开期间的补偿并返回「你离开了 N 秒」文本
   * （离开时长 = 断开时刻 → 此刻，由断开时的强制结算保证精度）。
   * 重连本身即「回来」，离开计时到此为止。
   */

  async settleTimeElapsedOnReconnect(userId: number): Promise<string> {
    try {
      return await this.mutateForTimeElapsed(userId, { force: true, showBanner: true });
    } catch (e: any) {
      this.logger.warn(`WS重连结算失败 userId=${userId}: ${e.message}`);
      return '';
    }
  }

  /**
   * 时间补偿结算的写入口收口：与 command.service 指令链路共用同一 mutate 管道
   * （管道外自建读改写正是「旧快照整包覆盖」事故家族的温床）。
   */

  mutateForTimeElapsed(
    userId: number,
    opts: { force?: boolean; showBanner?: boolean },
  ): Promise<string> {
    if (this.playerMutate) {
      return this.playerMutate.mutate(userId, () => this.calculateTimeElapsed(userId, opts));
    }
    return this.playerService.enqueueUserWrite(userId, () =>
      this.calculateTimeElapsed(userId, opts),
    );
  }

  /**
   * 获取玩家当前所在的地图对象
   * @param userId 用户ID
   * @returns 地图对象
   */

  localTodayString(now = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  /**
   * 每日登录结算（对应原版 _主程序.ecode L11707-11821 每条消息结算段）：
   * 玩家当日首次指令时触发一次——
   * - 重置 冥鱼次数/创世纪/启示录 每日计数标记；
   * - 「签到」计数+1（即"加入游戏第N天"），并推进同名任务要求；
   * - 周末（周六传说/周日史诗）强化券x10 + 活力（10×(1+魅力/200)）；
   * - 使魔挑战层每日奖励：挑战装备箱/挑战物资箱/挑战资源箱各 ⌈层数/5⌉ 个；
   * - 隔日交替的今日登陆奖励：奇数天史诗/偶数天传说强化券x5 + 活力；
   * - 挑战 100/200/…/1000 层的里程碑额外奖励。
   * 未开局玩家不结算；开局确认当次即首触，因此新玩家第一条完整指令
   * 就会看到"加入游戏第1天"的登陆奖励块（与原版一致）。
   * @returns 需前插到指令结果之前的文本块；当日已结算或未开局返回 ''
   */

  async settleDailyLogin(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (!player.type) return '';

    const markers = asJsonValue<Record<string, any>>(player.markers, {});
    const today = this.localTodayString();
    if (markers['签到时间'] === today) return '';

    // 魅力取自完整加成计算（原版 玩家.属性.魅力），失败按 0 处理
    let charm = 0;
    try {
      const bonus = this.combatSystem.buildAttackerBonus(player, playerData) as any;
      charm = Number(bonus?.魅力) || 0;
    } catch {
      /* 加成计算失败不影响登录结算 */
    }

    markers['签到时间'] = today;
    // 跨天重置每日计数标记（原版 L11708-11710）
    markers['冥鱼次数'] = 0;
    markers['创世纪'] = 0;
    markers['启示录'] = 0;
    const signInDays = this.playerService.getMarkerValue(markers, '签到') + 1;
    markers['签到'] = signInDays;

    const vitalityGain = 10 * (1 + charm / 200);
    const w2Parts: string[] = [];
    const w3Parts: string[] = [];

    // 物品统一在内存背包中合并，随本次结算一次性落库（避免 addToBackpack 多次
    // 落库后再被末尾 savePlayer 的旧快照覆盖）
    const backpack = this.playerService.getBackpackItems(player);
    const grant = (itemName: string, count: number): void => {
      // 入包走唯一出口（按名合并 / type 以静态定义为唯一真源 / 两位小数收敛）
      mergeBackpackItem(
        backpack,
        { name: itemName, count, quantity: count },
        lookupFromStaticData(this.staticData),
      );
    };

    // 周末强化券（星期六=传说、星期日=史诗）+ 活力（原版 L11717-11732）
    const weekday = new Date().getDay(); // 0=周日 6=周六
    if (weekday === 6) {
      w2Parts.push(`(周末)10传说强化券、${Math.round(vitalityGain)}活力`);
      grant('传说强化券', 10);
      player.vitality = Number(player.vitality || 0) + vitalityGain;
    } else if (weekday === 0) {
      w2Parts.push(`(周末)10史诗强化券${Math.round(vitalityGain)}活力`);
      grant('史诗强化券', 10);
      player.vitality = Number(player.vitality || 0) + vitalityGain;
    }

    // 使魔挑战层每日奖励：挑战等级 0 视为 1，三箱数量 = ⌈层数/5⌉（原版 L11734-11746）
    let challengeLevel = this.playerService.getMarkerValue(markers, '挑战等级');
    if (challengeLevel <= 0) {
      challengeLevel = 1;
      markers['挑战等级'] = 1;
    }
    const boxCount = Math.ceil(challengeLevel / 5);
    grant('挑战装备箱', boxCount);
    grant('挑战物资箱', boxCount);
    grant('挑战资源箱', boxCount);
    w2Parts.push(`使魔挑战第${challengeLevel}层每日奖励:${boxCount}的挑战装备箱和挑战物资箱、资源箱`);

    // 隔日交替的今日登陆奖励（奇数天=史诗、偶数天=传说，原版 L11750-11774）。
    // 展示活力加成按「历史最高活力-100」计（原版 活力2 语义），与实际入账值可能不同（原版即如此）。
    const vitalityMax = Number(markers['活力2'] || 100);
    const displayCharm = Math.max(0, vitalityMax - 100);
    if (signInDays % 2 === 1) {
      w3Parts.push(`加入游戏第${signInDays}天\n今日登陆奖励:\n5史诗强化券、${Math.round(10 * (1 + displayCharm / 200))}活力`);
      grant('史诗强化券', 5);
      player.vitality = Number(player.vitality || 0) + vitalityGain;
    } else {
      w3Parts.push(`加入游戏第${signInDays}天\n今日登陆奖励:\n5传说强化券、${Math.round(10 * (1 + displayCharm / 200))}活力`);
      grant('传说强化券', 5);
      player.vitality = Number(player.vitality || 0) + vitalityGain;
    }

    // 挑战层里程碑额外奖励（原版 L11775-11816）
    const milestones: Array<[number, string, number]> = [
      [100, '饲料', 50],
      [200, '发带', 1],
      [300, '特装核心', 0.5],
      [400, '发带', 1],
      [500, '工业核心', 0.15],
      [600, '发带', 1],
      [700, '特装核心', 0.5],
      [800, '发带', 1],
      [900, '特装核心', 0.5],
      [1000, '工业核心', 0.15],
    ];
    for (const [floor, itemName, count] of milestones) {
      if (challengeLevel >= floor) {
        w3Parts.push(`使魔挑战${floor}层额外奖励:${itemName}x${count}`);
        grant(itemName, count);
      }
    }

    // 「签到」成就计入任务推进（原版 添加成就("签到",1,玩家.成就,玩家.任务) 的任务联动）
    try {
      await this.taskService.advance(userId, '签到');
    } catch {
      /* 无同名任务要求时为空操作 */
    }

    // 背包/标记/活力同一次落库（savePlayer 落库前会做经验归一化与属性重算）
    player.backpack = backpack; // Json 列直接写数组
    player.markers = markers; // Json 列直接写对象
    await this.playerService.savePlayer(player);

    // 组装顺序对齐原版 w = w2 + w3 + 换行 + w：
    // w2 各行以换行开头；w3 无前导换行（与 w2 末行拼接，如“…资源箱加入游戏第1天”），
    // 有内容时以“————————\n”结尾作为与指令正文的分隔。
    const w2 = w2Parts.length > 0 ? `\n${w2Parts.join('\n')}` : '';
    let w3 = w3Parts.join('\n');
    if (w3) {
      w3 += '\n————————\n';
    }
    return `${w2}${w3}`;
  }

  /**
   * 每条指令后的功能提示（对应原版 _主程序.ecode L11546-11564）：
   * - 训练冷却已过且当前不可训练（当前地图无训练器建筑、背包无训练器）时，
   *   每 600 秒（zdxlpd 标记）提示一次「你的训练器现在可以使用了」；
   * - 今日凭证未使用（无有效「凭证」标记）时，每 600 秒（pzpd 标记）提示一次「你现在可以使用凭证了」。
   * 未开局玩家不提示。
   * @returns 需追加到指令结果之后的文本（每行以换行开头）；无提示返回 ''
   */

  async getActionHints(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (!player.type) return '';

    const markers2 = asJsonValue<any[]>(player.markers2, []);
    const now = Date.now();
    const remainText = { value: '' };
    let changed = false;
    let hints = '';

    // 训练器提示（原版 L11546-11557）：无训练冷却才判断；当前不可训练才提示
    if (!this.combatState.markerRequire('训练冷却', markers2, remainText, now)) {
      const canTrain = await this.hasTrainerAccess(player);
      if (!canTrain && !this.combatState.markerRequire('zdxlpd', markers2, remainText, now)) {
        hints += '\n【你的训练器现在可以使用了】';
        this.combatState.addMarker('zdxlpd', 600, markers2, now);
        changed = true;
      }
    }

    // 凭证提示（原版 L11559-11564）：今日凭证未使用才提示
    if (!this.combatState.markerRequire('凭证', markers2, remainText, now)) {
      if (!this.combatState.markerRequire('pzpd', markers2, remainText, now)) {
        hints += '\n【你现在可以使用凭证了】';
        this.combatState.addMarker('pzpd', 600, markers2, now);
        changed = true;
      }
    }

    // markerRequire 会顺带清理过期标记；有变更时定点写回 markers2
    if (changed) {
      try {
        await this.playerService.enqueueUserWrite(player.userId, async () => {
          const _pd = await this.playerService.getPlayerData(player.userId);
          Object.assign(_pd.player, { markers2 }); // Json 列直接写数组
          await this.playerService.savePlayer(_pd.player);
        });
      } catch {
        /* 提示冷却写回失败不影响本次回复 */
      }
    }
    return hints;
  }

  /** 当前是否可训练：当前地图存在「训练器」建筑，或背包持有「训练器」 */

  async hasTrainerAccess(player: any): Promise<boolean> {
    return this.support.hasTrainerAccess(player);
  }

  /**
   * 处理游戏术语解释命令
   * 解释游戏中的专业术语，帮助玩家理解游戏机制
   * 对应原版：游戏解释 命令
   */

  async handleDailyCheckin(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 获取当前日期（使用中国时区）
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // 从 markers 中读取签到数据
    const checkinData = markers['daily_checkin'] || { lastDate: '', consecutiveDays: 0, totalDays: 0 };
    const lastDate = checkinData.lastDate || '';

    // 检查今天是否已经签到
    if (lastDate === todayStr) {
      return `你今天已经签到过了哦！\n━━━━━━━━━━━━━━━\n连续签到: ${checkinData.consecutiveDays || 0} 天\n累计签到: ${checkinData.totalDays || 0} 天\n\n明天再来签到吧~`;
    }

    // 检查昨天是否签到，判断连续天数
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    let consecutiveDays = (lastDate === yesterdayStr) ? (checkinData.consecutiveDays || 0) + 1 : 1;
    const totalDays = (checkinData.totalDays || 0) + 1;

    // 计算签到奖励
    const baseExp = 50; // 基础经验
    const consecutiveBonus = Math.min(consecutiveDays, 30) * 5; // 连续奖励，最多计算30天
    const totalExp = baseExp + consecutiveBonus;

    // 发放经验奖励
    await this.playerService.addExp(userId, totalExp);

    // 额外奖励：连续签到7天、15天、30天
    let extraReward = '';
    if (consecutiveDays === 7) {
      await this.playerService.addToBackpack(userId, '签到礼包', 1);
      extraReward = '\n🎉 连续签到7天！获得签到礼包×1';
    } else if (consecutiveDays === 15) {
      await this.playerService.addToBackpack(userId, '签到礼包', 2);
      extraReward = '\n🎉 连续签到15天！获得签到礼包×2';
    } else if (consecutiveDays === 30) {
      await this.playerService.addToBackpack(userId, '签到礼包', 3);
      extraReward = '\n🎉 连续签到30天！获得签到礼包×3';
    }

    // 累计签到奖励
    let totalReward = '';
    if (totalDays === 30) {
      await this.playerService.addToBackpack(userId, '累计签到礼包', 1);
      totalReward = '\n🏆 累计签到30天！获得累计签到礼包×1';
    } else if (totalDays === 100) {
      await this.playerService.addToBackpack(userId, '累计签到礼包', 2);
      totalReward = '\n🏆 累计签到100天！获得累计签到礼包×2';
    } else if (totalDays === 365) {
      await this.playerService.addToBackpack(userId, '累计签到礼包', 3);
      totalReward = '\n🏆 累计签到365天！获得满年签到礼包×3';
    }

    // 更新签到数据
    markers['daily_checkin'] = {
      lastDate: todayStr,
      consecutiveDays: consecutiveDays,
      totalDays: totalDays,
    };
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 签到成功，连续${consecutiveDays}天，累计${totalDays}天`);

    const lines = [
      `✅ 签到成功！`,
      `━━━━━━━━━━━━━━━`,
      `📅 ${todayStr}`,
      `🔥 连续签到: ${consecutiveDays} 天`,
      `📊 累计签到: ${totalDays} 天`,
      `━━━━━━━━━━━━━━━`,
      `✨ 获得经验: +${totalExp}`,
      extraReward ? `━━━━━━━━━━━━━━━${extraReward}` : '',
      totalReward ? `━━━━━━━━━━━━━━━${totalReward}` : '',
    ];

    return lines.filter(Boolean).join('\n');
  }

  /**
   * 处理文本发送命令
   * 切换发送模式（文本发送模式/普通发送模式）
   * 对应原版：文本发送 命令
   */

  async handleRecharge(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, markers2 } = playerData;
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }
    if (!this.support.hasEquippedSpecial(playerData, '护盾回充器', 4)) {
      return `${player.name}需要护盾回充器`;
    }
    const remaining = { value: '' };
    const now = Date.now();
    const cooling = this.combatState.timeIntervalRequire(
      '回充冷却', 90, markers2, now, remaining, now,
    );
    if (cooling) {
      player.markers2 = markers2;
      await this.playerService.savePlayer(player);
      return `${player.name}护盾回充冷却${remaining.value}`;
    }
    this.support.incrementMarker(markers, '活跃度', 1);
    this.combatState.addMarker('回充', 10, markers2, now);
    player.markers = markers;
    player.markers2 = markers2;
    await this.playerService.savePlayer(player);
    return `${player.name}启动了护盾回充器`;
  }

  /**
   * 处理修理命令
   * 对应原版 _主程序.ecode L7012-L7021：装备纳米注喷器后启动10秒修理增益，
   * 与回充共用90秒「回充冷却」，不读取修理目标，也不消耗修理材料。
   */
}
