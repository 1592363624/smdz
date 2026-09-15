/**
 * 家园院子（QQ 农场式格子视图）展示配置。
 *
 * 与装配逻辑解耦：所有"可能随运营调整"的展示阈值/解锁口径集中在此，
 * 调整地块预览数量、解锁步长时不需要改动 home-yard.service.ts 的业务代码。
 */
export const HOME_YARD_CONFIG = {
  /** 已解锁区域之外额外渲染的「待开垦」地块数量（让玩家看到下一档解锁目标） */
  lockedPreviewPlots: 6,
  /** 农田地块升级步长：每 N 级开垦 1 格（对齐原版 cropLimit = ceil(等级/5) + 凭证×5） */
  cropLevelStep: 5,
  /** 建筑地块升级步长：每 N 级开垦 1 格（对齐原版 buildingLimit = ceil(等级/20) + 凭证 + 2） */
  buildingLevelStep: 20,
  /** 建筑地块基础赠送数量（原版 +2） */
  buildingBaseBonus: 2,
  /** 存放地（产出堆）展示条数上限，超出由前端折叠 */
  storageDisplayLimit: 80,
  /** 单个地块上展示的产出条目上限（避免产出列表把格子撑爆） */
  outputsPerPlot: 3,
  /** 仓库单类（种子/建筑）返回条数上限，防止背包过大拖慢接口 */
  stockDisplayLimit: 200,
} as const;
