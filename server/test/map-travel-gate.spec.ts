import { MapService } from '../src/modules/game/map.service';

/**
 * 地图通行门槛门禁（完整复刻原版「前往需求判断」地图操作.ecode L992-1046
 * + 标记要求 _主程序.ecode L6648-6660 + 不可传送 L1614/L1738）。
 *
 * 历史事故背景：旧实现把 requiredTravel 判定写成查玩家 markers 的 travel_2/travel_3
 * 键，而全代码库无任何写入点 → 战舰坟场/血族城堡永久锁死。本 spec 防止回归。
 */
describe('地图通行门槛 checkCanTravel（原版复刻门禁）', () => {
  function makeService(): any {
    return Object.create(MapService.prototype);
  }

  const player = (markers: any = { 召唤白: 1 }, equipment: any[] = []) => ({
    markers: JSON.stringify(markers),
    equipment: JSON.stringify(equipment),
  });
  const vehicle = (walkMode: number) => ({ 名称: '测试载具', 列表编号: 1, 行走方式: walkMode });

  it('前往查出发地图的前往需求（原版 L6634）：徒步/步行载具拦截，跃迁载具放行', () => {
    const svc = makeService();
    const from = { id: 9, name: '战舰坟场', requiredTravel: 3, connections: '[]' };
    const to = { id: 1, name: '出口', connections: '[]' };

    // 徒步：跃迁需求必拦（原版 L1034；文案前缀为目的地图名 w4，与原版 L6634 第5参一致）
    const onFoot = svc.checkCanTravel(from, to, player(), { mode: 'move' });
    expect(onFoot.canTravel).toBe(false);
    expect(onFoot.reason).toContain('出口限制了需要跃迁才能到达');
    expect(onFoot.reason).toContain('只有驾驶安装了任意型号跃迁引擎的载具才能跃迁');

    // 步行载具（行走方式1）不满足跃迁（原版 L1039）
    const ground = svc.checkCanTravel(from, to, player(), { mode: 'move', vehicle: vehicle(1) });
    expect(ground.canTravel).toBe(false);
    expect(ground.reason).toContain('当前驾驶的载具测试载具的移动方式未满足条件');

    // 跃迁载具（行走方式3）放行
    const warp = svc.checkCanTravel(from, to, player(), { mode: 'move', vehicle: vehicle(3) });
    expect(warp.canTravel).toBe(true);
  });

  it('飞到/传送查目的地图的前往需求（原版 L1620/L1744）：出发地图不参与判定', () => {
    const svc = makeService();
    const from = { id: 2, name: '出发地', requiredTravel: 3, connections: '[]' };
    const to = { id: 10, name: '血族城堡', requiredTravel: 2, connections: '[]' };

    // 飞到：出发图的 requiredTravel 不拦，目的地图的传送级需求拦（步行载具）
    const fly = svc.checkCanTravel(from, to, player(), { mode: 'fly', vehicle: vehicle(2) });
    expect(fly.canTravel).toBe(false);
    expect(fly.reason).toContain('血族城堡限制了需要传送才能到达');

    // 目的地图无需求时，即使出发地图有需求也放行
    const toFree = { id: 11, name: '自由之地', requiredTravel: 0, connections: '[]' };
    const ok = svc.checkCanTravel(from, toFree, player(), { mode: 'fly', vehicle: vehicle(2) });
    expect(ok.canTravel).toBe(true);
  });

  it('传送级需求：徒步持天蓝吊坠放行，无吊坠拦截（原版 L1016-1023）', () => {
    const svc = makeService();
    const from = { id: 2, name: '出发地', connections: '[]' };
    const to = { id: 10, name: '血族城堡', requiredTravel: 2, connections: '[]' };

    const noPendant = svc.checkCanTravel(from, to, player(), { mode: 'teleport' });
    expect(noPendant.canTravel).toBe(false);
    expect(noPendant.reason).toContain('你可以装备[天蓝吊坠]或者给载具安装任意型号的');

    const withPendant = svc.checkCanTravel(
      from, to, player({ 召唤白: 1 }, [{ name: '天蓝吊坠' }]), { mode: 'teleport' },
    );
    expect(withPendant.canTravel).toBe(true);

    // 驾驶跃迁载具（行走方式3）同样放行（原版 L1025-1026）
    const warpVehicle = svc.checkCanTravel(from, to, player(), { mode: 'teleport', vehicle: vehicle(3) });
    expect(warpVehicle.canTravel).toBe(true);
  });

  it('飞行级需求：徒步放行，飞行(2)/跃迁(3)载具放行，步行载具拦截（原版 L1006-1014）', () => {
    const svc = makeService();
    const from = { id: 2, name: '出发地', connections: '[]' };
    const to = { id: 12, name: '浮空岛', requiredTravel: 1, connections: '[]' };

    expect(svc.checkCanTravel(from, to, player(), { mode: 'fly' }).canTravel).toBe(true);
    expect(svc.checkCanTravel(from, to, player(), { mode: 'fly', vehicle: vehicle(2) }).canTravel).toBe(true);
    expect(svc.checkCanTravel(from, to, player(), { mode: 'fly', vehicle: vehicle(3) }).canTravel).toBe(true);

    const ground = svc.checkCanTravel(from, to, player(), { mode: 'fly', vehicle: vehicle(1) });
    expect(ground.canTravel).toBe(false);
    expect(ground.reason).toContain('需要安装任意型号的推进器或者跃迁引擎');
  });

  it('标记要求：标记缺失/数值<1 拦截，命中返回原版锁门文案（原版 L6648-6660）', () => {
    const svc = makeService();
    const from = { id: 1, name: '医疗室', connections: '[]' };
    const to = {
      id: 2, name: '走廊', connections: '[]',
      requireMarkers: ['召唤白'], failHint: '先“观察附近”看看附近有什么吧',
    };

    const locked = svc.checkCanTravel(from, to, player({}), { mode: 'move' });
    expect(locked.canTravel).toBe(false);
    expect(locked.reason).toBe('前往走廊的门似乎锁上了，\n先“观察附近”看看附近有什么吧');

    // 数值为 0 同样视为不满足（原版 取成就熟练度 < 1）
    const zero = svc.checkCanTravel(from, to, player({ 召唤白: 0 }), { mode: 'move' });
    expect(zero.canTravel).toBe(false);

    const unlocked = svc.checkCanTravel(from, to, player({ 召唤白: 1 }), { mode: 'move' });
    expect(unlocked.canTravel).toBe(true);
  });

  it('不可传送：仅拦截飞到/传送，前往走陆路放行（原版 L1614/L1738）', () => {
    const svc = makeService();
    const from = { id: 1, name: '出发地', connections: '[]' };
    const to = { id: 3, name: 'CELL研究中心', noTeleport: true, connections: '[]' };

    const fly = svc.checkCanTravel(from, to, player(), { mode: 'fly' });
    expect(fly.canTravel).toBe(false);
    expect(fly.reason).toContain('存在严重干扰，贸然前往后果不可预料');

    const teleport = svc.checkCanTravel(from, to, player(), { mode: 'teleport' });
    expect(teleport.canTravel).toBe(false);

    const move = svc.checkCanTravel(from, to, player(), { mode: 'move' });
    expect(move.canTravel).toBe(true);
  });
});
