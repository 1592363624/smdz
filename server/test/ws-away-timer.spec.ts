/**
 * WS 在线语义回归（2026-09-06）：离开计时以 WebSocket 断开为起点、重连为终点。
 * - WS 在线时指令结算照常补偿数值，但不输出「⏰ 你离开了」横幅；
 * - force=true 跳过 10 秒防抖（断开/重连时刻的强制结算用）；
 * - showBanner=true 无视在线状态输出横幅（重连结算用）；
 * - WS 离线（QQ 端/无连接）保持原横幅行为。
 */
import { GameService } from '../src/modules/game/game.service';

function build(player: any, online: boolean) {
  const playerService: any = {
    getPlayerData: jest.fn(async () => ({ player, markers: JSON.parse(player.markers || '{}') })),
    savePlayer: jest.fn(async () => {}),
    getMarkerValue: jest.fn((markers: any, key: string) => Number(markers?.[key] ?? 0)),
  };
  const statsService: any = { isOnline: jest.fn(() => online) };
  const service = Object.create(GameService.prototype) as any;
  (service as any).playerService = playerService;
  (service as any).statsService = statsService;
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, statsService };
}

function freshPlayer(lastOpAgoMs: number) {
  return {
    lastOpTime: BigInt(Date.now() - lastOpAgoMs),
    readTime: BigInt(0),
    markers: JSON.stringify({ 活力2: 100, 使用活力: 0 }),
    markers2: '[]',
    vitality: 0,
    hp: 50, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
    regenHp: 1, regenShield: 0, regenArmor: 0,
  };
}

describe('WS 在线语义：离开计时以连接状态为准', () => {
  it('WS 在线：≥10秒的结算照常回血，但不输出离开横幅', async () => {
    const player = freshPlayer(15000);
    const { service } = build(player, true);

    const text = await service.calculateTimeElapsed(1);

    expect(text).not.toContain('你离开了');
    // 数值补偿不受影响：15 秒 × 1点/秒 = 15 点生命
    expect(player.hp).toBe(65);
    // 时间基准照常推进（推进到结算时刻附近）
    expect(Number(player.lastOpTime)).toBeGreaterThan(Date.now() - 5000);
  });

  it('WS 离线：保持原行为，输出「你离开了 N 秒」横幅', async () => {
    const player = freshPlayer(15000);
    const { service } = build(player, false);

    const text = await service.calculateTimeElapsed(1);

    expect(text).toContain('你离开了');
    expect(player.hp).toBe(65);
  });

  it('force=true：不足 10 秒也强制结算并推进时间基准（断开时刻起算的关键）', async () => {
    const player = freshPlayer(3000);
    const { service } = build(player, false);

    // 无 force：3 秒 < 10 秒防抖 → 不结算不推进
    await service.calculateTimeElapsed(1);
    expect(player.hp).toBe(50);
    expect(Number(player.lastOpTime)).toBeLessThanOrEqual(Date.now() - 2000);

    // 有 force：强制结算
    const text = await service.calculateTimeElapsed(1, { force: true });
    expect(player.hp).toBe(53);
    expect(Number(player.lastOpTime)).toBeGreaterThan(Date.now() - 5000);
    expect(text).toContain('你离开了');
  });

  it('重连结算：此刻 WS 已在线，showBanner=true 仍输出横幅供网关定向推送', async () => {
    const player = freshPlayer(60000);
    const { service, statsService } = build(player, true);

    const text = await service.calculateTimeElapsed(1, { force: true, showBanner: true });

    expect(statsService.isOnline).toHaveBeenCalled();
    expect(text).toContain('你离开了');
    expect(player.hp).toBe(100); // 60 秒 × 1 = 60，封顶 100
  });

  it('在线且只有活力提示时：保留活力提示、不带离开横幅', async () => {
    const player = freshPlayer(15000);
    player.regenHp = 0;
    player.vitality = 90; // ≥ 上限 80% → 触发活力快满提示
    const { service } = build(player, true);

    const text = await service.calculateTimeElapsed(1);

    expect(text).not.toContain('你离开了');
    expect(text).toContain('活力快满了');
  });
});
