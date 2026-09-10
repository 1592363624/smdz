import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { MapService } from '../src/modules/game/map.service';

/**
 * 玩家死亡复活级联（原版 战斗相关.ecode L5173-5227）。
 *
 * `PlayerService.resolvePlayerDeath` 是唯一实现：指令/技能门禁 `deathGateText`
 * 与 `CombatSystemService.playerDeath` 都走它。本套件锁定四条判定：
 *   卷土重来免死 → 军姬(存活宠物+sf 60s) → 死亡行者(装备16, 90s) → 石中剑(武器-35, 90s) → 真死
 * 并锁定「冷却标记必须是毫秒口径」这一踩坑点（秒刻度会让冷却被放大 1000 倍）。
 */
function makeService() {
  const service: any = new PlayerService(
    {} as PrismaService, {} as StaticDataService, {} as MapService,
  );
  service.savePlayer = jest.fn(async () => undefined);
  return service as PlayerService & { savePlayer: jest.Mock };
}

const deadPlayer = (over: any = {}) => ({
  userId: 42,
  name: '测试者',
  hp: 0,
  maxHp: 100,
  markers2: [],
  weapons: [],
  equipment: [],
  buffs: [],
  额外文本: '',
  ...over,
});

describe('玩家死亡复活级联（原版 战斗相关.ecode L5173-5227）', () => {
  it('当前生命>0 → 不死', () => {
    const svc = makeService();
    const p = deadPlayer({ hp: 50 });
    const r = svc.resolvePlayerDeath(p);
    expect(r.dead).toBe(false);
    expect(r.reviveText).toBe('');
  });

  it('卷土重来 → 免死放行（原版 返回假）', () => {
    const svc = makeService();
    const p = deadPlayer({ buffs: [{ name: '卷土重来', expireAt: Date.now() + 30_000 }] });
    const r = svc.resolvePlayerDeath(p);
    expect(r.dead).toBe(false);
    expect(r.reviveText).toContain('卷土重来');
  });

  it('死亡行者(装备 16) 冷却就绪 → 半血复活 + 写 90 秒冷却（毫秒口径）', () => {
    const svc = makeService();
    const now = Date.now();
    const p = deadPlayer({ equipment: [{ name: '死亡行者', specialSeq: 16 }] });
    const r = svc.resolvePlayerDeath(p);
    expect(r.dead).toBe(false);
    expect(p.hp).toBe(50);
    const cd = (p.markers2 as any[]).find((m) => m.name === '死亡行者');
    expect(cd).toBeDefined();
    // 必须是毫秒（≈ now+90s），写成秒刻度会被读取侧 ×1000 放大成 90000 秒
    expect(cd!.expireAt).toBeGreaterThan(now + 89_000);
    expect(cd!.expireAt).toBeLessThan(now + 91_000);
  });

  it('石中剑是武器(特殊序号 -35)，存于 weapons 也判定生效（原版 装备要求(...,真)）', () => {
    const svc = makeService();
    const p = deadPlayer({ weapons: [{ name: '石中剑', specialSeq: -35 }] });
    const r = svc.resolvePlayerDeath(p);
    expect(r.dead).toBe(false);
    expect(p.hp).toBe(50);
    expect((p.markers2 as any[]).some((m) => m.name === '石中剑')).toBe(true);
  });

  it('持有死亡行者但冷却中 → 直接真死，不再尝试石中剑（原版短路返回）', () => {
    const svc = makeService();
    const p = deadPlayer({
      equipment: [{ name: '死亡行者', specialSeq: 16 }],
      weapons: [{ name: '石中剑', specialSeq: -35 }],
      markers2: [{ name: '死亡行者', expireAt: Date.now() + 30_000 }],
    });
    const r = svc.resolvePlayerDeath(p);
    expect(r.dead).toBe(true);
    expect(r.deathText).toContain('已经死掉了');
    expect((p.markers2 as any[]).some((m) => m.name === '石中剑')).toBe(false);
  });

  it('军姬 + 本图存活宠物 + sf 冷却就绪 → 森罗万象复活', () => {
    const svc = makeService();
    const p = deadPlayer({ specialSeq: 16, type: '军姬', qqNumber: 'q1' });
    const r = svc.resolvePlayerDeath(p, {
      map: { summons: [{ userId: 'q1', hp: 10 }] },
    });
    expect(r.dead).toBe(false);
    expect(r.reviveText).toContain('森罗万象');
    expect(p.hp).toBe(50);
  });

  it('军姬但无存活宠物 → 不复活（继续往下判 → 真死）', () => {
    const svc = makeService();
    const p = deadPlayer({ specialSeq: 16, type: '军姬', qqNumber: 'q1' });
    const r = svc.resolvePlayerDeath(p, { map: { summons: [{ userId: 'q1', hp: 0 }] } });
    expect(r.dead).toBe(true);
  });

  it('无任何豁免条件 → 真死文案（原版 L5224-5226）', () => {
    const svc = makeService();
    const p = deadPlayer();
    const r = svc.resolvePlayerDeath(p);
    expect(r.dead).toBe(true);
    expect(r.deathText).toBe('测试者已经死掉了!你可以"复活使魔"或者"删除怪物"');
    expect(p.hp).toBe(0);
  });
});

describe('deathGateText：门禁放行/拦截 与复活落库', () => {
  it('未死 → null（不落库）', async () => {
    const svc = makeService();
    const p = deadPlayer({ hp: 80 });
    await expect(svc.deathGateText(p)).resolves.toBeNull();
    expect(svc.savePlayer).not.toHaveBeenCalled();
  });

  it('复活成功 → null 放行，且补一次落库', async () => {
    const svc = makeService();
    const p = deadPlayer({ equipment: [{ name: '死亡行者', specialSeq: 16 }] });
    await expect(svc.deathGateText(p)).resolves.toBeNull();
    expect(p.hp).toBe(50);
    expect(svc.savePlayer).toHaveBeenCalledTimes(1);
  });

  it('真死 → 返回死亡文案，hp 不动', async () => {
    const svc = makeService();
    const p = deadPlayer();
    await expect(svc.deathGateText(p)).resolves.toContain('已经死掉了');
    expect(p.hp).toBe(0);
    expect(svc.savePlayer).not.toHaveBeenCalled();
  });

  it('半血基数优先用「计算上限」（原版 玩家.属性.生命），而非基础列 maxHp', async () => {
    const svc = makeService();
    // 注入战斗系统（生产经 COMBAT_SYSTEM_SERVICE token 别名）：
    // 装备/套装把计算上限抬到 818，基础上限 maxHp 仍是 100
    (svc as any).combatSystem = { buildAttackerBonus: () => ({ 生命: 818, 护盾: 120, 装甲: 90 }) };
    const p = deadPlayer({ equipment: [{ name: '死亡行者', specialSeq: 16 }], maxHp: 100 });
    await expect(svc.deathGateText(p)).resolves.toBeNull();
    expect(p.hp).toBe(409);
  });

  it('战斗系统不可用（存量测试桩）→ 退回基础上限 maxHp，行为不劣化', async () => {
    const svc = makeService();
    const p = deadPlayer({ equipment: [{ name: '死亡行者', specialSeq: 16 }] });
    await expect(svc.deathGateText(p)).resolves.toBeNull();
    expect(p.hp).toBe(50);
  });

  it('卷土重来 → null 放行（原版 返回假，指令继续执行）', async () => {
    const svc = makeService();
    const p = deadPlayer({ buffs: [{ name: '卷土重来', expireAt: Date.now() + 30_000 }] });
    await expect(svc.deathGateText(p)).resolves.toBeNull();
  });
});
