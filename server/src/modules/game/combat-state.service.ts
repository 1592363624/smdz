/**
 * 战斗状态机核心层（易语言全局战斗函数的 1:1 复刻）
 *
 * 本文件集中实现原版各 .ecode 中的「全局战斗函数」，作为
 * _初始化怪物（加成计算.ecode L2644）与 攻击目标（战斗相关.ecode L4021）
 * 两个子程序共同依赖的基石。逐行对照原版，保证行为与数值一字不差。
 *
 * 对应原版函数来源：
 *  - 添加成就       数据分析.ecode L678
 *  - 取成就熟练度   数据分析.ecode L719
 *  - 置成就熟练度   数据分析.ecode L850
 *  - 标记要求       数据分析.ecode L747（操作「标记2」增益数组，含过期清理）
 *  - 添加标记       数据分析.ecode L778
 *  - 增益要求       数据分析.ecode L799（操作「增益」数组，含过期清理）
 *  - 时间间隔要求   数据分析.ecode L1008
 *  - 获得增益       加成计算.ecode L1522（返回最终强度）
 *
 * 数据结构约定（对齐易语言「技能」「增益」数组）：
 *  - AchievementItem = { 名称, 数值 }       对应原版 技能 数组成员
 *  - BuffItem        = { 名称, 强度, 有效期至, 是否叠加时间 }  对应原版 增益 数组成员
 *    · 有效期至 单位：毫秒时间戳（原版 #转秒=1000，时间参数单位为秒，存时 ×1000）
 *  - MarkerItem（标记2）= 同 BuffItem 结构（标记要求/添加标记 复用）
 */

import { Injectable } from '@nestjs/common';

/** #转秒：原版易语言时间常数，1秒 = 1000 毫秒 */
const SECOND_MS = 1000;

/** 成就/熟练度条目（原版「技能」数组项） */
export interface AchievementItem {
  /** 名称（如 "在线时间" / "破盾" / "火力全开"） */
  名称: string;
  /** 数值（熟练度/计数，可为负，但添加成就不保存负数） */
  数值: number;
}

/** 增益/标记条目（原版「增益」「标记2」数组项） */
export interface BuffItem {
  /** 名称（如 "激变星" / "强袭冷却" / "xla" / "麻痹"） */
  名称: string;
  /** 强度（部分增益有，如激变星强度=减伤秒数） */
  强度?: number;
  /** 有效期至：毫秒时间戳 */
  有效期至: number;
  /** 是否叠加时间（原版 增益.是否叠加时间 字段） */
  是否叠加时间?: boolean;
}

@Injectable()
export class CombatStateService {
  /**
   * 添加成就（数据分析.ecode L678）
   * 不保存负数：若遍历到同名项且最终值 ≤0 则删除；未遍历到且值为负直接返回。
   * 同时会扣减任务要求中同名的数值（本复刻暂不接入任务系统，任务参数为可选）。
   *
   * @param 名称 成就/熟练度名称
   * @param 数值 增减量
   * @param 成就 成就数组（会被原地修改）
   */
  addAchievement(名称: string, 数值: number, 成就: AchievementItem[]): void {
    名称 = (名称 || '').replace(/\s+/g, ''); // 删全部空
    // 先遍历已有同名项累加
    for (let i = 成就.length - 1; i >= 0; i--) {
      if (成就[i].名称 === 名称) {
        成就[i].数值 = 成就[i].数值 + 数值;
        // 不保存负数：值 ≤0 删除该项
        if (成就[i].数值 <= 0) {
          成就.splice(i, 1);
        }
        return;
      }
    }
    // 未遍历到对应名称，且提供的是负数 → 直接返回（不新增负项）
    if (数值 <= 0) return;
    // 新增成就项
    成就.push({ 名称, 数值 });
  }

  /**
   * 取成就熟练度（数据分析.ecode L719）
   * 支持精确匹配 / 模糊匹配（名称包含检索词）/ 取全部匹配之和。
   *
   * @param 成就 成就数组
   * @param 名称 检索名称
   * @param 模糊匹配 是否模糊匹配
   * @param 取全部匹配 模糊匹配时是否累加全部匹配项
   * @returns 熟练度数值
   */
  getAchievementProficiency(
    成就: AchievementItem[],
    名称: string,
    模糊匹配?: boolean,
    取全部匹配?: boolean,
  ): number {
    let a1 = 0;
    for (const item of 成就) {
      if (模糊匹配) {
        // 易语言 寻找文本(...) != -1 表示包含
        if (item.名称.indexOf(名称) !== -1) {
          if (取全部匹配) {
            a1 = a1 + item.数值;
          } else {
            return item.数值;
          }
        }
      } else {
        if (item.名称 === 名称) {
          return item.数值;
        }
      }
    }
    return a1;
  }

  /**
   * 置成就熟练度（数据分析.ecode L850）
   * 若熟练度 != 0 则设置（已存在则覆盖数值，不存在则新增）；为 0 则删除该项。
   *
   * @param 名称 名称
   * @param 成就 成就数组（原地修改）
   * @param 熟练度 目标数值
   */
  setAchievementProficiency(名称: string, 成就: AchievementItem[], 熟练度: number): void {
    for (let i = 成就.length - 1; i >= 0; i--) {
      if (成就[i].名称 === 名称) {
        if (熟练度 !== 0) {
          成就[i].数值 = 熟练度;
        } else {
          成就.splice(i, 1);
        }
        return;
      }
    }
    // 不存在且熟练度非0 → 新增
    if (熟练度 !== 0) {
      成就.push({ 名称, 数值: 熟练度 });
    }
  }

  /**
   * 标记要求（数据分析.ecode L747）
   * 操作「标记2」增益数组：
   *  1. 先清理过期项（有效期至 ≤ 时间戳 且 名称左边4字 != "刷新"）
   *  2. 再检索同名项，命中则通过 返回剩余时间 回写剩余时间文本并返回真
   * 注意：原版会先清理过期，因此本函数也会原地修改数组（删除过期项）。
   *
   * @param 检索名称 标记名称
   * @param 标记数组 标记2 增益数组（原地修改：清理过期）
   * @param 返回剩余时间 剩余时间显示文本（参考，回写）
   * @param 时间戳 当前毫秒时间戳
   * @returns 是否存在该标记
   */
  markerRequire(
    检索名称: string,
    标记数组: BuffItem[],
    返回剩余时间: { value: string },
    时间戳: number,
  ): boolean {
    // 第一步：清理过期标记（名称左边4字 == "刷新" 的不过期）
    for (let i = 标记数组.length - 1; i >= 0; i--) {
      const it = 标记数组[i];
      if (it.名称 === '') {
        标记数组.splice(i, 1);
        continue;
      }
      if (时间戳 - it.有效期至 >= 0) {
        // 原版：取文本左边(名称,4) != "刷新" 才删除
        if ((it.名称 || '').substring(0, 4) !== '刷新') {
          标记数组.splice(i, 1);
        }
      }
    }
    // 第二步：检索同名标记
    for (const it of 标记数组) {
      if (it.名称 === 检索名称) {
        const remainMs = it.有效期至 - 时间戳;
        // 数字到时间：剩余毫秒转可读文本（简化：显示秒/分）
        返回剩余时间.value = this.msToTimeText(remainMs);
        return true;
      }
    }
    return false;
  }

  /**
   * 添加标记（数据分析.ecode L778）
   * 同名标记则叠加时间（有效期至 += 时间×#转秒）；否则新增。
   * 时间 == 0 不添加。
   *
   * @param 名称 标记名称
   * @param 时间 秒
   * @param 标记 标记2 增益数组（原地修改）
   * @param 现行时间 毫秒时间戳
   */
  addMarker(名称: string, 时间: number, 标记: BuffItem[], 现行时间: number): void {
    if (时间 === 0) return;
    for (const it of 标记) {
      if (it.名称 === 名称) {
        it.有效期至 = it.有效期至 + 时间 * SECOND_MS;
        return;
      }
    }
    const b: BuffItem = { 名称, 有效期至: 现行时间 + 时间 * SECOND_MS };
    标记.push(b);
  }

  /**
   * 增益要求（数据分析.ecode L799）
   * 操作「增益」数组：先清理过期项（有效期至 ≤ s 则删除），
   * 再检索同名项，命中则回写 强度返回值 / 剩余时间返回值 并返回真。
   *
   * @param 名称 增益名称
   * @param 增益 增益数组（原地修改：清理过期）
   * @param 强度返回值 回写强度
   * @param s 当前毫秒时间戳
   * @param 剩余时间返回值 回写剩余秒数
   * @returns 是否存在该增益
   */
  buffRequire(
    名称: string,
    增益: BuffItem[],
    强度返回值: { value: number },
    s: number,
    剩余时间返回值: { value: number },
  ): boolean {
    let c = 0;
    for (let i = 增益.length - 1; i >= 0; i--) {
      // 原版：s - 有效期至 > 0 删除（已过期）
      if (s - 增益[i].有效期至 > 0) {
        增益.splice(i, 1);
        continue;
      }
      if (c === 0 && 增益[i].名称 === 名称) {
        c = 1;
        剩余时间返回值.value = (增益[i].有效期至 - s) / SECOND_MS;
        强度返回值.value = 增益[i].强度 || 0;
      }
    }
    if (c === 1) return true;
    强度返回值.value = 0;
    剩余时间返回值.value = 0;
    return false;
  }

  /**
   * 获得增益（加成计算.ecode L1522）
   * 返回最终强度。同名增益：按是否叠加强度/时间处理；否则新增。
   *
   * @param 增益 增益数组（原地修改）
   * @param 名称 增益名称
   * @param 时间 秒（0 表示不刷新有效期）
   * @param 是否叠加时间 是否叠加时间（而非覆盖）
   * @param s 当前毫秒时间戳
   * @param 强度 增益强度
   * @param 是否叠加强度 是否叠加强度（否则取 max）
   * @returns 最终强度
   */
  gainBuff(
    增益: BuffItem[],
    名称: string,
    时间: number,
    是否叠加时间: boolean,
    s: number,
    强度?: number,
    是否叠加强度?: boolean,
  ): number {
    for (const it of 增益) {
      if (it.名称 === 名称) {
        if (是否叠加时间) {
          it.有效期至 = it.有效期至 + 时间 * SECOND_MS;
          // 叠加后若已过期则删除并返回0
          if (s - it.有效期至 >= 0) {
            const idx = 增益.indexOf(it);
            if (idx >= 0) 增益.splice(idx, 1);
            return 0;
          }
        } else {
          if (时间 !== 0) {
            it.有效期至 = s + 时间 * SECOND_MS;
          }
        }
        it.是否叠加时间 = 是否叠加时间;
        if (是否叠加强度) {
          it.强度 = (it.强度 || 0) + (强度 || 0);
        } else {
          // 取较大值（原版：强度 < 新强度 才覆盖）
          if ((it.强度 || 0) < (强度 || 0)) {
            it.强度 = 强度;
          }
        }
        return it.强度 || 0;
      }
    }
    // 未找到 → 新增
    const z: BuffItem = {
      名称,
      有效期至: s + 时间 * SECOND_MS,
      是否叠加时间,
      强度: 强度 || 0,
    };
    增益.push(z);
    return 强度 || 0;
  }

  /**
   * 时间间隔要求（数据分析.ecode L1008）
   * 冷却返回真（并回写剩余时间文本），未冷却返回假并添加冷却标记。
   *
   * @param 名称 冷却标记名称
   * @param 冷却时间 秒
   * @param 标记 标记2 增益数组（原地修改）
   * @param 时间 毫秒时间戳
   * @param 返回文本 剩余时间文本（回写）
   * @param 原始时间戳 毫秒时间戳（默认=时间）
   * @returns 是否在冷却中
   */
  timeIntervalRequire(
    名称: string,
    冷却时间: number,
    标记: BuffItem[],
    时间: number,
    返回文本: { value: string },
    原始时间戳?: number,
  ): boolean {
    const 原始 = 原始时间戳 !== undefined ? 原始时间戳 : 时间;
    if (this.markerRequire(名称, 标记, 返回文本, 时间)) {
      返回文本.value = '还需要' + 返回文本.value;
      return true;
    }
    this.addMarker(名称, 冷却时间, 标记, 原始);
    return false;
  }

  /** 毫秒转可读时间文本（简化版，对应原版 数字到时间） */
  private msToTimeText(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / SECOND_MS));
    if (totalSec < 60) return `${totalSec}秒`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}分${sec}秒`;
  }
}
