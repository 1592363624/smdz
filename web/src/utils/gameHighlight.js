/**
 * 游戏高光时刻（Game Highlight）
 *
 * 作用：把「任务达成 / 领取新任务 / 获得称号 / 等级提升」这类里程碑
 * 从纯文本公屏流里拎出来，交给 GameHighlight.vue 播放屏幕级动画。
 *
 * 数据来源有两条，前端二者并用、互为兜底：
 *   1. 结构化事件 —— 后端 GameHighlightService 定向推送 game:highlight
 *      （task.service / achievement.service / player.service 已埋点）
 *   2. 文本兜底  —— 解析公屏文本（本文件 parseHighlights），覆盖尚未埋点
 *      的历史路径与 AstrBot 等非 Socket 渠道回传的内容
 */

/** Socket 事件名（与后端 GAME_HIGHLIGHT_EVENT 保持一致） */
export const GAME_HIGHLIGHT_EVENT = 'game:highlight';

/**
 * 各类型的展示元数据
 * icon/label 为默认文案，后端下发的 title 会覆盖 label
 */
export const HIGHLIGHT_META = {
  'task-complete': { icon: '🏆', label: '任务达成' },
  'task-accept': { icon: '📜', label: '新任务' },
  title: { icon: '👑', label: '称号解锁' },
  'level-up': { icon: '⭐', label: '等级提升' },
};

/** 兜底文案：后端没给 title 时用元数据里的 label */
export function highlightMeta(type) {
  return HIGHLIGHT_META[type] || { icon: '✨', label: '高光时刻' };
}

/**
 * 解析一段公屏文本里包含的高光时刻
 * 支持的文本形态（均取自后端实际输出）：
 *   完成了任务:A、B，得到了:奖励1、奖励2     → task-complete
 *   并领取了新的任务:X、Y                    → task-accept
 *   接受了任务X                              → task-accept
 *   恭喜你获得了称号「X」！                   → title
 *   ⭐ 等级提升了！Lv.3 → Lv.4                → level-up
 *
 * @param {string} text 公屏消息正文（可含换行）
 * @returns {Array<{type:string,title?:string,detail?:string,names?:string[],rewards?:string[]}>}
 */
export function parseHighlights(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];

  // ① 完成任务 + 奖励
  // "完成了任务:教程-移动，得到了:优秀装备补给箱x1.03"
  const doneRe = /完成了任务[:：]([^\n]+)/g;
  let m;
  while ((m = doneRe.exec(text)) !== null) {
    const rest = m[1].trim();
    const gotMatch = rest.match(/[，,]\s*得到了[:：](.+)$/);
    let names = rest;
    let rewards = [];
    if (gotMatch) {
      names = rest.slice(0, gotMatch.index);
      rewards = gotMatch[1]
        .split('、')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const nameList = names
      .split('、')
      // 无奖励时后端输出形如「完成了任务:教程-苏醒，」，需剥掉残留的结尾标点
      .map((s) => s.trim().replace(/[，,。.;；]+$/, '').trim())
      .filter(Boolean);
    if (nameList.length === 0) continue;
    out.push({
      type: 'task-complete',
      title: nameList.length > 1 ? `任务达成 ×${nameList.length}` : '任务达成',
      names: nameList,
      rewards,
    });
  }

  // ② 自动领取的后续任务
  const chainRe = /并领取了新的任务[:：]([^\n]+)/g;
  while ((m = chainRe.exec(text)) !== null) {
    const nameList = m[1]
      .split('、')
      .map((s) => s.trim().replace(/[，,。.;；]+$/, '').trim())
      .filter(Boolean);
    if (nameList.length === 0) continue;
    out.push({ type: 'task-accept', title: '新任务', names: nameList });
  }

  // ③ NPC 处手动接任务（未命中 ② 时才补，避免同一次结算重复弹）
  if (!/并领取了新的任务[:：]/.test(text)) {
    const acceptRe = /接受了任务([^\n]+)/g;
    while ((m = acceptRe.exec(text)) !== null) {
      const name = m[1].trim();
      if (!name) continue;
      out.push({ type: 'task-accept', title: '新任务', names: [name] });
    }
  }

  // ④ 获得称号（使魔称号的「恭喜你获得了称号「X」！」）
  const titleRe = /恭喜你获得了称号[「『【]([^」』】]+)[」』】]/g;
  while ((m = titleRe.exec(text)) !== null) {
    const name = m[1].trim();
    if (!name) continue;
    out.push({ type: 'title', title: '称号解锁', names: [name] });
  }

  // ⑤ 等级提升
  const lvRe = /等级提升了[！!]\s*(Lv\.\s*\d+\s*(?:→|->|～|~)\s*Lv\.\s*\d+)/g;
  while ((m = lvRe.exec(text)) !== null) {
    out.push({ type: 'level-up', title: '等级提升', detail: m[1].replace(/\s+/g, ' ').trim() });
  }

  return out;
}
