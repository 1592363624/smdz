/**
 * 家园前线面板视图展示配置：所有"可能随运营调整"的展示阈值集中在此，
 * 与 frontline-view.service 的装配逻辑解耦。
 */
export const FRONTLINE_VIEW_CONFIG = {
  /** 仓库（可安装防御建筑）返回条数上限，防止背包过大拖慢接口 */
  stockDisplayLimit: 200,
} as const;
