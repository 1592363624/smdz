import { GameService } from '../src/modules/game/game.service';

/**
 * 进行中操作倒计时快照（buildPlayerInfo.pendingActions）自检
 *
 * 覆盖原版里所有"发指令 → 等 N 秒 → 延时结算"的场景，保证前端倒计时条
 * 拿到的条目齐全、时间口径统一（毫秒）、已到期的不残留：
 *   ① 采集（打开箱子 / 打开休眠仓 / 收集木头 …）
 *   ② 移动（前往其它地图，含飞行）
 *   ③ 抢救使魔 / 维修载具 / 自救 / 救助玩家
 *   ④ 麻痹等负面锁定
 *   ⑤ 已到期条目被剔除、markers2 镜像标记不产生重复条目
 */

/** 用最小桩构造 GameService（只需 playerService.safeJsonParse） */
function makeService(): any {
  const svc: any = Object.create(GameService.prototype);
  svc.playerService = {
    safeJsonParse: (value: any, fallback: any) => {
      if (value === null || value === undefined) return fallback;
      if (typeof value !== 'string') return value;
      try {
        const parsed = JSON.parse(value);
        return parsed === null ? fallback : parsed;
      } catch {
        return fallback;
      }
    },
  };
  return svc;
}

const build = (svc: any, markers: any, markers2: any[] = []) =>
  svc.buildPendingActions({ markers: JSON.stringify(markers), markers2: JSON.stringify(markers2) }, markers, markers2);

describe('进行中操作倒计时快照', () => {
  it('采集：打开箱子/休眠仓等输出指令名与目标资源，时间与总时长为毫秒', () => {
    const svc = makeService();
    const now = Date.now();
    const list = build(svc, {
      采集中: { target: '医疗箱', cmd: '打开箱子', count: 1, startedAt: now, settleAt: now + 11000 },
    });

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      key: 'gather',
      kind: 'gather',
      label: '打开箱子',
      detail: '医疗箱',
      startedAt: now,
      totalMs: 11000,
    });
    expect(list[0].endAt).toBe(now + 11000);
  });

  it('采集带次数时副标题追加 ×N', () => {
    const svc = makeService();
    const now = Date.now();
    const list = build(svc, {
      采集中: { target: '木头', cmd: '收集木头', count: 3, startedAt: now, settleAt: now + 18000 },
    });
    expect(list[0].detail).toBe('木头 ×3');
  });

  it('移动：解析 markers 中的 JSON 字符串并带出目标地图', () => {
    const svc = makeService();
    const now = Date.now();
    const list = build(svc, {
      移动中: JSON.stringify({ targetName: '森林', targetMapId: 3, startedAt: now, arriveAt: now + 5000 }),
    });

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: 'move', kind: 'move', label: '移动中', detail: '前往【森林】', totalMs: 5000 });
    expect(list[0].endAt).toBe(now + 5000);
  });

  it('飞行移动显示飞行与滑翔图标文案', () => {
    const svc = makeService();
    const now = Date.now();
    const list = build(svc, {
      移动中: JSON.stringify({ targetName: '天空之城', startedAt: now, arriveAt: now + 10000, mode: '飞行' }),
    });
    expect(list[0]).toMatchObject({ label: '移动中', detail: '飞行【天空之城】', icon: '🕊️' });
  });

  it('抢救/维修/自救/救助玩家：按 rescueType 输出对应文案', () => {
    const svc = makeService();
    const endSec = Math.ceil(Date.now() / 1000) + 30;
    const list = build(svc, {}, [
      { name: '复活', rescueType: 'familiar', expireAt: endSec },
      { name: '工作', rescueType: 'player', expireAt: endSec + 5 },
      { name: '复活', rescueType: 'vehicle', expireAt: endSec + 10 },
      { name: '复活', rescueType: 'self', expireAt: endSec + 15 },
    ]);

    expect(list.map((a: any) => a.label)).toEqual(['抢救使魔', '救助玩家', '维修载具', '自救']);
    // 秒级 expireAt 已归一为毫秒，并按结束时间升序
    expect(list[0].endAt).toBe(endSec * 1000);
    expect(list.every((a: any) => a.kind === 'rescue')).toBe(true);
  });

  it('麻痹等负面锁定标记为 debuff 类型', () => {
    const svc = makeService();
    const list = build(svc, {}, [{ name: '麻痹', expireAt: Math.ceil(Date.now() / 1000) + 8 }]);
    expect(list[0]).toMatchObject({ key: 'paralysis', kind: 'debuff', label: '麻痹中' });
  });

  it('抢救标记带 startedAt/totalMs 时原样透出，供刷新页面后仍显示真实进度', () => {
    const svc = makeService();
    const now = Date.now();
    const list = build(svc, {}, [
      { name: '复活', rescueType: 'familiar', startedAt: now, totalMs: 30000, expireAt: Math.ceil(now / 1000) + 30 },
    ]);
    expect(list[0].startedAt).toBe(now);
    expect(list[0].totalMs).toBe(30000);
  });

  it('总时长不可知时置 0：前端以首次观测到的剩余时间自行起算进度条', () => {
    const svc = makeService();
    const list = build(svc, {}, [{ name: '麻痹', expireAt: Math.ceil(Date.now() / 1000) + 8 }]);
    expect(list[0].totalMs).toBe(0);
    expect(list[0].startedAt).toBe(0);
  });

  it('起止时间与总时长知其二即可推第三个', () => {
    const svc = makeService();
    const now = Date.now();

    // 只给起点：总时长由 endAt - startedAt 推出
    const fromStart = build(svc, {
      采集中: { target: '医疗箱', cmd: '打开箱子', startedAt: now, settleAt: now + 11000 },
    });
    expect(fromStart[0].totalMs).toBe(11000);

    // 只给总时长：起点由 endAt - totalMs 反推
    const fromTotal = build(svc, {}, [{ name: '麻痹', totalMs: 5000, expireAt: now + 5000 }]);
    expect(fromTotal[0].totalMs).toBe(5000);
    expect(fromTotal[0].startedAt).toBe(now);
  });

  it('已到期的条目不输出，避免界面残留倒计时', () => {
    const svc = makeService();
    const now = Date.now();
    expect(build(svc, {
      采集中: { target: '医疗箱', cmd: '打开箱子', startedAt: now - 20000, settleAt: now - 5000 },
    })).toHaveLength(0);
    expect(build(svc, {}, [{ name: '复活', rescueType: 'familiar', expireAt: Math.ceil(now / 1000) - 1 }])).toHaveLength(0);
  });

  it('markers2 镜像标记不与 markers 主状态重复（采集/移动各出一条）', () => {
    const svc = makeService();
    const now = Date.now();
    const list = build(
      svc,
      {
        采集中: { target: '医疗箱', cmd: '打开箱子', startedAt: now, settleAt: now + 9000 },
        移动中: JSON.stringify({ targetName: '森林', startedAt: now, arriveAt: now + 4000 }),
      },
      [
        { name: '采集', expireAt: Math.ceil(now / 1000) + 9 },
        { name: '移动', expireAt: Math.ceil(now / 1000) + 4 },
      ],
    );

    expect(list.filter((a: any) => a.key === 'gather')).toHaveLength(1);
    expect(list.filter((a: any) => a.key === 'move')).toHaveLength(1);
    // 结束更早的移动排在前面
    expect(list[0].key).toBe('move');
  });

  it('无进行中操作时返回空数组', () => {
    const svc = makeService();
    expect(build(svc, {})).toEqual([]);
    expect(build(svc, {}, [{ name: '无关标记', expireAt: Math.ceil(Date.now() / 1000) + 30 }])).toEqual([]);
  });
});
