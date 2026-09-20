import { CommandResult } from './interfaces/command.interface';
import { CARD_DIVIDER } from '../../common/utils/game-text.util';

/**
 * 指令回执构造。
 *
 * 指令结果默认都是「只回传给发送者、不广播、无耗时统计」，各处理器不再各自拼
 * { broadcast: false, durationMs: 0 } 字面量；需要广播或私密回执时显式覆盖字段。
 */

/** 成功回执：content 只回传给发送者。 */
export function okCommand(content: string): CommandResult {
  return { success: true, content, broadcast: false, durationMs: 0 };
}

/** 失败回执（未登录、参数缺失、条件不满足等）。 */
export function failCommand(content: string): CommandResult {
  return { success: false, content, broadcast: false, durationMs: 0 };
}

/** 正文与新手引导提示之间的分隔线（与指令正文同一条，见 game-text.util 的 CARD_DIVIDER）。 */
export const TUTORIAL_DIVIDER = CARD_DIVIDER;

/** 把引导提示追加到指令正文之后；无引导时原样返回正文。 */
export function appendTutorialHint(body: string, tutorialText?: string | null): string {
  return tutorialText ? `${body}\n${TUTORIAL_DIVIDER}\n💡 ${tutorialText}` : body;
}
