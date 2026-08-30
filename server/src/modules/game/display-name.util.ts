/**
 * 玩家显示名派生（对应原版 加成计算.ecode _计算玩家 L1616-1623）：
 *   名称 = 图片(baseName) + [佩戴称号]（titles 中 equipped 的条目）
 *   全空时回退 玩家.类型（使魔名）。
 *
 * 字段语义与原版的对应关系：
 *   - baseName 列 = 原版 玩家.图片（改名基础名）：「选择使魔」时赋初值
 *     （原版 _主程序.ecode L701 图片=类型），仅「命名使魔」可修改；
 *   - name 列    = 原版 玩家.名称（派生显示名）：持久化的就是派生结果，
 *     所有指令回复/战斗文本/面板直接读 name 即与原版一致。
 *
 * 幂等约束：只从 baseName 派生、绝不从 name 反推，否则佩戴称号后每次
 * 保存都会叠加一层后缀（白[新人][新人]…）。读路径（getPlayerData）与
 * 写路径（savePlayer）都调用本函数刷新 name。
 *
 * titles 兼容两种历史形状：字符串（旧 checkTitles 自动发放）/ {name, equipped}
 * （领取称号/佩戴称号），字符串视为已拥有但未佩戴。
 */
export function deriveDisplayName(player: any): string {
  if (!player || typeof player !== 'object') return '';
  let name = String(player.baseName ?? '');
  let titles: any = player.titles;
  if (typeof titles === 'string') {
    try {
      titles = JSON.parse(titles);
    } catch {
      titles = [];
    }
  }
  if (Array.isArray(titles)) {
    const worn = titles.find((t: any) => t && typeof t === 'object' && t.equipped && t.name);
    if (worn) name += `[${worn.name}]`;
  }
  if (!name) name = String(player.type ?? '');
  return name;
}
