/**
 * Integration 测试「经 Actor 漏斗改写玩家状态」辅助工具。
 *
 * ------------------------------------------------------------------
 * 为什么需要它
 *
 * 玩家权威状态存于 PlayerService 的 Actor cell（内存活态），生产不变量是
 * 「所有写必须经 enqueueUserWrite / savePlayer 漏斗」（见 docs/actor-runtime.md
 * §9.5、docs/player-state-architecture.md）。若测试用裸 `prisma.player.update`
 * 直写玩家行，只会改 DB、不更新内存 cell → cell 变陈旧 → 后续任一游戏指令经
 * savePlayer 邮箱路径把陈旧 cell 回写 DB，**覆盖裸直写**（这正是此前
 * integration-familiar-select / integration-openbox / integration-home-frontline
 * 三处「旧快照覆盖」型失败的根因）。
 *
 * 本工具把「读最新活态 → 按 mutator 改 → 落库」包进 enqueueUserWrite，使 DB 与
 * 活态 cell 保持一致，从源头消除陈旧覆盖。用法与既有权威模式
 * （actor-player-e2e.spec.ts 里 enqueueUserWrite + getPlayerData + savePlayer）一致。
 *
 * ------------------------------------------------------------------
 * 注意
 *  - playerData.player 是完整行（含 Json 列 accessor），mutator 里改
 *    player.markers / player.baseName / player.hp 等字段即可；
 *  - mutator 为同步函数；若需异步可在 mutator 内 await，再调用方 await 本函数。
 */
import { PlayerService } from '../src/modules/game/player.service';

/**
 * 在玩家 Actor 漏斗内改写其状态：读最新活态 → mutator 改 player 行 → 落库。
 * 等价于生产代码经漏斗写玩家的语义，避免裸 prisma 直写造成的陈旧 cell 覆盖。
 *
 * @param ps    PlayerService 实例
 * @param uid   玩家 userId
 * @param mutate 同步改写 player 行的函数（可整体替换 markers/baseName/hp 等）
 */
export async function mutatePlayerState(
  ps: PlayerService,
  uid: number,
  mutate: (player: any) => void,
): Promise<void> {
  await ps.enqueueUserWrite(uid, async () => {
    const pd = await ps.getPlayerData(uid);
    mutate(pd.player);
    await ps.savePlayer(pd.player);
  });
}
