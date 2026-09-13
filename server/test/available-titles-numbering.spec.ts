/**
 * 「查看可领取称号」编号快速领取
 *
 * 需求（2026-09-13）：可领取称号带编号，玩家发送编号即可快速领取。
 * 实现：仅给未领取的称号发号（已领取的不占号），并注册临时输入替换
 * `N@领取称号 称号名`（ShortcutService 对纯数字原文精确匹配，2分钟内触发一次有效）。
 */
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';

function createService(player: any, markers: Record<string, any> = {}) {
  const playerService = {
    getPlayerData: jest.fn(async () => ({ player, markers })),
    getMarkerValue: (_m: any, _key: string) => 0,
  };
  const staticData = { getAllFamiliars: jest.fn(() => []) };
  const setTempInput = jest.fn(async (_userId: number, _raw: string) => '临时输入替换已设置');
  const shortcutService = { setTempInput };
  const service = new FamiliarSystemService(
    {} as any,
    playerService as any,
    {} as any,
    staticData as any,
    {} as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    shortcutService as any,
  );
  return { service, shortcutService };
}

describe('查看可领取称号编号菜单', () => {
  it('全部可领取时从 1 开始连续编号，并注册编号→领取称号的临时输入', async () => {
    const { service, shortcutService } = createService({ titles: '[]' });

    const out = await service.viewAvailableTitles(42);

    expect(out).toContain('1、使魔新手（拥有1个使魔好感度≥25）');
    expect(out).toContain('7、资深驯兽师（拥有使魔总数≥20）');
    expect(out).toContain('发送编号即可快速领取');
    expect(shortcutService.setTempInput).toHaveBeenCalledWith(
      42,
      [
        '1@领取称号 使魔新手',
        '2@领取称号 使魔收藏家',
        '3@领取称号 使魔大师',
        '4@领取称号 挚爱之人',
        '5@领取称号 驯服者',
        '6@领取称号 百战勇士',
        '7@领取称号 资深驯兽师',
      ].join('#'),
    );
  });

  it('已领取的称号不发号不占号：编号只落在可领取项上', async () => {
    const { service, shortcutService } = createService({
      titles: [{ name: '使魔新手', equipped: false }],
    });

    const out = await service.viewAvailableTitles(42);

    // 已领取项：显示已领取状态、不带编号、不带条件
    expect(out).toContain('使魔新手\n  效果: 攻击+5 | ✅ 已领取');
    // 后续第一个可领取项仍从 1 开始
    expect(out).toContain('1、使魔收藏家（拥有3个使魔好感度≥25）');
    expect(shortcutService.setTempInput).toHaveBeenCalledWith(
      42,
      expect.stringContaining('1@领取称号 使魔收藏家'),
    );
    // 临时输入不再包含已领取项
    const registered = shortcutService.setTempInput.mock.calls[0][1] as string;
    expect(registered).not.toContain('使魔新手');
  });

  it('全部已领取时提示无可领取，不注册临时输入', async () => {
    const { service, shortcutService } = createService({
      titles: ['使魔新手', '使魔收藏家', '使魔大师', '挚爱之人', '驯服者', '百战勇士', '资深驯兽师'],
    });

    const out = await service.viewAvailableTitles(42);

    expect(out).toContain('所有称号均已领取');
    expect(shortcutService.setTempInput).not.toHaveBeenCalled();
  });
});
