/**
 * 活力规则服务
 *
 * 对齐原版：普通击杀消耗活力后翻倍经验/资源，扫荡独立结算且不触发双倍。
 * 该服务只负责规则计算和玩家状态更新，持久化由调用方统一完成。
 */
import { Injectable } from '@nestjs/common';
import { SystemConfigService } from '../system-config/system-config.service';
import { PlayerService } from './player.service';

export interface VitalityRewardContext {
  mode?: 'normal' | 'sweep';
  killedCount?: number;
}

export interface VitalityRewardDecision {
  vitalityCost: number;
  rewardMultiplier: number;
  forced: boolean;
  enabled: boolean;
}

@Injectable()
export class VitalityService {
  static readonly BASE_MAX = 100;
  static readonly MARKER_MAX = '活力2';
  static readonly MARKER_USE = '使用活力';
  static readonly FORCE_CONFIG = 'game.forceVitality';

  constructor(
    private readonly systemConfig: SystemConfigService,
    private readonly playerService: PlayerService,
  ) {}

  /** 读取并规范化历史活力上限；旧存档缺失时回到原版基础上限100。 */
  getVitalityMax(markers: Record<string, any> | undefined | null): number {
    const recorded = Number(this.playerService.getMarkerValue(markers || {}, VitalityService.MARKER_MAX));
    return Number.isFinite(recorded) && recorded >= VitalityService.BASE_MAX
      ? recorded
      : VitalityService.BASE_MAX;
  }

  /**
   * 依据最终魅力更新历史活力上限。
   * 原版将 100+当前魅力写入“活力2”，该值只增不减。
   */
  recordHighestCharm(markers: Record<string, any>, charm: number): number {
    const current = this.getVitalityMax(markers);
    const rawCandidate = VitalityService.BASE_MAX + Number(charm || 0);
    const candidate = Number.isFinite(rawCandidate)
      ? Math.max(VitalityService.BASE_MAX, rawCandidate)
      : VitalityService.BASE_MAX;
    const next = Math.max(current, candidate);
    markers[VitalityService.MARKER_MAX] = next;
    return next;
  }

  /** 计算离线恢复后的活力，不改变传入对象之外的状态。 */
  recover(current: number, elapsedSeconds: number, vitalityMax: number): number {
    const max = Math.max(VitalityService.BASE_MAX, Number(vitalityMax) || VitalityService.BASE_MAX);
    const elapsed = Math.max(0, Number(elapsedSeconds) || 0);
    const value = Math.max(0, Number(current) || 0)
      + elapsed / 1200 * (1 + (max - VitalityService.BASE_MAX) / 200);
    return Math.min(max, value);
  }

  /**
   * 判断一批击杀采用何种活力奖励。
   * 强制开关优先级高于玩家的“使用活力”设置；扫荡永远不进入普通双倍路径。
   */
  async decide(player: any, markers: Record<string, any>, context: VitalityRewardContext = {}): Promise<VitalityRewardDecision> {
    const mode = context.mode || 'normal';
    if (mode === 'sweep') {
      return { vitalityCost: 0, rewardMultiplier: 1, forced: false, enabled: false };
    }

    const forced = await this.systemConfig.get<boolean>(VitalityService.FORCE_CONFIG, false);
    const personalValue = this.playerService.getMarkerValue(markers || {}, VitalityService.MARKER_USE);
    const enabled = forced || personalValue === 0;
    const available = Math.max(0, Number(player?.vitality) || 0);
    const requested = Math.max(0, Math.floor(Number(context.killedCount) || 0));
    const cost = enabled && available >= 1 ? Math.min(Math.floor(available), requested) : 0;
    return {
      vitalityCost: cost,
      rewardMultiplier: cost > 0 ? 2 : 1,
      forced,
      enabled,
    };
  }

  /** 在普通击杀结算后扣减实际活力，调用方随后保存同一玩家快照。 */
  async applyNormalKillCost(
    player: any,
    markers: Record<string, any>,
    killedCount: number,
  ): Promise<VitalityRewardDecision> {
    const decision = await this.decide(player, markers, { mode: 'normal', killedCount });
    if (decision.vitalityCost > 0) {
      player.vitality = Math.max(0, Number(player.vitality || 0) - decision.vitalityCost);
    }
    return decision;
  }

  /** 扫荡次数按当前活力截断；实际扣除由批量结算调用方一次性完成。 */
  getSweepCount(requestedCount: number, currentVitality: number): number {
    const requested = Math.max(0, Math.floor(Number(requestedCount) || 0));
    const available = Math.max(0, Math.floor(Number(currentVitality) || 0));
    return Math.min(requested, available);
  }

  /** 消耗扫荡次数对应的活力；扫荡奖励倍率固定为1。 */
  applySweepCost(player: any, requestedCount: number): number {
    const count = this.getSweepCount(requestedCount, player?.vitality);
    if (count > 0) player.vitality = Math.max(0, Number(player.vitality || 0) - count);
    return count;
  }
}
