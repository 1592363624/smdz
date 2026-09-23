/**
 * 家园前线面板视图展示配置：所有"可能随运营调整"的展示阈值集中在此，
 * 与 frontline-view.service 的装配逻辑解耦。
 */
export const FRONTLINE_VIEW_CONFIG = {
  /** 仓库（可安装防御建筑）返回条数上限，防止背包过大拖慢接口 */
  stockDisplayLimit: 200,
  /** 「开始战斗」后地图「活动」标记的存活秒数（原版 _主程序.ecode L2168） */
  activitySeconds: 120,
} as const;

/**
 * 地精系列 → 载具残骸掉落系数（原版 战斗相关.ecode L4947-4985 掉落残骸）。
 * 同时也是「参与前线结算的怪物白名单」：不在表里的怪物不涨前线熟练度。
 */
export const FRONTLINE_WRECKAGE_RATIO: Record<string, number> = {
  地精: 1,
  地精十夫长: 1.5,
  地精百夫长: 2,
  地精千夫长: 2.5,
  地精将军: 3,
};

/**
 * 按前线等级生成本波地精构成（原版 _主程序.ecode L2085-2162 的分支表）。
 *
 * 「开始战斗」和「前线面板预测下一波」必须用同一张表：过去波次分支只写在
 * dungeon-challenge 里，面板无法告诉玩家"再打几级会多出什么敌人"，
 * 两处一旦漂移就会出现「面板说的和实际来的不一样」。
 */
export function buildFrontlineWave(frontlineLevel: number): string[] {
  const level = Math.max(0, Math.trunc(Number(frontlineLevel) || 0));
  const wave = ['地精', '地精'];
  if (level >= 15 && level < 40) {
    wave.push('地精十夫长');
  } else if (level >= 40 && level < 60) {
    wave.push('地精十夫长', '地精百夫长');
  } else if (level >= 60) {
    wave.push('地精十夫长', '地精百夫长', '地精千夫长');
    if (level >= 80) wave.push('地精将军');
  }
  return wave;
}
