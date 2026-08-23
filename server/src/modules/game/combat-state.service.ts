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
import { SetData } from './bonus.service';
import { SEQ, AMPLIFIER_SEQ_RANGE, IMPLANT_SEQ_RANGE } from './constants/special-seq.constant';

/** #转秒：原版易语言时间常数，1秒 = 1000 毫秒 */
const SECOND_MS = 1000;

/**
 * 增益/标记条目格式归一化（兼容层）
 *
 * 项目历史原因存在两套写入约定：
 *  - combat-state 内部约定（原版对齐）：中文 key { 名称, 强度, 有效期至 }，有效期至=毫秒
 *  - 运行时 game 逻辑层约定：英文 key { name, value, expireAt }，expireAt=秒级时间戳
 * 两套格式并存导致 buffRequire/timeIntervalRequire/markerRequire 读不到运行时写入的增益。
 *
 * 本函数将任意格式条目原地归一化为「中文 key + 毫秒」，保证两层数据互相可读，
 * 存量数据（无论哪种格式）都能被战斗状态机正确识别。幂等（中文/毫秒再归一化不变）。
 *
 * @param it 原始条目（可能含中/英 key、秒/毫秒时间）
 * @returns 归一化后的 BuffItem
 */
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
   * 增益/标记条目格式归一化（兼容层，非原版逻辑）
   *
   * 项目历史原因存在两套写入约定：
   *  - combat-state 内部约定（原版对齐）：中文 key { 名称, 强度, 有效期至 }，有效期至=毫秒
   *  - 运行时 game 逻辑层约定：英文 key { name, value, expireAt }，expireAt=秒级时间戳
   * 两套格式并存导致 buffRequire/timeIntervalRequire/markerRequire 读不到运行时写入的增益。
   *
   * 本函数将任意格式条目归一化为「中文 key + 毫秒」，保证两层数据互相可读，
   * 存量数据（无论哪种格式）都能被战斗状态机正确识别。幂等（中文/毫秒再归一化不变）。
   *
   * @param it 原始条目（可能含中/英 key、秒/毫秒时间）
   * @returns 归一化后的 BuffItem
   */
  normalizeBuffItem(it: any): BuffItem {
    if (!it) return { 名称: '', 有效期至: 0 };
    const name = it.名称 ?? it.name ?? '';
    // 时间：优先中文 有效期至，否则英文 expireAt；<1e12 视为秒，否则毫秒
    const rawTime = it.有效期至 ?? it.expireAt ?? 0;
    const expireMs = rawTime > 0 && rawTime < 1e12 ? rawTime * SECOND_MS : rawTime;
    const strength = it.强度 ?? it.value ?? it.strength ?? 0;
    return { 名称: name, 强度: strength, 有效期至: expireMs };
  }

  /**
   * 成就容器归一化（兼容层，非原版逻辑）
   *
   * 本框架将玩家成就熟练度统一存于 Player.markers（JSON 对象 {"成就名": 数值}），
   * 而原版/战斗状态机内部使用「技能」数组 [{名称, 数值}]。
   * 调用方两种格式都可能传入，先统一识别，避免对对象/字符串做 for...of
   * 抛出「成就 is not iterable」导致整个指令失败。
   *
   * @param 成就 成就数组 / markers 标记对象 / JSON 字符串
   * @returns 数组形式或对象形式（二者只会有一个）
   */
  private normalizeAchievementContainer(
    成就: AchievementItem[] | Record<string, number> | string | null | undefined,
  ): { array: AchievementItem[]; record: Record<string, number> } {
    let container: any = 成就;
    if (typeof container === 'string') {
      try {
        container = JSON.parse(container);
      } catch {
        container = null;
      }
    }
    if (Array.isArray(container)) {
      return { array: container as AchievementItem[], record: {} };
    }
    if (container && typeof container === 'object') {
      return { array: [], record: container as Record<string, number> };
    }
    return { array: [], record: {} };
  }

  /**
   * 添加成就（数据分析.ecode L678）
   * 不保存负数：若遍历到同名项且最终值 ≤0 则删除；未遍历到且值为负直接返回。
   * 同时会扣减任务要求中同名的数值（本复刻暂不接入任务系统，任务参数为可选）。
   *
   * 支持「技能」数组和 markers 标记对象两种容器（见 normalizeAchievementContainer）。
   *
   * @param 名称 成就/熟练度名称
   * @param 数值 增减量
   * @param 成就 成就数组或标记对象（会被原地修改）
   */
  addAchievement(名称: string, 数值: number, 成就: AchievementItem[] | Record<string, number>): void {
    名称 = (名称 || '').replace(/\s+/g, ''); // 删全部空
    const { array, record } = this.normalizeAchievementContainer(成就);
    // markers 对象形式：键值累加
    if (!Array.isArray(成就)) {
      if (record[名称] !== undefined) {
        record[名称] = (Number(record[名称]) || 0) + 数值;
        // 不保存负数：值 ≤0 删除该项
        if (record[名称] <= 0) {
          delete record[名称];
        }
        return;
      }
      // 未遍历到对应名称，且提供的是负数 → 直接返回（不新增负项）
      if (数值 <= 0) return;
      record[名称] = 数值;
      return;
    }
    // 先遍历已有同名项累加
    for (let i = array.length - 1; i >= 0; i--) {
      if (array[i].名称 === 名称) {
        array[i].数值 = array[i].数值 + 数值;
        // 不保存负数：值 ≤0 删除该项
        if (array[i].数值 <= 0) {
          array.splice(i, 1);
        }
        return;
      }
    }
    // 未遍历到对应名称，且提供的是负数 → 直接返回（不新增负项）
    if (数值 <= 0) return;
    // 新增成就项
    array.push({ 名称, 数值 });
  }

  /**
   * 取成就熟练度（数据分析.ecode L719）
   * 支持精确匹配 / 模糊匹配（名称包含检索词）/ 取全部匹配之和。
   *
   * 支持「技能」数组和 markers 标记对象两种容器（见 normalizeAchievementContainer）。
   *
   * @param 成就 成就数组或 markers 标记对象
   * @param 名称 检索名称
   * @param 模糊匹配 是否模糊匹配
   * @param 取全部匹配 模糊匹配时是否累加全部匹配项
   * @returns 熟练度数值
   */
  getAchievementProficiency(
    成就: AchievementItem[] | Record<string, number> | string | null | undefined,
    名称: string,
    模糊匹配?: boolean,
    取全部匹配?: boolean,
  ): number {
    let a1 = 0;
    const { array, record } = this.normalizeAchievementContainer(成就);
    // markers 对象形式：按键取值
    if (!Array.isArray(成就)) {
      if (!模糊匹配) {
        return Number(record[名称]) || 0;
      }
      for (const [key, value] of Object.entries(record)) {
        if (key.indexOf(名称) !== -1) {
          if (取全部匹配) {
            a1 = a1 + (Number(value) || 0);
          } else {
            return Number(value) || 0;
          }
        }
      }
      return a1;
    }
    for (const item of array) {
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
   * 支持「技能」数组和 markers 标记对象两种容器（见 normalizeAchievementContainer）。
   *
   * @param 名称 名称
   * @param 成就 成就数组或 markers 标记对象（原地修改）
   * @param 熟练度 目标数值
   */
  setAchievementProficiency(
    名称: string,
    成就: AchievementItem[] | Record<string, number>,
    熟练度: number,
  ): void {
    const { array, record } = this.normalizeAchievementContainer(成就);
    // markers 对象形式：键值覆盖/删除
    if (!Array.isArray(成就)) {
      if (熟练度 !== 0) {
        record[名称] = 熟练度;
      } else {
        delete record[名称];
      }
      return;
    }
    for (let i = array.length - 1; i >= 0; i--) {
      if (array[i].名称 === 名称) {
        if (熟练度 !== 0) {
          array[i].数值 = 熟练度;
        } else {
          array.splice(i, 1);
        }
        return;
      }
    }
    // 不存在且熟练度非0 → 新增
    if (熟练度 !== 0) {
      array.push({ 名称, 数值: 熟练度 });
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
    // 兼容层：先归一化数组（中/英文 key、秒/毫秒时间统一为 中文key+毫秒），保证存量数据可读
    const arr: BuffItem[] = 标记数组.map((it) => this.normalizeBuffItem(it));
    标记数组.length = 0;
    标记数组.push(...arr);
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
    // 兼容层：先归一化数组（中/英文 key、秒/毫秒时间统一为 中文key+毫秒），保证存量数据可读
    const arr: BuffItem[] = 增益.map((it) => this.normalizeBuffItem(it));
    增益.length = 0;
    增益.push(...arr);
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
   * 获得增益2（加成计算.ecode L664-L681）
   * 战斗中获得 buff：同名直接替换，并按防御方韧性折算持续时间；否则新增。
   * @param 增益 增益数组（原地修改）
   * @param 增益定义 完整增益对象
   * @param s 当前毫秒时间戳
   * @param 韧性 防御方韧性百分比
   */
  gainBuff2(
    增益: BuffItem[],
    增益定义: Omit<BuffItem, '有效期至'> & { 持续时间?: number },
    s: number,
    韧性 = 0,
  ): void {
    const durationSeconds = this.safeNumber(增益定义.持续时间);
    const expireAt = s + (1 - this.safeNumber(韧性) / 100) * durationSeconds * SECOND_MS;
    const existingIndex = 增益.findIndex((item) => item?.名称 === 增益定义.名称);
    if (existingIndex >= 0) {
      增益[existingIndex] = { ...增益定义, 有效期至: expireAt };
      return;
    }
    增益.push({ ...增益定义, 有效期至: expireAt });
  }

  private safeNumber(value: any): number {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
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

  /**
   * 套装判断（物品操作.ecode L1581）
   * 根据装备的 特殊序号 或 名称，累加 套装 各字段计数。
   * 与原版一致：第一段按 specialSeq switch；第二段按名称前缀（取文本左边 N 字）判断。
   *
   * @param 套装 SetData（原地修改：累加对应计数）
   * @param 名称 装备名称
   * @param 特殊序号 装备特殊序号（0 表示按名称判断）
   * @param 耐久 装备耐久（仅法宝资源类使用；对应原版 数据分析.ecode L922 陪睡=法宝耐久/等级）
   */
  setJudgment(套装: SetData, 名称: string, 特殊序号: number, 耐久?: number): void {
    // ===== 第一段：按特殊序号判断（原版 L1588-1667）=====
    if (特殊序号 !== 0) {
      switch (特殊序号) {
        case SEQ.植入体强攻: 套装.implant = 1; return;
        case SEQ.植入体雷霆: 套装.implant = 2; return;
        case SEQ.植入体烈火: 套装.implant = 3; return;
        case SEQ.植入体冰结: 套装.implant = 4; return;
        case SEQ.增幅器侵彻: 套装.amplifier = 5; return;
        case SEQ.增幅器速射: 套装.amplifier = 1; return;
        case SEQ.增幅器敏锐: 套装.amplifier = 2; return;
        case SEQ.增幅器神枪: 套装.amplifier = 3; return;
        case SEQ.增幅器坚毅: 套装.amplifier = 4; return;
        case SEQ.纳米套装: 套装.nanoSuit = (套装.nanoSuit || 0) + 1; return;
        case SEQ.科学家套装: 套装.scientist = (套装.scientist || 0) + 1; return;
        case SEQ.纯白婚纱套装: 套装.whiteWedding = (套装.whiteWedding || 0) + 1; return;
        case SEQ.白色丝袜: 套装.scientist = (套装.scientist || 0) + 1; return;
        case SEQ.黑婚纱套装: 套装.blackWedding = (套装.blackWedding || 0) + 1; return;
        case SEQ.一拳套装: 套装.onePunch = (套装.onePunch || 0) + 1; return;
        case SEQ.女仆套装: 套装.maid = (套装.maid || 0) + 1; return;
        case SEQ.生命套装: 套装.lifeBless = (套装.lifeBless || 0) + 1; return;
        case SEQ.皇冠套装: 套装.crown = (套装.crown || 0) + 1; return;
        case SEQ.动力套装:
          套装.power = (套装.power || 0) + 1;
          if (套装.power > 5) 套装.power = 5; // 原版 L1627-1629 封顶5
          return;
        case SEQ.游侠套装: 套装.wanderer = (套装.wanderer || 0) + 1; return;
        case SEQ.游骑兵套装: 套装.ranger = (套装.ranger || 0) + 1; return;
        case SEQ.防爆套装: 套装.antiExplosion = (套装.antiExplosion || 0) + 1; return;
        case SEQ.无畏套装: 套装.fearless = (套装.fearless || 0) + 1; return;
        case SEQ.强袭套装: 套装.assault = (套装.assault || 0) + 1; return;
        case SEQ.圣诞套装: 套装.christmas = (套装.christmas || 0) + 1; return;
        case SEQ.动能线圈: 套装.coil = 1; return;
        case SEQ.热能线圈: 套装.coil = 2; return;
        case SEQ.极寒线圈: 套装.coil = 3; return;
        case SEQ.磁暴线圈: 套装.coil = 4; return;
        case SEQ.黑手套:
          套装.blackWedding = (套装.blackWedding || 0) + 1;
          套装.eveningGown = (套装.eveningGown || 0) + 1;
          return;
        case SEQ.黑色裤袜:
          套装.blackWedding = (套装.blackWedding || 0) + 1;
          套装.eveningGown = (套装.eveningGown || 0) + 1;
          return;
        case SEQ.蝴蝶晚礼服: 套装.eveningGown = (套装.eveningGown || 0) + 1; return;
        case SEQ.心形贴: 套装.reverseBunny = (套装.reverseBunny || 0) + 1; return;
        case SEQ.创可贴: 套装.reverseBunny = (套装.reverseBunny || 0) + 1; return;
        case SEQ.逆兔女郎: 套装.reverseBunny = (套装.reverseBunny || 0) + 1; return;
        default: break; // 特殊序号未命中 → 不返回，继续第二段按名称判定（对齐原版未命中分支）
      }
    }

    // ===== 第二段：按名称判断（原版 L1669-1782，特殊序号==0 或 默认分支）=====
    const w1 = (名称 || '').substring(0, 4); // 取文本左边(名称,4)
    const w2 = (名称 || '').substring(0, 2); // 取文本左边(名称,2)
    if (名称 === '植入体-强攻') 套装.implant = 1;
    else if (名称 === '植入体-烈火') 套装.implant = 2;
    else if (名称 === '植入体-冰结') 套装.implant = 3;
    else if (名称 === '植入体-雷霆') 套装.implant = 4;
    else if (名称 === '增幅器-侵彻') 套装.amplifier = 5;
    else if (名称 === '增幅器-速射') 套装.amplifier = 1;
    else if (名称 === '增幅器-敏锐') 套装.amplifier = 2;
    else if (名称 === '增幅器-神枪') 套装.amplifier = 3;
    else if (名称 === '增幅器-坚毅') 套装.amplifier = 4;
    // 纳米系列（原版 L1690-1705：左边4字=="纳米" 且为特定部件）
    else if (w1 === '纳米') {
      if (['纳米裤子', '纳米手套', '纳米装甲', '纳米头盔', '纳米臂甲', '纳米鞋'].includes(名称)) {
        套装.nanoSuit = (套装.nanoSuit || 0) + 1;
      }
    }
    // 科学家（左边2字=="科学"）
    else if (w2 === '科学') 套装.scientist = (套装.scientist || 0) + 1;
    // 白
    else if (w2 === '白') {
      if (名称 === '白色裤袜') 套装.whiteWedding = (套装.whiteWedding || 0) + 1;
      else if (名称 === '白色丝袜') 套装.scientist = (套装.scientist || 0) + 1;
    }
    // 纯白
    else if (w1 === '纯白') {
      if (['纯白头纱', '纯白婚纱', '纯白手套'].includes(名称)) {
        套装.whiteWedding = (套装.whiteWedding || 0) + 1;
      }
    }
    // 黑
    else if (w2 === '黑') {
      if (['黑头纱', '黑婚纱', '黑手套', '黑色裤袜'].includes(名称)) {
        套装.blackWedding = (套装.blackWedding || 0) + 1;
      }
    }
    // 一拳（原版 取文本左边(名称,2)=="一拳"，"一拳套装"左边2字即"一拳"）
    else if (w2 === '一拳') 套装.onePunch = (套装.onePunch || 0) + 1;
    // 女仆
    else if (w2 === '女仆') 套装.maid = (套装.maid || 0) + 1;
    // 生命（且名称 != "生命祝福"，原版 L1746-1749）
    else if (w2 === '生命') {
      if (名称 !== '生命祝福') 套装.lifeBless = (套装.lifeBless || 0) + 1;
    }
    // 皇冠 / 长筒靴 / 蕾丝边腿环
    else if (名称 === '皇冠' || 名称 === '长筒靴' || 名称 === '蕾丝边腿环') {
      套装.crown = (套装.crown || 0) + 1;
    }
    // 动力（封顶5）
    else if (w2 === '动力') {
      套装.power = (套装.power || 0) + 1;
      if (套装.power > 5) 套装.power = 5;
    }
    // 游侠
    else if (w2 === '游侠') 套装.wanderer = (套装.wanderer || 0) + 1;
    // 游骑
    else if (w2 === '游骑') 套装.ranger = (套装.ranger || 0) + 1;
    // 防爆（且名称 != "防爆盾"）
    else if (w2 === '防爆') {
      if (名称 !== '防爆盾') 套装.antiExplosion = (套装.antiExplosion || 0) + 1;
    }
    // 无畏
    else if (w2 === '无畏') 套装.fearless = (套装.fearless || 0) + 1;
    // 强袭
    else if (w2 === '强袭') 套装.assault = (套装.assault || 0) + 1;
    // 圣诞
    else if (w2 === '圣诞') 套装.christmas = (套装.christmas || 0) + 1;

    // ===== 法宝（资源类装备）判定（对应原版 数据分析.ecode L907-923）=====
    // 原版扫描 装备预设[2] 的"资源"类型装备，按名称设置 套装.小樱命中次数(=法宝类型常量) 与 套装.陪睡(=耐久/法宝等级)。
    // 本框架把"资源"类法宝单独传入（recomputeSets 扫描预设2），名称命中即写入；陪睡=耐久值。
    else if (名称 === '惊鲵') 套装.sakuraHits = 4;
    else if (名称 === '凌虚') 套装.sakuraHits = 3;
    else if (名称 === '镇岳') 套装.sakuraHits = 2;
    else if (名称 === '飞天独龙神女枪') 套装.sakuraHits = 1;
    else if (名称 === '含光') 套装.sakuraHits = 5;
    // 法宝等级（陪睡）= 耐久，命中上述任一名称时写入
    if (套装.sakuraHits && 套装.sakuraHits > 0 && 套装.sakuraHits < 5 && 耐久 !== undefined) {
      // 原版 L921：小樱命中次数!=0 时 陪睡=耐久
      套装.sleepover = 耐久;
    }
    // 注意：原版 L1778 默认分支为空，此处不处理其他名称
  }

  /**
   * 装备要求（物品操作.ecode L1512）
   * 判断玩家是否装备了指定特殊序号或名称的装备（或手持对应武器）。
   *
   * @param 装备列表 玩家已装备列表，每项 { 名称, 特殊序号 }
   * @param 武器列表 玩家武器列表，每项 { 名称, 特殊序号 }（当前武器索引 = 当前武器）
   * @param 当前武器 当前手持武器下标（0 表示拳头/无武器）
   * @param 特殊序号 检索的特殊序号（0 表示按名称）
   * @param 名称 检索的名称
   * @param 是否武器 是否检索武器（真=检查当前手持武器；假=检查装备列表）
   * @returns 是否装备/手持
   */
  equipRequire(
    装备列表: Array<{ 名称: string; 特殊序号?: number }>,
    武器列表: Array<{ 名称: string; 特殊序号?: number }>,
    当前武器: number,
    特殊序号: number,
    名称?: string,
    是否武器?: boolean,
  ): boolean {
    if (是否武器) {
      // 第一段：武器检索（原版 L1519-1535）
      if (当前武器 === 0) return false;
      const cur = 武器列表[当前武器 - 1] || 武器列表[当前武器]; // 易语言数组从1开始
      if (!cur) return false;
      if (特殊序号 !== 0) {
        return cur.特殊序号 === 特殊序号;
      }
      return cur.名称 === 名称;
    }
    // 第二段：装备检索（原版 L1537-1579）
    if (特殊序号 !== 0) {
      for (const eq of 装备列表) {
        if (特殊序号 === eq.特殊序号) return true;
        // 增幅器范围 71-75（原版 L1542-1543）
        if (特殊序号 === SEQ.增幅器 &&
          eq.特殊序号! >= AMPLIFIER_SEQ_RANGE[0] && eq.特殊序号! <= AMPLIFIER_SEQ_RANGE[1]) return true;
        // 植入体范围 76-79（原版 L1547-1548）
        if (特殊序号 === SEQ.植入体 &&
          eq.特殊序号! >= IMPLANT_SEQ_RANGE[0] && eq.特殊序号! <= IMPLANT_SEQ_RANGE[1]) return true;
      }
      return false;
    }
    // 按名称检索（原版 L1557-1576）
    for (const eq of 装备列表) {
      if (名称 === '增幅器') {
        if ((eq.名称 || '').substring(0, 6) === '增幅器') return true;
      } else if (名称 === '植入体') {
        if ((eq.名称 || '').substring(0, 6) === '植入体') return true;
      } else if (eq.名称 === 名称) {
        return true;
      }
    }
    return false;
  }
}
