import {
  POOL_ZERO_FLOOR,
  capPoolValue,
  normalizePoolValue,
  normalizePools,
  resolvePoolDamage,
  round2,
  subtractPoolValue,
} from '../src/modules/game/player-pool.util';

/**
 * 三池数值出口归一化（第四道闸）回归测试。
 *
 * 事故原型（2026-09-10 测试库「路人乙」）：
 *   三池停在 hp=0.01999999999999602 / shield=0.0799999999999983 / armor=0.0799999999999983，
 *   面板 Math.round 显示 0，但 `isPlayerDead → hp <= 0` 判为存活；同时战斗扣血端把
 *   「已按残池截断的伤害」再 Math.round 一次抹成 0 —— 残血玩家既不死也打不掉。
 *
 * 本文件固化两条不变量：
 *   1. 任何三池写入出口都不得留下 <0.01 的残值（存库即脏数据）；
 *   2. 已分配到该池的正伤害不得被取整抹成 0（否则形成无敌死锁）。
 */
describe('三池数值出口归一化（第四道闸）', () => {
  describe('normalizePoolValue', () => {
    it('把浮点残值归零（路人乙 hp 实测值）', () => {
      expect(normalizePoolValue(0.01999999999999602)).toBe(0);
      expect(normalizePoolValue(0.0799999999999983)).toBe(0);
    });

    it('保留两位小数以内的正常值', () => {
      expect(normalizePoolValue(72)).toBe(72);
      expect(normalizePoolValue(0.72)).toBe(0.72);
      expect(normalizePoolValue(7.198)).toBe(7.2);
    });

    it('负数、NaN、undefined 一律归零', () => {
      expect(normalizePoolValue(-3)).toBe(0);
      expect(normalizePoolValue(Number.NaN)).toBe(0);
      expect(normalizePoolValue(undefined)).toBe(0);
      expect(normalizePoolValue(null)).toBe(0);
    });

    it('归零地板与面板显示口径一致：显示 0 的值存下来就是 0', () => {
      // 面板对三池取 Math.round 显示：0.49 显示 0、0.5 显示 1
      expect(Math.round(0.49)).toBe(0);
      expect(normalizePoolValue(0.49)).toBe(0);
      // round2 会先收敛到两位：0.494 → 0.49（显示 0）→ 归零
      expect(normalizePoolValue(0.494)).toBe(0);
      expect(normalizePoolValue(POOL_ZERO_FLOOR)).toBe(POOL_ZERO_FLOOR);
    });
  });

  describe('resolvePoolDamage（战斗扣血出口）', () => {
    it('残池不足 1 点时，任何正伤害都清空该池（破死锁核心）', () => {
      // 原实现 Math.round(0.08) = 0 → 扣 0 → 永远打不掉
      expect(Math.round(0.08)).toBe(0); // 记录旧行为
      expect(resolvePoolDamage(2, 0.08)).toBe(0.08);
      expect(resolvePoolDamage(0.08, 0.08)).toBe(0.08);
      expect(resolvePoolDamage(0.02, 0.01999999999999602)).toBeGreaterThan(0);
    });

    it('扣光后写回为 0（死亡判定得以闭合）', () => {
      const hp = 0.01999999999999602;
      const dmg = resolvePoolDamage(30, hp);
      expect(subtractPoolValue(hp, dmg)).toBe(0);
    });

    it('伤害 >= 当前池值时破池（扣光）', () => {
      expect(resolvePoolDamage(50, 42)).toBe(42);
      expect(resolvePoolDamage(42, 42)).toBe(42);
    });

    it('伤害不足 1 点且残池 >= 1 时不扣（保持原版「造成 0」语义）', () => {
      expect(resolvePoolDamage(0.02, 42)).toBe(0);
    });

    it('无伤害/无池值返回 0', () => {
      expect(resolvePoolDamage(0, 42)).toBe(0);
      expect(resolvePoolDamage(-5, 42)).toBe(0);
      expect(resolvePoolDamage(10, 0)).toBe(0);
    });

    it('常规伤害按整数结算，与旧 Math.round 口径一致', () => {
      expect(resolvePoolDamage(10.4, 42)).toBe(10);
      expect(resolvePoolDamage(10.6, 42)).toBe(11);
    });
  });

  describe('capPoolValue（封顶/回复出口）', () => {
    it('超过上限时封顶', () => {
      expect(capPoolValue(100, 72)).toBe(72);
    });

    it('cap <= 0 视为未启用，仅归一化不封顶', () => {
      expect(capPoolValue(42, 0)).toBe(42);
      expect(capPoolValue(42, Number.NaN)).toBe(42);
    });

    it('回复后不产生浮点尾', () => {
      // 71.98 × 0.1 回复的安全收敛
      expect(capPoolValue(0.0799999999999983 + 7.198, 72)).toBe(7.28);
    });
  });

  describe('normalizePools（落库兜底闸）', () => {
    it('就地收敛对象三池并上报变更', () => {
      const player: any = { hp: 0.01999999999999602, shield: 0.0799999999999983, armor: 52 };
      expect(normalizePools(player)).toBe(true);
      expect(player.hp).toBe(0);
      expect(player.shield).toBe(0);
      expect(player.armor).toBe(52);
    });

    it('已是干净值时不修改', () => {
      const player: any = { hp: 72, shield: 42, armor: 52 };
      expect(normalizePools(player)).toBe(false);
    });

    it('非对象或空值不抛错', () => {
      expect(normalizePools(null)).toBe(false);
      expect(normalizePools(undefined)).toBe(false);
      expect(() => normalizePools({ name: 'x' } as any)).not.toThrow();
    });
  });

  describe('round2（项目统一两位小数口径）', () => {
    it('四舍五入到两位（浮点尾收敛）', () => {
      expect(round2(103.32000000000001)).toBe(103.32);
      expect(round2(0.125)).toBe(0.13);
      expect(round2(7.198)).toBe(7.2);
    });

    it('非有限值归零', () => {
      expect(round2(Number.NaN)).toBe(0);
      expect(round2(Number.POSITIVE_INFINITY)).toBe(0);
    });
  });
});
