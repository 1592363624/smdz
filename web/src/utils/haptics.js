/**
 * 触感反馈（Haptics）
 *
 * 手机网页游戏「手感」里最便宜、也最容易被忽略的一项：点中按钮时震一下，
 * 玩家对界面的「实手感」会明显变强。navigator.vibrate 只在 Android Chrome /
 * WebView 生效，iOS Safari 全系不支持（调用返回 false，静默无副作用），
 * 所以这里必须做成「不支持就什么都不发生」，绝不能阻塞交互。
 *
 * 用 class 记一次开关状态，避免每个调用点都读 localStorage。
 */

const PREF_KEY = 'smdz_haptics';

/** 是否允许震动：玩家可在设置里关掉；无 vibrate 能力时直接判否 */
export function hapticsEnabled() {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  return localStorage.getItem(PREF_KEY) !== '0';
}

/** 开关触感反馈，返回开启后的状态 */
export function setHapticsEnabled(on) {
  localStorage.setItem(PREF_KEY, on ? '1' : '0');
  return hapticsEnabled();
}

/** 安全震动：吞掉所有异常与不支持 */
function buzz(pattern) {
  if (!hapticsEnabled()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* iOS 等平台不支持，忽略 */
  }
}

/** 轻点：切标签、展开面板等次要确认 */
export function tapLight() { buzz(8); }

/** 中按：主操作按钮（发送指令、确认） */
export function tapMedium() { buzz(15); }

/** 重击：战斗命中、抽卡出金 */
export function tapHeavy() { buzz([18, 30, 24]); }

/** 否定：失败、冷却中、表单校验不过 */
export function tapReject() { buzz([30, 40, 30]); }

/** 成功：领取、完成建造 */
export function tapSuccess() { buzz([10, 30, 10]); }
