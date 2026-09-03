/**
 * 切换武器 参数解析 + 索引口径 回归测试
 * 对应原版：_主程序.ecode L4303-4432 切换武器()
 *
 * 重点回归（2026-09-03 修复的两个历史 bug）：
 *   1. 索引错位：weapons 数组是 0-based，而 currentWeapon 是 1-based（0=拳头）。
 *      旧实现用 weapons[currentWeapon] 取武器，导致"回显第 n+1 把、生效第 n 把"。
 *   2. 解析兜底：旧实现 parseInt(param, 10) || 1，非数字参数一律兜底成 1，
 *      按名字切换从未生效，无参数也不会列清单。
 *
 * 本测试直接验证纯解析函数 resolveWeaponSwitchIntent，不触碰数据库。
 */
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlayerService } from '../src/modules/game/player.service';
import { BonusService } from '../src/modules/game/bonus.service';
import { ItemService } from '../src/modules/game/item.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { AchievementService } from '../src/modules/game/achievement.service';

const itemServiceReal = new ItemService(
  {} as PrismaService,
  {} as StaticDataService,
  {} as any,
  {} as any,
  {} as any,
);

const itemSystem = new ItemSystemService(
  {} as PrismaService,
  {} as PlayerService,
  {} as BonusService,
  itemServiceReal,
  {} as AchievementService,
  {} as StaticDataService,
);

/** 走私有纯函数解析参数意图 */
const resolve = (raw: string, weapons: any[]) =>
  (itemSystem as any)['resolveWeaponSwitchIntent'](raw, weapons);

// 典型场景：先装备提卡（在手，currentWeapon=1），再装备纵横（背上，索引1）
const weapons = [
  { name: '提卡', data: 's', type: '射弹武器' },
  { name: '纵横', data: 'a', type: '射弹武器' },
];

describe('切换武器 参数解析（原版 _主程序.ecode L4303-4432）', () => {
  it('无参数 → 列清单', () => {
    expect(resolve('', weapons)).toEqual({ kind: 'list' });
  });

  it('纯数字在 1..n 内 → 按编号切换（1-based）', () => {
    expect(resolve('1', weapons)).toEqual({ kind: 'switch', target: 1 });
    expect(resolve('2', weapons)).toEqual({ kind: 'switch', target: 2 });
  });

  it('数字 0 → 切换为拳头', () => {
    expect(resolve('0', weapons)).toEqual({ kind: 'switch', target: 0 });
  });

  it('数字越界 → 列清单（原版 L4372 分支）', () => {
    expect(resolve('3', weapons)).toEqual({ kind: 'list' });
    expect(resolve('99', weapons)).toEqual({ kind: 'list' });
  });

  it('按武器名切换：命中对应编号（修复前会退化成 target=1）', () => {
    expect(resolve('纵横', weapons)).toEqual({ kind: 'switch', target: 2 });
    expect(resolve('提卡', weapons)).toEqual({ kind: 'switch', target: 1 });
  });

  it('"拳头" → 切回空手（target=0），即便武器列表中没有名为拳头的条目', () => {
    expect(resolve('拳头', weapons)).toEqual({ kind: 'switch', target: 0 });
  });

  it('未装备的武器名 → notFound，回显玩家原输入', () => {
    expect(resolve('高斯步枪', weapons)).toEqual({ kind: 'notFound', name: '高斯步枪' });
  });

  it('无武器时任何输入都只列清单或提示未装备，不会越界', () => {
    expect(resolve('', [])).toEqual({ kind: 'list' });
    expect(resolve('1', [])).toEqual({ kind: 'list' });
    expect(resolve('纵横', [])).toEqual({ kind: 'notFound', name: '纵横' });
  });
});

describe('切换武器 同名武器口径', () => {
  // 两把同名武器 + 一把其它，验证"按名字只命中第一把"与"按编号可精确指定"
  const dup = [
    { name: '提卡', data: 's' },
    { name: '提卡', data: 'a' },
    { name: '纵横', data: 'b' },
  ];

  it('同名武器按名字切换只命中第一把', () => {
    expect(resolve('提卡', dup)).toEqual({ kind: 'switch', target: 1 });
  });

  it('同名武器可用编号精确指定第二把（名字之外的唯一手段）', () => {
    expect(resolve('2', dup)).toEqual({ kind: 'switch', target: 2 });
    expect(resolve('3', dup)).toEqual({ kind: 'switch', target: 3 });
  });

  it('含数字的武器名走全名精确匹配（原版"去数字"会失配，此处额外兜底）', () => {
    const guns = [{ name: 'M16', data: 'b' }, { name: 'AK47', data: 'c' }];
    expect(resolve('M16', guns)).toEqual({ kind: 'switch', target: 1 });
    expect(resolve('AK47', guns)).toEqual({ kind: 'switch', target: 2 });
  });

  it('武器名带尾部数字时仍能命中（去数字口径）', () => {
    const guns = [{ name: '高斯步枪', data: 'b' }];
    expect(resolve('高斯步枪2', guns)).toEqual({ kind: 'switch', target: 1 });
  });
});

describe('切换武器 武器冷却（同名共用一份）', () => {
  const nowMs = 1_700_000_000_000;
  const withCooldown = (name: string, leftSec: number) => [
    { name, expireAt: nowMs + leftSec * 1000 },
  ];

  it('冷却按「武器名+冷却」读取，同名武器共用同一份冷却', () => {
    const left = (itemSystem as any)['weaponCooldownLeft'](
      withCooldown('提卡冷却', 30),
      '提卡',
      nowMs,
    );
    expect(left).toBe(30);
    // 第二把同名武器读到的是同一条标记
    const dupName = (itemSystem as any)['weaponCooldownLeft'](
      withCooldown('提卡冷却', 30),
      '提卡',
      nowMs,
    );
    expect(dupName).toBe(30);
  });

  it('已过期的冷却标记视为就绪', () => {
    const left = (itemSystem as any)['weaponCooldownLeft'](
      [{ name: '提卡冷却', expireAt: nowMs - 1000 }],
      '提卡',
      nowMs,
    );
    expect(left).toBe(0);
  });

  it('兼容秒级存量时间戳（expireAt 小于 1e12 时按秒解释）', () => {
    const left = (itemSystem as any)['weaponCooldownLeft'](
      [{ name: '提卡冷却', expireAt: nowMs / 1000 + 45 }],
      '提卡',
      nowMs,
    );
    expect(left).toBe(45);
  });
});

describe('切换武器 清单渲染', () => {
  it('清单列出当前武器 + 0拳头 + 编号，并对重名提示共用冷却', () => {
    const text = (itemSystem as any)['weaponSwitchList'](
      { name: '露子' },
      [
        { name: '提卡', data: 's' },
        { name: '提卡', data: 'a' },
        { name: '纵横', data: 'e' },
      ],
      [],
    );
    expect(text).toContain('选择你要切换的武器');
    expect(text).toContain('0、拳头');
    expect(text).toContain('1、提卡[传说]');
    expect(text).toContain('2、提卡[史诗]');
    expect(text).toContain('3、纵横'); // 普通品质不显示中括号
    expect(text).toContain('同名武器共用同一份攻击冷却');
  });

  it('冷却中的武器在清单里显示剩余时间而非品质', () => {
    const nowMs = Date.now();
    const text = (itemSystem as any)['weaponSwitchList'](
      { name: '露子' },
      [{ name: '提卡', data: 's' }],
      [{ name: '提卡冷却', expireAt: nowMs + 95_000 }],
    );
    expect(text).toContain('1、提卡[1分35秒]');
  });

  it('没有武器时提示未装备任何武器', () => {
    const text = (itemSystem as any)['weaponSwitchList']({ name: '露子' }, [], []);
    expect(text).toBe('露子你还没有任何武器');
  });
});
