/**
 * 快捷输入服务
 * 对应原版易语言：快捷输入.ecode
 * 提供快捷键、输入替换、临时输入替换等功能，在玩家发送消息时自动替换文本
 *
 * 存储方式：
 * - 快捷键和输入替换持久化存储在 Player 的 markers 字段中（key: "shortcuts"）
 * - 临时输入替换仅保存在内存中，不持久化（2分钟有效，触发一次后清空）
 */

import { Injectable, Logger } from '@nestjs/common';
import { PlayerService } from './player.service';

/**
 * 快捷键/输入替换项
 * original: 原文本（快捷键完全匹配，输入替换左边匹配）
 * target: 替换后的目标文本
 */
interface ShortcutKey {
  original: string;
  target: string;
}

/**
 * 临时输入替换项
 * 设置后2分钟内有效，触发一次后自动清空
 */
interface TempInput {
  original: string;
  target: string;
}

/**
 * 快捷数据持久化结构（存入 markers["shortcuts"]）
 */
interface ShortcutPersistData {
  shortcuts: ShortcutKey[];         // 快捷键（完全匹配）
  inputReplacements: ShortcutKey[];  // 输入替换（左边匹配）
}

/**
 * 快捷输入数据（含运行时状态）
 */
interface ShortcutData {
  playerId: number;
  shortcuts: ShortcutKey[];
  inputReplacements: ShortcutKey[];
  tempInputs: TempInput[];     // 临时输入替换（仅内存，不持久化）
  tempTime: number;            // 临时输入设置时间戳（毫秒）
}

@Injectable()
export class ShortcutService {
  private readonly logger = new Logger(ShortcutService.name);

  /** 临时输入替换的过期时间（秒） */
  private readonly TEMP_EXPIRY_SECONDS = 120;

  /** 内存缓存：playerId -> ShortcutData（含临时输入状态） */
  private readonly cache: Map<number, ShortcutData> = new Map();

  constructor(private readonly playerService: PlayerService) {}

  /**
   * 快捷输入处理（核心函数）
   * 按照优先级顺序处理文本替换：临时输入替换 > 快捷键 > 输入替换
   * @param content 原始输入文本
   * @param userId 玩家用户ID
   * @returns 处理后的文本
   */
  async processShortcut(content: string, userId: number): Promise<string> {
    const data = await this.loadShortcuts(userId);
    let result = content;

    // ========== 第一优先级：临时输入替换 ==========
    // 临时输入替换 2分钟内有效，且触发一次后清空
    const now = Date.now();
    const tempElapsed = (now - data.tempTime) / 1000;
    if (data.tempInputs.length > 0 && tempElapsed <= this.TEMP_EXPIRY_SECONDS) {
      for (const temp of data.tempInputs) {
        // 左边匹配：检查输入文本是否以原文本开头
        if (result.startsWith(temp.original)) {
          // 替换左边匹配的第一个原文本为目标文本
          result = result.replace(temp.original, temp.target);
          // 临时输入替换触发一次后清空所有临时输入
          data.tempInputs = [];
          this.cache.set(userId, data);
          return result;
        }
      }
    }

    // ========== 第二优先级：快捷键（完全匹配才触发） ==========
    for (const shortcut of data.shortcuts) {
      if (result === shortcut.original) {
        result = shortcut.target;
        this.cache.set(userId, data);
        return result;
      }
    }

    // ========== 第三优先级：输入替换（左边匹配） ==========
    for (const replacement of data.inputReplacements) {
      if (result.startsWith(replacement.original)) {
        result = result.replace(replacement.original, replacement.target);
        this.cache.set(userId, data);
        return result;
      }
    }

    return result;
  }

  /**
   * 读取玩家的快捷输入数据
   * 从 Player 的 markers 字段中读取持久化的快捷键和输入替换，
   * 并与内存中的临时输入状态合并
   * @param userId 玩家用户ID
   * @returns 完整的快捷输入数据对象
   */
  async loadShortcuts(userId: number): Promise<ShortcutData> {
    // 先检查内存缓存中是否有完整数据（含临时输入状态）
    const cached = this.cache.get(userId);
    if (cached) {
      return cached;
    }

    // 从数据库读取持久化数据
    const playerData = await this.playerService.getPlayerData(userId);
    const markers = playerData.markers;
    const persistData: ShortcutPersistData = markers['shortcuts'] || { shortcuts: [], inputReplacements: [] };

    // 构建完整数据对象（临时输入初始为空）
    const data: ShortcutData = {
      playerId: playerData.player.id,
      shortcuts: persistData.shortcuts || [],
      inputReplacements: persistData.inputReplacements || [],
      tempInputs: [],
      tempTime: 0,
    };

    this.cache.set(userId, data);
    return data;
  }

  /**
   * 保存快捷输入数据到数据库
   * 仅持久化快捷键和输入替换（临时输入不保存）
   * @param userId 玩家用户ID
   */
  async saveShortcuts(userId: number): Promise<void> {
    const data = await this.loadShortcuts(userId);
    const playerData = await this.playerService.getPlayerData(userId);
    const markers = playerData.markers;

    // 构造持久化数据（仅保存快捷键和输入替换）
    markers['shortcuts'] = {
      shortcuts: data.shortcuts,
      inputReplacements: data.inputReplacements,
    };

    // 保存到数据库
    await this.playerService.savePlayer({ id: playerData.player.id, markers });
    this.logger.log(`玩家 ${userId} 的快捷输入已保存`);
  }

  /**
   * 设置临时输入替换
   * 格式：原文本@目标文本#原文本2@目标文本2
   * 例如 "a@b#c@d" 表示 a→b 和 c→d
   * @param userId 玩家用户ID
   * @param raw 原始输入字符串（多组用#分隔，每组用@分隔原文本和目标文本）
   * @returns 设置结果的描述文本
   */
  async setTempInput(userId: number, raw: string): Promise<string> {
    const data = await this.loadShortcuts(userId);
    const groups = raw.split('#');
    const tempInputs: TempInput[] = [];
    const displayLines: string[] = [];

    for (const group of groups) {
      if (!group) continue;
      const parts = group.split('@');
      if (parts.length === 2) {
        const original = parts[0];
        const target = parts[1];
        tempInputs.push({ original, target });
        displayLines.push(`${original} → ${target}`);
      }
    }

    if (tempInputs.length === 0) {
      return '临时输入替换格式错误，正确格式：原文本@目标文本#原文本2@目标文本2';
    }

    // 更新内存中的临时输入和时间戳
    data.tempInputs = tempInputs;
    data.tempTime = Date.now();
    this.cache.set(userId, data);

    return `临时输入替换已设置（2分钟内有效，触发一次后清空）：\n${displayLines.join('\n')}`;
  }

  /**
   * 添加快捷键
   * 快捷键需要完全匹配原文本才会触发替换
   * @param userId 玩家用户ID
   * @param original 原文本
   * @param target 目标文本
   * @returns 操作结果描述
   */
  async addShortcut(userId: number, original: string, target: string): Promise<string> {
    if (!original || !target) {
      return '添加快捷键失败：原文本和目标文本不能为空';
    }

    const data = await this.loadShortcuts(userId);

    // 检查是否已存在相同的原文本
    const existing = data.shortcuts.findIndex(s => s.original === original);
    if (existing !== -1) {
      // 覆盖已有快捷键
      data.shortcuts[existing].target = target;
    } else {
      data.shortcuts.push({ original, target });
    }

    await this.saveShortcuts(userId);
    this.cache.set(userId, data);
    return `快捷键已添加：${original} → ${target}`;
  }

  /**
   * 删除快捷键
   * @param userId 玩家用户ID
   * @param original 要删除的快捷键原文本
   * @returns 操作结果描述
   */
  async removeShortcut(userId: number, original: string): Promise<string> {
    if (!original) {
      return '删除快捷键失败：原文本不能为空';
    }

    const data = await this.loadShortcuts(userId);
    const index = data.shortcuts.findIndex(s => s.original === original);

    if (index === -1) {
      return `未找到快捷键「${original}」`;
    }

    data.shortcuts.splice(index, 1);
    await this.saveShortcuts(userId);
    this.cache.set(userId, data);
    return `快捷键已删除：${original}`;
  }

  /**
   * 添加输入替换
   * 输入替换是左边匹配，只要输入文本以原文本开头即触发替换
   * @param userId 玩家用户ID
   * @param original 原文本
   * @param target 目标文本
   * @returns 操作结果描述
   */
  async addInputReplacement(userId: number, original: string, target: string): Promise<string> {
    if (!original || !target) {
      return '添加输入替换失败：原文本和目标文本不能为空';
    }

    const data = await this.loadShortcuts(userId);

    // 检查是否已存在相同的原文本
    const existing = data.inputReplacements.findIndex(r => r.original === original);
    if (existing !== -1) {
      data.inputReplacements[existing].target = target;
    } else {
      data.inputReplacements.push({ original, target });
    }

    await this.saveShortcuts(userId);
    this.cache.set(userId, data);
    return `输入替换已添加：${original} → ${target}`;
  }

  /**
   * 删除输入替换
   * @param userId 玩家用户ID
   * @param original 要删除的输入替换原文本
   * @returns 操作结果描述
   */
  async removeInputReplacement(userId: number, original: string): Promise<string> {
    if (!original) {
      return '删除输入替换失败：原文本不能为空';
    }

    const data = await this.loadShortcuts(userId);
    const index = data.inputReplacements.findIndex(r => r.original === original);

    if (index === -1) {
      return `未找到输入替换「${original}」`;
    }

    data.inputReplacements.splice(index, 1);
    await this.saveShortcuts(userId);
    this.cache.set(userId, data);
    return `输入替换已删除：${original}`;
  }

  /**
   * 查看当前玩家的所有快捷输入设置
   * @param userId 玩家用户ID
   * @returns 格式化的快捷输入列表文本
   */
  async viewShortcuts(userId: number): Promise<string> {
    const data = await this.loadShortcuts(userId);
    const lines: string[] = [];

    lines.push('╔══════════════ 快捷输入 ═══════════════');

    // 快捷键列表
    lines.push('║ 【快捷键】（完全匹配）');
    if (data.shortcuts.length === 0) {
      lines.push('║   暂无快捷键');
    } else {
      for (const s of data.shortcuts) {
        lines.push(`║   ${s.original} → ${s.target}`);
      }
    }

    // 输入替换列表
    lines.push('║ 【输入替换】（左边匹配）');
    if (data.inputReplacements.length === 0) {
      lines.push('║   暂无输入替换');
    } else {
      for (const r of data.inputReplacements) {
        lines.push(`║   ${r.original} → ${r.target}`);
      }
    }

    // 临时输入替换（仅显示有效期内）
    const now = Date.now();
    const tempElapsed = (now - data.tempTime) / 1000;
    lines.push('║ 【临时输入替换】（2分钟有效）');
    if (data.tempInputs.length > 0 && tempElapsed <= this.TEMP_EXPIRY_SECONDS) {
      for (const t of data.tempInputs) {
        lines.push(`║   ${t.original} → ${t.target}`);
      }
    } else {
      lines.push('║   暂无临时输入替换');
    }

    lines.push('╚═══════════════════════════════════════');
    return lines.join('\n');
  }

  /**
   * 处理快捷指令子命令
   * 统一入口，根据子命令分发到对应的操作
   * @param userId 玩家用户ID
   * @param subCmd 子命令（查看/添加/删除/临时/输入替换/删除输入替换）
   * @param subArgs 子命令参数
   * @returns 操作结果文本
   */
  async handleShortcutCmd(userId: number, subCmd: string, subArgs: string): Promise<string> {
    switch (subCmd) {
      case '查看':
      case 'view':
      case 'list':
        return this.viewShortcuts(userId);

      case '添加':
      case 'add': {
        // 格式：添加 原文本 目标文本
        const parts = subArgs.split(/\s+/);
        const original = parts[0] || '';
        const target = parts.slice(1).join(' ') || '';
        return this.addShortcut(userId, original, target);
      }

      case '删除':
      case 'del':
      case 'remove': {
        // 格式：删除 原文本
        const original = subArgs.trim();
        return this.removeShortcut(userId, original);
      }

      case '临时':
      case 'temp': {
        // 格式：临时 原文本@目标文本#原文本2@目标文本2
        return this.setTempInput(userId, subArgs);
      }

      case '输入替换':
      case 'input-replace':
      case 'ireplace': {
        // 格式：输入替换 原文本 目标文本
        const parts = subArgs.split(/\s+/);
        const original = parts[0] || '';
        const target = parts.slice(1).join(' ') || '';
        return this.addInputReplacement(userId, original, target);
      }

      case '删除输入替换':
      case 'del-input-replace':
      case 'dreplace': {
        // 格式：删除输入替换 原文本
        const original = subArgs.trim();
        return this.removeInputReplacement(userId, original);
      }

      default:
        return '快捷指令子命令错误。可用子命令：\n' +
          '  快捷 查看              - 查看当前快捷输入列表\n' +
          '  快捷 添加 原文本 目标文本  - 添加快捷键\n' +
          '  快捷 删除 原文本         - 删除快捷键\n' +
          '  快捷 临时 原@目标#原2@目标2 - 设置临时输入替换\n' +
          '  快捷 输入替换 原文本 目标文本   - 添加输入替换\n' +
          '  快捷 删除输入替换 原文本   - 删除输入替换';
    }
  }
}