/**
 * 家园写操作门禁（home-gate.util）单元测试
 *
 * 锁定口径：种植 / 收获 / 建造 / 拆除 / 安装 / 使用凭证 等家园操作必须等
 * 房子建成（`家园进度 >= 4`），未建成时返回带四步引导的拦截文本；
 * 开关 HOME_REQUIRE_BUILT=false 时可整体关闭（回退原版宽松行为）。
 */

import { GlobalConfig } from '../src/config/global.config';
import {
  getHomeProgress,
  HOME_BUILT_PROGRESS,
  homeBuiltGateText,
  isHomeBuilt,
} from '../src/modules/game/home-gate.util';

describe('家园写操作建成门禁', () => {
  afterEach(() => {
    // 测试可能改写过开关，统一还原，避免污染其它用例
    (GlobalConfig.getInstance().home as any).requireBuiltForActions = true;
  });

  it('进度解析兼容对象与 JSON 字符串两种形态', () => {
    expect(getHomeProgress({ 家园进度: 3 })).toBe(3);
    expect(getHomeProgress(JSON.stringify({ 家园进度: 2 }))).toBe(2);
    expect(getHomeProgress({})).toBe(0);
    expect(getHomeProgress(undefined)).toBe(0);
    expect(getHomeProgress('非法 JSON')).toBe(0);
  });

  it('进度达到 4 才算建成', () => {
    expect(HOME_BUILT_PROGRESS).toBe(4);
    expect(isHomeBuilt({ 家园进度: 4 })).toBe(true);
    expect(isHomeBuilt({ 家园进度: 5 })).toBe(true);
    expect(isHomeBuilt({ 家园进度: 3 })).toBe(false);
    expect(isHomeBuilt({})).toBe(false);
  });

  it('已建成时不拦截（返回 null）', () => {
    expect(homeBuiltGateText({ name: '冒险者', markers: { 家园进度: 4 } })).toBeNull();
  });

  it('未圈地（进度 0）提示先圈地', () => {
    const text = homeBuiltGateText({ name: '冒险者', markers: {} });
    expect(text).toContain('还没有家园');
    expect(text).toContain('圈地');
  });

  it('在建中（进度 1-3）提示先建成，并附四步引导块', () => {
    const text = homeBuiltGateText({ name: '冒险者', markers: { 家园进度: 2 } }) as string;
    expect(text).toContain('需要先完成房屋的建造');
    // 引导块与四条建造指令回包同格式，网页端据此渲染引导卡片
    expect(text).toContain('家园建造进度 2/4');
    expect(text).toContain('发送「建造地基」');
  });

  it('开关关闭（HOME_REQUIRE_BUILT=false）后不再拦截', () => {
    (GlobalConfig.getInstance().home as any).requireBuiltForActions = false;
    expect(homeBuiltGateText({ name: '冒险者', markers: {} })).toBeNull();
    expect(homeBuiltGateText({ name: '冒险者', markers: { 家园进度: 1 } })).toBeNull();
  });
});
