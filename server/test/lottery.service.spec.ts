/**
 * 每日抽奖服务单元测试（奖池构建 / 数量摇取 / 配置解析，不碰数据库）
 */
import { LotteryService } from '../src/modules/game/lottery.service';

describe('LotteryService 奖池', () => {
  const staticData = {
    getAllItems: () => [
      { name: '木头', value: 1 },
      { name: '铁矿', value: 2 },
      { name: '物品模板', value: 1 },
      { name: '凭证', value: 1 },
    ],
    getAllWeapons: () => [
      { name: '高斯步枪', equipType: '射弹武器', specialSeq: -1 },
      { name: '武器模板', equipType: '射弹武器', specialSeq: -1 },
      { name: '空手', equipType: '近战武器', specialSeq: -1 },
      { name: '高斯步枪', equipType: '射弹武器', specialSeq: -1 }, // 重复
    ],
    getItemByName: (name: string) =>
      ({ 木头: { name: '木头', value: 1 }, 铁矿: { name: '铁矿', value: 2 } })[name],
  };

  function makeService() {
    const svc = Object.create(LotteryService.prototype) as LotteryService;
    (svc as any).staticData = staticData;
    return svc;
  }

  it('排除模板与空手，资源与武器都进池', () => {
    const svc = makeService();
    const pool = svc.buildPool(['物品模板', '武器模板', '装备模板']);
    const names = pool.map((p) => p.name);
    expect(names).toContain('木头');
    expect(names).toContain('铁矿');
    expect(names).toContain('凭证');
    expect(names).toContain('高斯步枪');
    expect(names).not.toContain('物品模板');
    expect(names).not.toContain('武器模板');
    expect(names).not.toContain('空手');
    expect(names.filter((n) => n === '高斯步枪')).toHaveLength(1);
  });

  it('中奖数量恒为 1（只发 1 个物品）', () => {
    const svc = makeService();
    expect(svc.rollCount()).toBe(1);
    expect(svc.rollCount()).toBe(1);
  });

  it('今日日期与签到同口径 YYYY-MM-DD', () => {
    const svc = makeService();
    expect(svc.localTodayString(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
