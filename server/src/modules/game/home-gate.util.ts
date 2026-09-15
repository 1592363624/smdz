/**
 * 家园写操作统一门禁：必须「房子建成」（`家园进度 >= 4`）才能动家园的东西。
 *
 * 背景：原版只要求「人在自己院子」，圈完地（进度 1）就能种植/收获/安装/拆除，
 * 导致玩家在房子还没盖好时就能种地，与「家园产出结算 / 家园前线 / 屋内野战 /
 * 地牢挑战」等已有的「进度 >= 4」门禁口径不一致，也让人误以为房子已经建好了
 * （实测疑问：都能种东西了，为什么页面还显示建造进度 0/4）。
 *
 * 口径：本文件是家园写操作的**唯一门禁出口**，所有入口（种植 / 收获 / 建造 /
 * 拆除 / 拆卸 / 安装 / 安装燃料 / 安装全部 / 使用凭证）统一调用
 * `homeBuiltGateText(player, markers)`，未建成时返回带四步引导的拦截文本。
 *
 * 开关：`GlobalConfig.getInstance().home.requireBuiltForActions`
 * （环境变量 HOME_REQUIRE_BUILT=false 可回退到原版宽松行为）。
 */

import { GlobalConfig } from '../../config/global.config';
import { appendHomeBuildGuide, HOME_BUILD_TOTAL_STEP } from './home-build-guide.util';

/** 建成的进度阈值：与 home-build-guide 的总步数保持一致 */
export const HOME_BUILT_PROGRESS = HOME_BUILD_TOTAL_STEP;

/**
 * 读取家园建造进度（兼容 JSON 字符串与已解析对象两种形态）。
 *
 * @param markers 玩家 markers（对象或 JSON 字符串）
 * @returns 进度值，缺失时为 0
 */
export function getHomeProgress(markers: any): number {
  const parsed = typeof markers === 'string' ? safeParse(markers) : markers || {};
  return Number(parsed?.['家园进度'] ?? 0) || 0;
}

/**
 * 家园是否已建成（进度 >= 4）。
 *
 * @param markers 玩家 markers
 * @returns 已建成返回 true
 */
export function isHomeBuilt(markers: any): boolean {
  return getHomeProgress(markers) >= HOME_BUILT_PROGRESS;
}

/**
 * 家园写操作门禁：未建成时返回拦截文本（含四步引导），已建成或开关关闭时返回 null。
 *
 * @param player 玩家行（取 name 与 markers）
 * @returns 拦截文本；允许继续时返回 null
 */
export function homeBuiltGateText(player: any): string | null {
  if (!GlobalConfig.getInstance().home.requireBuiltForActions) return null;
  const markers = player?.markers;
  const progress = getHomeProgress(markers);
  if (progress >= HOME_BUILT_PROGRESS) return null;

  const name = String(player?.name ?? '') || '冒险者';
  // 进度 0：还没圈地；1-3：在建中——分别给出可执行的下一步
  const base = progress === 0
    ? `${name}还没有家园，先去中意的地点发送「圈地」开始建造`
    : `${name}需要先完成房屋的建造，才能进行家园操作`;
  // 进度 1-3 时附四步引导块（进度 0 时 append 内部会原样返回）
  return appendHomeBuildGuide(base, progress);
}

/** JSON 解析兜底：非法串按空对象处理，避免门禁因脏数据抛错 */
function safeParse(text: string): Record<string, any> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
