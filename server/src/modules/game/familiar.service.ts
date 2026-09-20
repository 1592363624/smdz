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
  affinity?: number;
  level?: number;
  id?: string;
}

/**
 * 剪毛/采集产出
 */
export interface HairDropItem {
  /** 物品名称 */
  name: string;
  /** 数量：规范键 quantity，读写 count 均拿不到值 */
  quantity: number;
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

  async getAllFamiliars(): Promise<any[]> {
    // 静态配置 JSON 单一来源，按特殊序号排序
    return this.staticData
      .getAllFamiliars()
      .slice()
      .sort((a, b) => (a.specialSeq ?? 0) - (b.specialSeq ?? 0));
  }

  async getFamiliarBySeq(specialSeq: number): Promise<any> {
    const familiar = this.staticData.getFamiliarBySeq(specialSeq);
    if (!familiar) {
      throw new NotFoundException(`特殊序号 ${specialSeq} 对应的使魔不存在`);
    }
    return familiar;
  }

  async getFamiliarByName(name: string): Promise<any> {
    const familiar = this.staticData.getFamiliarByName(name);
    if (!familiar) {
      throw new NotFoundException(`使魔「${name}」不存在`);
    }
    return familiar;
  }

  /** 对应原版 是否有特殊宠物()：地图上是否存在指定特殊序号的召唤物。 */
  checkHasSpecialPet(specialSeq: number, summons: any[]): boolean {
    return summons.some((s) => {
      // 支持多种字段名：specialSeq / special_seq / seq
      const seq = s.specialSeq ?? s.special_seq ?? s.seq;
      return seq === specialSeq;
    });
  }

  /** 取技能说明：优先 affinityDesc 档位文案，越界时收敛到首/末档，否则回落到 skillDesc/description。 */
  getSkillDescription(familiar: any, affinityLevel: number): string {
    const desc = familiar.skillDesc || familiar.description || '';

    const affinityDescs = asJsonValue<string[]>(familiar.affinityDesc, []);
    const idx = Math.max(0, Math.min(affinityLevel, affinityDescs.length - 1));
    if (affinityDescs[idx]) {
      return affinityDescs[idx];
    }

    return desc;
  }

  /** 好感度技能效果倍率（1.0 为基准）：每 1000 好感 +5%，上限 2.0。 */
  calcSkillEffect(familiar: any, affinity: number): number {
    const bonus = Math.min(1.0, Math.floor(affinity / 1000) * 0.05);
    return Math.min(2.0, 1.0 + bonus);
  }

  /** 剪毛/采集产出，对应原版宠物剪毛功能。 */
  getHairDrop(familiar: any): HairDropItem[] {
    const hairDropData = asJsonValue<Record<string, unknown> | HairDropItem[]>(familiar.hairDrop, {});

    // 支持两种格式：
    // 1. 数组格式：[{ name: "羊毛", quantity: 1, chance: 0.8 }]
    // 2. 对象格式：{ "羊毛": 1, "线": 2 }
    if (Array.isArray(hairDropData)) {
      return hairDropData as HairDropItem[];
    }

    return Object.entries(hairDropData).map(([name, quantity]) => ({
      name,
      quantity: quantity as number,
      chance: 1.0,
    }));
  }
}