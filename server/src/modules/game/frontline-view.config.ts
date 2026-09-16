/**
 * 家园前线面板视图展示配置。
 *
 * 与装配逻辑解耦：所有"可能随运营调整"的展示阈值集中在此，
 * 调整库存展示条数等不需要改动 frontline-view.service.ts 的业务代码。
 */
export const FRONTLINE_VIEW_CONFIG = {
  /** 仓库（可安装防御建筑）返回条数上限，防止背包过大拖慢接口 */
  stockDisplayLimit: 200,
} as const;
