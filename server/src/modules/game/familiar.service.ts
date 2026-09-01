/**
 * 使魔技能服务
 * 对应原版易语言：使魔技能.ecode
 * 负责使魔技能、宠物管理、特殊能力等
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StaticDataService } from './static-data.service';
import { asJsonValue } from '../../common/utils/json-value.util';

/**
 * 召唤物/宠物实例
 */
export interface SummonUnit {
  /** 特殊序号（对应 GameFamiliar.specialSeq） */
  specialSeq: number;
  /** 召唤物名称 */
  name: string;
  /** 当前好感度 */
  affinity?: number;
  /** 当前等级 */
  level?: number;
  /** 唯一标识 */
  id?: string;
}

/**
 * 剪毛/采集产出
 */
export interface HairDropItem {
  /** 物品名称 */
  name: string;
  /** 数量 */
  count: number;
  /** 概率（0~1） */
  chance?: number;
}

@Injectable()
export class FamiliarService {
  private readonly logger = new Logger(FamiliarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly staticData: StaticDataService,
  ) {}

  /**
   * 获取所有使魔列表
   */
  async getAllFamiliars(): Promise<any[]> {
    // 静态配置 JSON 单一来源，按特殊序号排序
    return this.staticData
      .getAllFamiliars()
      .slice()
      .sort((a, b) => (a.specialSeq ?? 0) - (b.specialSeq ?? 0));
  }

  /**
   * 根据特殊序号获取使魔
   */
  async getFamiliarBySeq(specialSeq: number): Promise<any> {
    const familiar = this.staticData.getFamiliarBySeq(specialSeq);
    if (!familiar) {
      throw new NotFoundException(`特殊序号 ${specialSeq} 对应的使魔不存在`);
    }
    return familiar;
  }

  /**
   * 根据名称获取使魔
   */
  async getFamiliarByName(name: string): Promise<any> {
    const familiar = this.staticData.getFamiliarByName(name);
    if (!familiar) {
      throw new NotFoundException(`使魔「${name}」不存在`);
    }
    return familiar;
  }

  /**
   * 检查玩家是否有某种特殊宠物在地图上
   * 对应原版：是否有特殊宠物()
   * @param specialSeq 要检查的特殊序号
   * @param summons 地图上的召唤物列表
   */
  checkHasSpecialPet(specialSeq: number, summons: any[]): boolean {
    return summons.some((s) => {
      // 支持多种字段名：specialSeq / special_seq / seq
      const seq = s.specialSeq ?? s.special_seq ?? s.seq;
      return seq === specialSeq;
    });
  }

  /**
   * 获取使魔技能描述
   * 根据好感度等级返回对应的描述文本
   * @param familiar 使魔对象
   * @param affinityLevel 好感度等级（0~4，对应5个档位）
   */
  getSkillDescription(familiar: any, affinityLevel: number): string {
    // 优先使用技能说明(skillDesc)，否则使用普通说明
    const desc = familiar.skillDesc || familiar.description || '';

    // 尝试解析好感度描述数组，获取对应等级的描述
    const affinityDescs = asJsonValue<string[]>(familiar.affinityDesc, []);
    const idx = Math.max(0, Math.min(affinityLevel, affinityDescs.length - 1));
    if (affinityDescs[idx]) {
      return affinityDescs[idx];
    }

    return desc;
  }

  /**
   * 根据好感度计算技能效果
   * 好感度越高，技能效果越强
   * @param familiar 使魔对象
   * @param affinity 当前好感度数值
   * @returns 效果倍率（1.0 为基准）
   */
  calcSkillEffect(familiar: any, affinity: number): number {
    // 基础效果为 1.0（100%）
    // 好感度每增加 1000，效果提升 5%，最高提升至 200%
    const bonus = Math.min(1.0, Math.floor(affinity / 1000) * 0.05);
    return Math.min(2.0, 1.0 + bonus);
  }

  /**
   * 剪毛/采集产出
   * 对应原版宠物剪毛功能
   * @param familiar 使魔对象
   * @returns 产出物品列表
   */
  getHairDrop(familiar: any): HairDropItem[] {
    const hairDropData = asJsonValue<Record<string, unknown> | HairDropItem[]>(familiar.hairDrop, {});

    // 支持两种格式：
    // 1. 数组格式：[{ name: "羊毛", count: 1, chance: 0.8 }]
    // 2. 对象格式：{ "羊毛": 1, "线": 2 }
    if (Array.isArray(hairDropData)) {
      return hairDropData as HairDropItem[];
    }

    // 对象格式转换为数组
    return Object.entries(hairDropData).map(([name, count]) => ({
      name,
      count: count as number,
      chance: 1.0,
    }));
  }
}