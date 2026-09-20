/**
 * 家园写操作统一门禁（**唯一门禁出口**）：必须「房子建成」（`家园进度 >= 4`）才能种植/收获/建造/
 * 拆除/拆卸/安装/安装燃料/使用凭证，口径与家园产出结算、家园前线、屋内野战、地牢挑战一致。
 * 开关：`GlobalConfig.getInstance().home.requireBuiltForActions`
 * （环境变量 HOME_REQUIRE_BUILT=false 可回退到原版「圈完地即可操作」的宽松行为）。
 */

import { GlobalConfig } from '../../config/global.config';
import { appendHomeBuildGuide, HOME_BUILD_TOTAL_STEP } from './home-build-guide.util';

/** 建成的进度阈值：与 home-build-guide 的总步数保持一致 */
export const HOME_BUILT_PROGRESS = HOME_BUILD_TOTAL_STEP;

/**
 * 读取家园建造进度（兼容 JSON 字符串与已解析对象两种形态），缺失时为 0。
 */
export function getHomeProgress(markers: any): number {
  const parsed = typeof markers === 'string' ? safeParse(markers) : markers || {};
  return Number(parsed?.['家园进度'] ?? 0) || 0;
}

/** 家园是否已建成（进度 >= 4）。 */
export function isHomeBuilt(markers: any): boolean {
  return getHomeProgress(markers) >= HOME_BUILT_PROGRESS;
}

/**
 * 家园写操作门禁：未建成时返回拦截文本（含四步引导），已建成或开关关闭时返回 null。
 */
export function homeBuiltGateText(player: any): string | null {
  if (!GlobalConfig.getInstance().home.requireBuiltForActions) return null;
  const markers = player?.markers;
  const progress = getHomeProgress(markers);
  if (progress >= HOME_BUILT_PROGRESS) return null;

  const name = String(player?.name ?? '') || '冒险者';
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
