/**
 * 副本/关卡生成服务
 * 对应原版：后台运作.ecode 中的副本生成功能
 * 支持从 GameMonster 表读取真实怪物模板，生成精英怪变种和掉落物品
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StaticDataService } from './static-data.service';
import { MapService } from './map.service';

@Injectable()
export class DungeonService {
  private readonly logger = new Logger(DungeonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly staticData: StaticDataService,
    private readonly mapService: MapService,
  ) {}

  /**
   * 安全解析 JSON 字符串，解析失败返回默认值
   */
  private safeParseJSON<T>(jsonStr: string, defaultValue: T): T {
    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      return defaultValue;
    }
  }

  /**
   * 生成副本
   * 根据玩家等级和地图生成临时副本
   * @param playerLevel 玩家等级
   * @param mapId 地图ID
   * @returns 副本数据（含怪物列表、过期时间等）
   */
  async generateDungeon(playerLevel: number, mapId: number): Promise<any> {
    // 读取地图数据，获取该地图上配置的怪物模板列表（合并静态 JSON + 动态 DB）
    const map = await this.mapService.getMapById(mapId);
    if (!map) {
      throw new Error(`地图 ID=${mapId} 不存在，无法生成副本`);
    }

    // 解析地图上的怪物模板列表（monsters JSON 字段，存放固定怪物配置）
    const monsterTemplates: any[] = this.safeParseJSON(map.monsters, []);

    const dungeonId = `dungeon_${Date.now()}`;
    const monsters: any[] = [];

    // 副本怪物数量：基础3只，每10级增加1只，最多10只
    const monsterCount = Math.min(3 + Math.floor(playerLevel / 10), 10);

    for (let i = 0; i < monsterCount; i++) {
      // 从地图模板中随机选取一个作为基础
      const template = monsterTemplates.length > 0
        ? monsterTemplates[Math.floor(Math.random() * monsterTemplates.length)]
        : null;

      // 从静态配置读取真实怪物属性（若模板指定了名称，JSON 单一来源）
      let gameMonster: any = null;
      if (template?.name) {
        try {
          gameMonster = this.staticData.getMonsterByName(template.name);
        } catch {
          // 配置中不存在该怪物名称，忽略
        }
      }

      // 精英怪判定：20% 概率生成精英变种
      const isElite = Math.random() < 0.2;
      const eliteMultiplier = isElite ? 1.5 : 1; // 精英怪属性 1.5 倍

      // 怪物等级 = 玩家等级 ± 2 级波动
      const level = Math.max(1, playerLevel + Math.floor(Math.random() * 5) - 2);

      // 从 GameMonster → 模板 → 默认值 依次取属性
      const baseHp = gameMonster?.hp ?? template?.hp ?? (50 + level * 10);
      const baseAttack = gameMonster?.attack ?? template?.attack ?? (5 + level * 2);
      const baseDefense = gameMonster?.defense ?? template?.defense ?? (2 + level);
      const baseSpeed = gameMonster?.speed ?? template?.speed ?? (50 + level);
      const baseDodge = gameMonster?.dodge ?? template?.dodge ?? (5 + Math.floor(level / 5));
      const baseHit = gameMonster?.hit ?? template?.hit ?? (80 + Math.floor(level / 10));
      const baseExp = Math.floor((gameMonster?.level ?? level) * 10 + 10);

      const monster = {
        id: `dungeon_${dungeonId}_${i}`,
        name: isElite
          ? `⚡精英${gameMonster?.name || template?.name || '副本怪物'} Lv.${level}`
          : `${gameMonster?.name || template?.name || '副本怪物'} Lv.${level}`,
        level,
        specialSeq: gameMonster?.specialSeq ?? template?.specialSeq ?? 0,
        // 精英怪物攻防血 1.5 倍，速度、闪避、命中不变
        hp: Math.floor(baseHp * eliteMultiplier),
        maxHp: Math.floor(baseHp * eliteMultiplier),
        attack: Math.floor(baseAttack * eliteMultiplier),
        defense: Math.floor(baseDefense * eliteMultiplier),
        speed: baseSpeed,
        dodge: baseDodge,
        hit: baseHit,
        exp: Math.floor(baseExp * (isElite ? 2 : 1)), // 精英怪经验 2 倍
        drops: await this.generateDrops(gameMonster, template, level, isElite),
        isDungeon: true,
        isElite,
      };

      monsters.push(monster);
    }

    this.logger.log(`为地图 ${map.name} 生成了副本，${monsters.length} 只怪物（${monsters.filter(m => m.isElite).length} 只精英）`);

    return {
      id: dungeonId,
      mapId,
      monsters,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2小时过期
    };
  }

  /**
   * 生成副本怪物的掉落物品
   * @param gameMonster GameMonster 表记录（可能为 null）
   * @param template 地图怪物模板（可能为 null）
   * @param level 怪物等级
   * @param isElite 是否为精英怪
   * @returns 掉落物品数组
   */
  private async generateDrops(
    gameMonster: any,
    template: any,
    level: number,
    isElite: boolean,
  ): Promise<any[]> {
    const drops: any[] = [];

    // 通用掉落：魔物精华（数量随等级提升）
    const essenceCount = Math.max(1, Math.floor(level / 5) + 1) * (isElite ? 2 : 1);
    drops.push({
      name: '魔物精华',
      count: essenceCount,
      chance: 80, // 80% 概率掉落
    });

    // 精英怪额外掉落：副本碎片
    if (isElite) {
      drops.push({
        name: '副本碎片',
        count: 1,
        chance: 100,
      });
    }

    // 若 GameMonster 表有 bonus 加成字段，解析其中的掉落信息
    if (gameMonster?.bonus) {
      try {
        const bonus = typeof gameMonster.bonus === 'string'
          ? JSON.parse(gameMonster.bonus)
          : gameMonster.bonus;
        // 如果 bonus 中配置了 dropItems，则加入掉落列表
        if (Array.isArray(bonus.dropItems)) {
          for (const dropItem of bonus.dropItems) {
            drops.push(dropItem);
          }
        }
      } catch {
        // bonus 解析失败，忽略
      }
    }

    return drops;
  }
}