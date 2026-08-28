import { GameService } from '../src/modules/game/game.service';
import { PlayerService } from '../src/modules/game/player.service';
import {
  expireAfter, filterActive, findActive, formatRemain, hasActive, isActive,
  isActiveBeyond, isDueSince, remainSeconds, toExpireMs,
} from '../src/modules/game/expire-time.util';

describe('过期时间统一工具（增益/标记）', () => {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  it('秒级与毫秒级到期时间都归一化为毫秒', () => {
    expect(toExpireMs({ expireAt: nowSec + 30 })).toBeGreaterThan(1e12);
    expect(toExpireMs({ 有效期至: nowMs + 30 * 1000 })).toBe(nowMs + 30 * 1000);
    expect(toExpireMs({ expireAt: 0 })).toBe(0);
    expect(toExpireMs(null)).toBe(0);
  });

  it('过期条目失效、未过期条目生效，无到期时间视为永久', () => {
    expect(isActive({ expireAt: nowSec - 1 })).toBe(false);       // 秒级已过期
    expect(isActive({ expireAt: nowSec + 10 })).toBe(true);       // 秒级未过期
    expect(isActive({ 有效期至: nowMs - 1000 })).toBe(false);      // 毫秒级已过期
    expect(isActive({ 有效期至: nowMs + 1000 })).toBe(true);       // 毫秒级未过期
    expect(isActive({ name: '常驻' })).toBe(true);
  });

  it('hasActive / findActive / filterActive 按名称与有效期筛选', () => {
    const list = [
      { name: 'ex', expireAt: nowSec - 1 },
      { name: 'ex', expireAt: nowSec + 10 },
      { 名称: '蛋糕', 有效期至: nowMs - 10 },
      { name: '永久' },
    ];
    expect(hasActive(list, 'ex')).toBe(true);
    expect(hasActive(list, '蛋糕')).toBe(false);
    expect(hasActive(list, '永久')).toBe(true);
    expect(findActive(list, 'ex')?.expireAt).toBe(nowSec + 10);
    expect(filterActive(list).length).toBe(2);
  });

  it('续期判定 isActiveBeyond 与写入 expireAfter 配套（无期限条目视为需重写）', () => {
    const expire = expireAfter(30, nowMs);
    expect(expire).toBe(nowMs + 30 * 1000);
    expect(isActiveBeyond({ expireAt: expire }, 30, nowMs)).toBe(false); // 刚好等于阈值 → 需重写
    expect(isActiveBeyond({ expireAt: expire + 1 }, 30, nowMs)).toBe(true);
    expect(isActiveBeyond({ name: '无期限' }, 30, nowMs)).toBe(false);
  });

  it('倒计时格式化：秒级/毫秒级都换算为 m:ss', () => {
    expect(remainSeconds({ expireAt: nowSec + 65 }, nowMs)).toBe(64);
    expect(formatRemain(65)).toBe('1:05');
    expect(formatRemain(-3)).toBe('0:00');
  });
});

function makePlayerService(player: any): PlayerService {
  const service: any = Object.create(PlayerService.prototype);
  service.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  service.prisma = { player: { update: jest.fn() } };
  service.getOrCreatePlayer = jest.fn(async () => player);
  service.resolveStartMap = jest.fn(async () => null);
  return service as PlayerService;
}

describe('玩家数据读取（getPlayerData）', () => {
  const nowSec = Math.floor(Date.now() / 1000);

  it('读取时剔除已过期增益，保留未过期与永久增益', async () => {
    const player = {
      id: 1,
      userId: 1,
      mapId: 1,
      location: '湖边',
      markers: JSON.stringify({}),
      markers2: '[]',
      buffs: JSON.stringify([
        { name: 'ex', expireAt: nowSec - 5 },                    // 秒级已过期
        { name: '闪避', expireAt: nowSec + 10 },                  // 秒级未过期
        { 名称: '蛋糕', 有效期至: Date.now() - 1000 },             // 毫秒级已过期
        { name: '力量模式' },                                     // 永久
      ]),
      backpack: '[]',
      equipment: '[]',
      weapons: '[]',
      tasks: '[]',
      safeBox: '[]',
    };
    const service = makePlayerService(player);
    const data = await service.getPlayerData(1);

    const names = data.buffs.map((b: any) => b.name ?? b.名称);
    expect(names).toContain('闪避');
    expect(names).toContain('力量模式');
    expect(names).not.toContain('ex');
    expect(names).not.toContain('蛋糕');
  });
});

describe('信息面板增益行（formatBuffList）', () => {
  const nowSec = Math.floor(Date.now() / 1000);

  const build = (buffs: any[]) => {
    const service: any = Object.create(GameService.prototype);
    service.playerService = { safeJsonParse: (_v: any, d: any) => d };
    return service.formatBuffList(buffs);
  };

  it('过期增益不再显示，未过期增益显示正确倒计时', () => {
    const list = build([
      { name: 'ex', expireAt: nowSec - 1 },
      { name: '闪避', expireAt: nowSec + 65 },
    ]);
    expect(list).toHaveLength(1);
    // 秒级时间戳会被 floor 到整秒，剩余时间在 1:04~1:05 之间浮动
    expect(list[0]).toMatch(/^闪避\(1:0[45]\)$/);
  });

  it('全部过期时返回空数组（面板整行省略）', () => {
    expect(build([{ name: 'ex', expireAt: nowSec - 1 }])).toHaveLength(0);
  });

  it('永久增益显示名称但不带倒计时（不显示误导性的 0:00）', () => {
    expect(build([{ name: '力量模式' }])).toEqual(['力量模式']);
  });
});

describe('触发时刻型标记判断（isDueSince，覆盖寒风/光棱/射爆等冷却）', () => {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  it('触发时刻为空或远超间隔 → 可再次触发', () => {
    expect(isDueSince(null, 180 * 1000, nowMs)).toBe(true);
    expect(isDueSince(0, 180 * 1000, nowMs)).toBe(true);
    expect(isDueSince(nowMs - 300 * 1000, 180 * 1000, nowMs)).toBe(true); // 300s 前触发，超出 180s 间隔
  });

  it('间隔内不可触发', () => {
    expect(isDueSince(nowMs - 60 * 1000, 180 * 1000, nowMs)).toBe(false); // 60s 前触发，仍在 180s 冷却
  });

  it('存量秒级触发时刻也被正确归一化（兼容性）', () => {
    // 原版秒级时间戳作为触发时刻：60s 前（秒级）仍在 180s 间隔内 → 不可触发
    expect(isDueSince(nowSec - 60, 180 * 1000, nowMs)).toBe(false);
    // 300s 前（秒级）超出 180s 间隔 → 可触发
    expect(isDueSince(nowSec - 300, 180 * 1000, nowMs)).toBe(true);
  });
});

describe('地图标记有效期归一化（toExpireMs，修复地图增益全部失效）', () => {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  it('秒级有效期至被归一成毫秒，毫秒级保持不变', () => {
    // 原版地图标记"有效期至"写秒级（加成计算.ecode L577-652 初始化）
    const secBuff = toExpireMs({ name: '湖边祝福', 有效期至: nowSec + 60 });
    expect(secBuff).toBe((nowSec + 60) * 1000); // 关键：修复前归一成秒会让 getMapBonus 判全部过期
    const msBuff = toExpireMs({ name: '湖边祝福', 有效期至: nowMs + 60 * 1000 });
    expect(msBuff).toBe(nowMs + 60 * 1000);
  });

  it('applyMapBuffs 风格数组：秒级标记归一化后不过期，未过期增益被 filterActive 保留', () => {
    const mapBuffs = [
      { name: '湖边祝福', 有效期至: nowSec + 60 }, // 秒级未过期
      { name: '过期祝福', 有效期至: nowSec - 10 }, // 秒级已过期
    ];
    const normalized = mapBuffs.map((b) => ({ ...b, expireAt: toExpireMs(b) }));
    const active = filterActive(normalized);
    expect(active.length).toBe(1);
    expect(active[0].name).toBe('湖边祝福');
    expect(active[0].expireAt).toBe((nowSec + 60) * 1000); // 毫秒，getMapBonus 据此判定生效
  });
});
