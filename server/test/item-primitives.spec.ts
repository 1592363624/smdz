import { ItemSystemService } from '../src/modules/game/item-system.service';
import { ItemService } from '../src/modules/game/item.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

jest.mock('../src/modules/game/static-data.service', () => {
  const actual = jest.requireActual('../src/modules/game/static-data.service');
  const originalLoad = actual.StaticDataService.prototype.loadRaw;
  actual.StaticDataService.prototype.loadRaw = function(key: any) {
    if (key === 'equipments') {
      return [
        { name: '测试铠甲', equipType: '上身', specialSeq: 0, specialEffect: 0 },
        { name: '增幅器-速射', equipType: '增幅器', specialSeq: 71 },
      ];
    }
    if (key === 'effects') {
      return [
        { name: '倾国倾城', limit: '装备', bonus: '{}' },
        { name: '花园猫猫', limit: '', bonus: '{}' },
        { name: '后羿', limit: '', bonus: '{}' },
      ];
    }
    return originalLoad.call(this, key);
  };
  return actual;
});

const staticData = new StaticDataService();
const service = new ItemSystemService(
  {} as any,
  {} as any,
  {} as any,
  new ItemService({} as any, staticData, {} as any, {} as any, {} as any),
  {} as any,
  staticData,
);

describe('物品基础判定复刻', () => {
  it('判断物品2：命中装备列表改为装备，否则资源', () => {
    const equipment: any = { 名称: '测试铠甲', type: '' };
    const resource: any = { 名称: '铁矿', type: '' };
    service.judgeItem(equipment);
    service.judgeItem(resource);
    expect(equipment).toMatchObject({ 名称: '测试铠甲', 类型: '装备', type: '装备' });
    expect(resource).toMatchObject({ 名称: '铁矿', 类型: '资源', type: '资源' });
  });

  it('是否装备与寻找装备按原版首项命中', () => {
    expect(service.isEquipment('测试铠甲')).toBe(true);
    expect(service.isEquipment('铁矿')).toBe(false);
    const items = [{ 类型: '资源' }, { 类型: '装备', 名称: '测试铠甲' }];
    expect(service.findEquipment(items, '装备')).toBe(1);
    expect(service.findEquipment(items, '武器')).toBe(-1);
  });

  it('资源需求：上限1000000并保留原版换行不足提示', () => {
    const backpack = [{ name: '铁矿', type: '资源', quantity: 2.5 }];
    const ok = service.resourceRequirement(3, [{ name: '铁矿', quantity: 0.5 }], backpack);
    const fail = service.resourceRequirement(1000001, [{ name: '铁矿', quantity: 1 }], backpack);
    expect(ok).toEqual({ success: true, text: '' });
    expect(fail.success).toBe(false);
    expect(fail.text).toBe('\n需要铁矿x1000000，你只有2.5');
  });

  it('取物品数量：装备返回1，普通资源返回数量，未命中返回空类型', () => {
    const items = [
      { name: '测试铠甲', type: '装备', quantity: 3 },
      { name: '铁矿', type: '资源', count: 2.5 },
    ];
    expect(service.getItemQuantityWithType('测试铠甲', items)).toEqual({ quantity: 1, type: '装备' });
    expect(service.getItemQuantityWithType('铁矿', items)).toEqual({ quantity: 2.5, type: '资源' });
    expect(service.getItemQuantityWithType('缺失', items)).toEqual({ quantity: 0, type: '' });
  });

  it('装备特效要求与是否部件：按特效池编号和部件/建筑列表判定', () => {
    const equipped = [{ name: '测试铠甲', type: '装备', data: 'e!bx2' }];
    expect(service.hasEquipmentEffect(equipped, '花园猫猫')).toBe(true);
    expect(service.hasEquipmentEffect(equipped, '倾国倾城')).toBe(false);
  });
});
