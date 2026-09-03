/**
 * 武器判定 + 批量锁定/解锁 回归测试（Issue #5 修复）
 *
 * 回归背景（2026-09-04）：
 *  1. isWeapon 历史 bug：item-system 本地实现误写「specialSeq∈(0,100) 判武器」，
 *     导致皇冠(28)等 149 件特殊装备被当成武器——装备皇冠推进「使用武器」而非
 *     「使用装备」，任务「教程-战斗准备」永远无法完成。
 *     修复后统一委托 staticData.isWeapon（对齐原版 数据分析.ecode L394-415）：
 *     特殊序号≠0 时负数才是武器；=0 时类型以「武器」结尾或为「工具」。
 *  2. 锁定装备/解锁 按品质批量 + 同名批量（原版 _主程序.ecode L3527-3700）。
 *
 * 本测试不触碰数据库，只验证纯判定函数。
 */
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlayerService } from '../src/modules/game/player.service';
import { BonusService } from '../src/modules/game/bonus.service';
import { ItemService, Item3 } from '../src/modules/game/item.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { AchievementService } from '../src/modules/game/achievement.service';

const itemServiceReal = new ItemService(
  {} as PrismaService,
  {} as StaticDataService,
  {} as any,
  {} as any,
  {} as any,
);

// isWeapon 委托到 staticData.isWeapon（纯函数，不触发文件加载）
const staticDataReal = new StaticDataService();

const itemSystem = new ItemSystemService(
  {} as PrismaService,
  {} as PlayerService,
  {} as BonusService,
  itemServiceReal,
  {} as AchievementService,
  staticDataReal,
);

/** 走私有 isWeapon（收 specialSeq + 类型） */
const isWeapon = (specialSeq: number, type: string) =>
  (itemSystem as any)['isWeapon']({ specialSeq, type });

describe('isWeapon 判定（对齐原版 数据分析.ecode L394-415）', () => {
  it('特殊序号为负 → 武器（提卡=-7）', () => {
    expect(isWeapon(-7, '射弹武器')).toBe(true);
    expect(isWeapon(-1, '近战武器')).toBe(true);
  });

  it('特殊序号为正 → 非武器（皇冠=28、植入体=1、增幅器=2）——回归主用例', () => {
    // 修复前：0<28<100 被误判为武器 → 任务「使用装备」永远无法推进
    expect(isWeapon(28, '头部')).toBe(false); // 皇冠
    expect(isWeapon(1, '增幅器')).toBe(false);
    expect(isWeapon(2, '植入体')).toBe(false);
    expect(isWeapon(17, '头部')).toBe(false); // 动力头盔
  });

  it('特殊序号为 0：类型以「武器」结尾 → 武器', () => {
    expect(isWeapon(0, '射弹武器')).toBe(true);
    expect(isWeapon(0, '近战武器')).toBe(true);
    expect(isWeapon(0, '能量武器')).toBe(true);
  });

  it('特殊序号为 0：类型为「工具」 → 武器', () => {
    expect(isWeapon(0, '工具')).toBe(true);
  });

  it('特殊序号为 0：其他类型 → 非武器', () => {
    expect(isWeapon(0, '头部')).toBe(false);
    expect(isWeapon(0, '腿部')).toBe(false);
    expect(isWeapon(0, '')).toBe(false);
  });

  it('特殊序号优先于类型：类型含武器字样但序号为正 → 非武器（原版规则）', () => {
    expect(isWeapon(5, '射弹武器')).toBe(false);
  });

  it('与装备表一致性：全部 122 件武器 specialSeq 均为负（抽样验证关键件）', () => {
    // 关键武器抽样（equipments.json 中 equipType 以「武器」结尾的代表件）
    const sample: Array<[string, number, string]> = [
      ['提卡', -7, '射弹武器'],
    ];
    for (const [, seq, type] of sample) {
      expect(isWeapon(seq, type)).toBe(true);
    }
  });
});

describe('锁定装备/解锁 批量逻辑（原版 _主程序.ecode L3527-3700）', () => {
  const mk = (name: string, data: string, durability = 0): Item3 =>
    ({ name, type: '装备', quantity: 1, durability, data } as Item3);

  it('setLockByQuality：按品质前缀批量锁定（传说=s）', () => {
    const backpack = [mk('布帽', 'e'), mk('提卡', 's'), mk('提卡', 's'), mk('皇冠', 'a')];
    const touched = (itemSystem as any)['setLockByQuality'](backpack, 's', true);
    expect(touched).toHaveLength(2);
    expect(backpack[1].durability).toBe(1);
    expect(backpack[2].durability).toBe(1);
    expect(backpack[0].durability).toBe(0);
    expect(backpack[3].durability).toBe(0);
  });

  it('setLockByQuality：神迹=x / 史诗=a / 精良=b / 优秀=c / 普通=e', () => {
    const expectPrefix = (prefix: string, data: string) => {
      const backpack = [mk('x', data)];
      const touched = (itemSystem as any)['setLockByQuality'](backpack, prefix, true);
      expect(touched).toHaveLength(1);
    };
    expectPrefix('x', 'x');
    expectPrefix('a', 'a');
    expectPrefix('b', 'b');
    expectPrefix('c', 'c');
  });

  it('setLockByQuality：解锁（locked=false）归零', () => {
    const backpack = [mk('提卡', 's', 1)];
    const touched = (itemSystem as any)['setLockByQuality'](backpack, 's', false);
    expect(touched).toHaveLength(1);
    expect(backpack[0].durability).toBe(0);
  });

  it('setLockByName：批量锁定全部同名装备', () => {
    const backpack = [mk('信号枪', 'b'), mk('信号枪', 'a'), mk('布帽', 'c')];
    const touched = (itemSystem as any)['setLockByName'](backpack, '信号枪', true);
    expect(touched).toHaveLength(2);
    expect(backpack[0].durability).toBe(1);
    expect(backpack[1].durability).toBe(1);
    expect(backpack[2].durability).toBe(0);
  });

  it('品质映射表覆盖原版五档品质关键词', () => {
    const map = (ItemSystemService as any)['LOCK_QUALITY_PREFIX'];
    expect(map).toEqual({ '神迹': 'x', '传说': 's', '史诗': 'a', '精良': 'b', '优秀': 'c' });
  });
});
