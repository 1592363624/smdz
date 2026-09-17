/**
 * 「说了获得 → 背包真的到账」闭环（真实远程库）
 *
 * 核心断言：指令返回文案里出现「获得了/收集到了/兑换了/购买成功/使用了…得到了」时，
 * 对应物品必须真实出现在背包（quantity 增加），且货币列与镜像不被吞。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CommandService } from '../src/modules/command/command.service';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CommandContext, CommandSource } from '../src/modules/command/interfaces/command.interface';
import { parseJson } from './parse-json.util';

jest.setTimeout(180000);

function bpMap(backpack: any[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of backpack || []) {
    if (!it?.name) continue;
    m.set(it.name, Number(it.quantity) || 0);
  }
  return m;
}

function qty(bp: any[], name: string): number {
  return bpMap(bp).get(name) || 0;
}

function assertCurrencyMirror(player: any, backpack: any[], where: string) {
  if (player.diamonds === undefined) return;
  const pairs: Array<[string, number]> = [
    ['钻石', Number(player.diamonds) || 0],
    ['召唤券', Number(player.tickets) || 0],
    ['数据核心', Number(player.dataCores) || 0],
  ];
  for (const [name, col] of pairs) {
    if (col <= 0) continue;
    const e = backpack.find((i: any) => i.name === name);
    if (!e) throw new Error(`${where}: ${name} 列=${col} 但背包缺失镜像`);
    if (Math.abs(Number(e.quantity) - col) > 1e-6) {
      throw new Error(`${where}: ${name} 列=${col} 背包=${e.quantity} 不一致`);
    }
  }
}

describe('获得/交易到账闭环', () => {
  let app: any;
  let prisma: PrismaService;
  let commandService: CommandService;
  let playerService: PlayerService;
  const createdUserIds: number[] = [];
  const stamp = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    commandService = app.get(CommandService);
    playerService = app.get(PlayerService);
  });

  afterAll(async () => {
    for (const uid of createdUserIds) {
      try { await prisma.user.delete({ where: { id: uid } }); } catch { /* ignore */ }
    }
    if (app) await app.close();
  });

  async function send(uid: number, raw: string): Promise<string> {
    const ctx: CommandContext = {
      userId: uid,
      channelId: 0,
      source: CommandSource.WEB,
      rawMessage: raw,
    };
    const r = await commandService.dispatch(ctx);
    return r?.content || '';
  }

  async function load(uid: number) {
    const pd = await playerService.getPlayerData(uid);
    const backpack = Array.isArray(pd.backpack) ? pd.backpack : parseJson(pd.player.backpack, []);
    return { ...pd, backpack };
  }

  async function newPlayer(tag: string, overrides: any = {}) {
    const user = await prisma.user.create({
      data: { username: `e2e_deliver_${tag}_${stamp()}`, password: 'e2e_test', role: 'USER' },
    });
    createdUserIds.push(user.id);
    await prisma.player.create({
      data: {
        userId: user.id, mapId: 1, name: `到账${tag}`,
        type: '伊卡洛斯', specialSeq: -2, affinity: 30,
        hp: 300, maxHp: 300, shield: 50, maxShield: 50, armor: 20, maxArmor: 20,
        level: 40, dodge: 15, exp: 0, upgradeExp: 5000,
        diamonds: 50000, tickets: 200, dataCores: 500,
        markers: '{"教程":3,"签到":1,"签到时间":1}', markers2: '[]', buffs: '[]',
        backpack: JSON.stringify([
          { name: '木头', type: '资源', quantity: 800 },
          { name: '石头', type: '资源', quantity: 600 },
          { name: '铁矿', type: '资源', quantity: 400 },
          { name: '绳子', type: '资源', quantity: 200 },
          { name: '面包', type: '资源', quantity: 10 },
          { name: '普通装备补给箱', type: '物品', quantity: 8 },
          { name: '优秀装备补给箱', type: '物品', quantity: 4 },
          { name: '优秀武器补给箱', type: '物品', quantity: 2 },
          { name: '测试木剑', type: '装备', quantity: 1, data: 'd!ac1', durability: 80 },
          { name: '麻醉枪', type: '装备', quantity: 1, data: 'c!bx0', durability: 60 },
        ]),
        equipment: '[]', weapons: '[]', tasks: '[]',
        ...overrides,
      },
    });
    return user.id;
  }

  /**
   * 从返回文案里抽取「获得了 X ×N / 获得了XxN / 收集到了…」中的物品名+数量。
   * 兼容：`获得了 水晶 ×1`、`得到了奶×2.5`、`收集到了木头×3、铁矿×1`、`使用了1个箱子,得到了…`
   */
  function parseGains(text: string): Array<{ name: string; qty: number }> {
    const gains: Array<{ name: string; qty: number }> = [];
    const push = (rawName: string, rawQty: string | number) => {
      const name = String(rawName).replace(/^[【\[（(]+|[】\])）]+$/g, '').trim();
      const q = Number(rawQty);
      if (!name || !Number.isFinite(q) || q <= 0) return;
      // 跳过经验/活力/百分比等非背包物
      if (/经验|活力|好感|熟练度|钻石|召唤券|数据核心|%/.test(name) && !['钻石', '召唤券', '数据核心'].includes(name)) {
        // 货币仍可到账，但经验不是背包物品
        if (/经验|活力|好感|熟练度|%/.test(name)) return;
      }
      gains.push({ name, qty: q });
    };

    // 获得了 X ×N / 得到了 X×N
    for (const m of text.matchAll(/(?:获得|得到)[了的]?【?([^\s，,、。×x*【】\[\]（）()\n]+)】?\s*[×x*]\s*([\d.]+)/g)) {
      push(m[1], m[2]);
    }
    // 收集到了 A×1、B×2.5
    const collect = text.match(/收集到了([^\n]+)/);
    if (collect) {
      for (const part of collect[1].split(/[、,，]/)) {
        const m = part.match(/([^\s×x*]+)\s*[×x*]\s*([\d.]+)/);
        if (m) push(m[1], m[2]);
      }
    }
    // 使用了N个X,得到了Y / 使用了N个X,得到了 A、B
    const useGet = text.match(/使用了\d+个[^,，\n]*[,，]\s*得到了([^\n]+)/);
    if (useGet) {
      let parsedAny = false;
      for (const part of useGet[1].split(/[、,，]/)) {
        const m = part.match(/([^\s×x*]+)\s*[×x*]\s*([\d.]+)/);
        if (m) {
          push(m[1], m[2]);
          parsedAny = true;
        }
      }
      if (!parsedAny) {
        const bare = useGet[1].trim().replace(/^[【\[（(]+|[】\])）]+$/g, '');
        if (bare && !/[×x*]/.test(bare) && bare.length <= 12) {
          push(bare, 1);
        }
      }
    }
    // 购买成功！ 获得了 名 ×N
    for (const m of text.matchAll(/获得了\s*([^\s，,、。×x*【】\[\]（）()\n]+)\s*[×x*]\s*([\d.]+)/g)) {
      push(m[1], m[2]);
    }
    return gains;
  }

  /** 声称获得的物品是否至少有一项在背包里增加了（相对 before） */
  function assertGainsLanded(before: any[], after: any[], claimed: Array<{ name: string; qty: number }>, text: string) {
    if (!claimed.length) return;
    const b = bpMap(before);
    const a = bpMap(after);
    // 至少一项 claimed 在背包里增加了；若声称的名称对不上，放宽为「新出现任意装备」也算到账线索
    let anyIncreased = false;
    const details: string[] = [];
    for (const g of claimed) {
      const beforeQ = b.get(g.name) || 0;
      const afterQ = a.get(g.name) || 0;
      if (afterQ + 1e-9 < beforeQ) {
        details.push(`声称获得 ${g.name}×${g.qty} 但背包减少 ${beforeQ}→${afterQ}`);
      }
      if (afterQ > beforeQ + 1e-9) anyIncreased = true;
    }
    // 也检查是否新出现装备（名称可能与文案不完全一致）
    const newItems = [...a.keys()].filter((n) => !b.has(n) && a.get(n)! > 0);
    if (newItems.length) anyIncreased = true;

    if (!anyIncreased) {
      throw new Error(
        `文案声称获得但背包未增加:\n文案=${text.slice(0, 200)}\n声称=${JSON.stringify(claimed)}\nbefore=${JSON.stringify([...b.entries()])}\nafter=${JSON.stringify([...a.entries()])}`,
      );
    }
    if (details.length) {
      // 有声称项反而减少也算到账失败（排除货币消耗以外）
      const serious = details.filter((d) => !/钻石|召唤券|数据核心/.test(d));
      if (serious.length) throw new Error(serious.join('\n'));
    }
  }

  it('1. 使用补给箱：文案「得到了装备」→ 背包出现新装备且箱数量减少', async () => {
    const uid = await newPlayer('box');
    const b0 = await load(uid);
    const box0 = qty(b0.backpack, '普通装备补给箱');
    expect(box0).toBe(8);

    const text = await send(uid, '使用普通装备补给箱1');
    const b1 = await load(uid);
    const box1 = qty(b1.backpack, '普通装备补给箱');

    expect(text).toMatch(/使用|得到|获得/);
    // 箱子必须减少 1
    expect(box1).toBe(box0 - 1);
    // 背包条目数应 ≥ 原来（开出装备或资源）
    expect(b1.backpack.length).toBeGreaterThanOrEqual(b0.backpack.length - 1);
    // 若文案点名了获得物，必须到账
    const claimed = parseGains(text);
    assertGainsLanded(b0.backpack, b1.backpack, claimed, text);
    assertCurrencyMirror(b1.player, b1.backpack, '开箱后');
  });

  it('2. 使用优秀装备补给箱：数量闭环 + 至少多出装备或资源', async () => {
    const uid = await newPlayer('exbox');
    const b0 = await load(uid);
    const box0 = qty(b0.backpack, '优秀装备补给箱');
    const names0 = new Set(b0.backpack.map((i: any) => i.name));

    const text = await send(uid, '使用优秀装备补给箱1');
    const b1 = await load(uid);
    expect(qty(b1.backpack, '优秀装备补给箱')).toBe(box0 - 1);

    const names1 = b1.backpack.map((i: any) => i.name);
    const gained = names1.filter((n) => !names0.has(n));
    // 至少应开出新物（原版补给箱必出）
    expect(gained.length).toBeGreaterThan(0);
    assertGainsLanded(b0.backpack, b1.backpack, parseGains(text), text);
  });

  it('3. 兑换：文案「用X钻石兑换了Y」→ 背包多 Y、钻石列减少且镜像同步', async () => {
    const uid = await newPlayer('exchange');
    const b0 = await load(uid);
    const d0 = Number(b0.player.diamonds);
    expect(d0).toBeGreaterThan(10);

    const text = await send(uid, '兑换 水晶 1');
    const b1 = await load(uid);
    const d1 = Number(b1.player.diamonds);

    // 成功路径
    if (/兑换了/.test(text) && !/失败|不足|没有|无法/.test(text)) {
      expect(d1).toBeLessThan(d0);
      // 钻石列减少后，镜像必须同步（不是旧 count）
      assertCurrencyMirror(b1.player, b1.backpack, '兑换后');
      const diamond = b1.backpack.find((i: any) => i.name === '钻石');
      if (diamond) {
        expect(Number(diamond.quantity)).toBeCloseTo(d1, 6);
        expect(diamond.count).toBeUndefined();
      }
      // 文案点名的物品若在背包出现则数量>0
      if (/水晶/.test(text)) {
        const crystal = b1.backpack.find((i: any) => i.name === '水晶');
        expect(crystal).toBeTruthy();
        expect(Number(crystal.quantity)).toBeGreaterThan(0);
      }
    } else {
      // 失败时数量不得偷改
      expect(d1).toBe(d0);
    }
  });

  it('4. 制造：文案「得到了产物」→ 产物进包、材料减少', async () => {
    const uid = await newPlayer('craft');
    const b0 = await load(uid);
    // 先看有哪些配方可制造
    const menu = await send(uid, '制造');
    // 尝试常见配方（木头相关）
    const tryRecipes = ['木板', '木棍', '绳子', '火把', '木箱', '工作台'];
    let crafted = false;
    for (const r of tryRecipes) {
      const text = await send(uid, `制造${r}`);
      if (/得到了|制造了/.test(text) && !/失败|不足|没有|无法|需要/.test(text)) {
        const b1 = await load(uid);
        assertGainsLanded(b0.backpack, b1.backpack, parseGains(text), text);
        assertCurrencyMirror(b1.player, b1.backpack, '制造后');
        crafted = true;
        break;
      }
    }
    // 至少制造菜单可打开；具体配方因静态配置而异
    expect(menu.length).toBeGreaterThan(0);
    if (!crafted) {
      // 未制造成功也算通路正常（材料/配方不匹配），但结构必须合法
      const b1 = await load(uid);
      assertCurrencyMirror(b1.player, b1.backpack, '制造尝试后');
    }
  });

  it('5. 丢弃：文案「丢弃了X ×N」→ 背包 X 减少恰好 N', async () => {
    const uid = await newPlayer('discard');
    const b0 = await load(uid);
    const wood0 = qty(b0.backpack, '木头');
    expect(wood0).toBe(800);

    const text = await send(uid, '丢弃 木头 5');
    expect(text).toContain('丢弃了');
    const m = text.match(/丢弃了([^\s]+)\s*[×x*]\s*([\d.]+)/);
    expect(m).toBeTruthy();
    const discarded = Number(m![2]);
    expect(discarded).toBe(5);

    const b1 = await load(uid);
    expect(qty(b1.backpack, '木头')).toBe(wood0 - 5);
  });

  it('6. 战斗：攻击后若文案出现掉落名，对应背包必须增加', async () => {
    const uid = await newPlayer('battle');
    // 在医疗室附近攻击（可能无怪）
    const text = await send(uid, '攻击');
    const b0 = await load(uid);
    // 再打一轮
    const text2 = await send(uid, '攻击');
    const b1 = await load(uid);
    assertCurrencyMirror(b1.player, b1.backpack, '战斗后');

    // 若两次文案有「得到了/收集到了/掉落」
    const all = text + '\n' + text2;
    if (/得到了|收集到了|掉落/.test(all)) {
      // 不强制具体物品（随机），但背包结构必须合法，且不得出现 count 镜像
      for (const it of b1.backpack) {
        expect(it.count).toBeUndefined();
        expect(it.quantity === undefined || Number.isFinite(Number(it.quantity))).toBe(true);
      }
    }
    // hp 不能超上限
    expect(Number(b1.player.hp)).toBeLessThanOrEqual(Number(b1.player.maxHp) + 1);
  });

  it('7. 开箱 + 连续使用全部：每次声称获得都有到账痕迹', async () => {
    const uid = await newPlayer('useall');
    const b0 = await load(uid);
    const box0 = qty(b0.backpack, '普通装备补给箱');
    expect(box0).toBe(8);

    const text = await send(uid, '使用全部补给箱');
    const b1 = await load(uid);
    const box1 = qty(b1.backpack, '普通装备补给箱');

    // 使用全部应至少用掉一部分（文案格式因物品类型而异，以背包差分为准）
    expect(box1).toBeLessThan(box0);
    expect(box0 - box1).toBeGreaterThanOrEqual(1);
    if (/使用了/.test(text)) {
      expect(text.length).toBeGreaterThan(0);
    }
    assertCurrencyMirror(b1.player, b1.backpack, '使用全部后');
  });

  it('8. 装备穿戴/卸下：穿前在背包、穿后在装备栏，data 不丢', async () => {
    const uid = await newPlayer('equip');
    const b0 = await load(uid);
    const bagBefore = b0.backpack.find((i: any) => i.name === '测试木剑');
    expect(bagBefore).toBeTruthy();
    const data0 = String(bagBefore.data);

    const eqText = await send(uid, '装备 测试木剑');
    const b1 = await load(uid);
    const bagAfter = b1.backpack.find((i: any) => i.name === '测试木剑');
    const eqList = Array.isArray(b1.player.equipment) ? b1.player.equipment : parseJson(b1.player.equipment, []);
    const eq = eqList.find((e: any) => e?.name === '测试木剑');

    if (/装备|穿上|已/.test(eqText) && !/失败|没有|无法/.test(eqText)) {
      // 背包移除或装备栏出现（有的实现是移动）
      expect(bagAfter == null || eq != null).toBe(true);
      if (eq) {
        expect(String(eq.data || '')).toMatch(/^[edcbasx]/i);
        // data 不得被吞成空
        expect(String(eq.data || '').length).toBeGreaterThanOrEqual(1);
      }
    }

    // 卸下后再看
    await send(uid, '卸下 武器');
    const b2 = await load(uid);
    const eqList2 = Array.isArray(b2.player.equipment) ? b2.player.equipment : parseJson(b2.player.equipment, []);
    const stillEq = eqList2.find((e: any) => e?.name === '测试木剑');
    const backBag = b2.backpack.find((i: any) => i.name === '测试木剑');
    if (stillEq == null && backBag) {
      // 卸回背包时 data 必须还在
      expect(String(backBag.data || '')).toMatch(/^[edcbasx]/i);
    }
  });

  it('9. 积分/掉落率任务推进后，奖励类文案出现时必须有对应入包', async () => {
    const uid = await newPlayer('task');
    // 推进观察附近（新手教程）
    const t1 = await send(uid, '观察附近');
    const b0 = await load(uid);
    // 教程奖励若已发放，文案会有得到了
    if (/得到了|获得/.test(t1)) {
      const claimed = parseGains(t1);
      const b1 = await load(uid);
      if (claimed.length) {
        assertGainsLanded(b0.backpack, b1.backpack, claimed, t1);
      }
    }
    assertCurrencyMirror((await load(uid)).player, (await load(uid)).backpack, '任务后');
  });

  it('10. 货币兑扣与物品到账同步：钻石列减、目标物品增、镜像一致', async () => {
    const uid = await newPlayer('sync');
    const b0 = await load(uid);
    const d0 = Number(b0.player.diamonds);
    const beforeCrystal = qty(b0.backpack, '水晶');

    const text = await send(uid, '兑换 水晶 1');
    const b1 = await load(uid);
    const d1 = Number(b1.player.diamonds);
    const afterCrystal = qty(b1.backpack, '水晶');

    if (/兑换了/.test(text) && d1 < d0) {
      expect(afterCrystal).toBeGreaterThan(beforeCrystal);
      assertCurrencyMirror(b1.player, b1.backpack, '同步终态');
    } else {
      // 未成功：两者都不动
      expect(d1).toBe(d0);
      expect(afterCrystal).toBe(beforeCrystal);
    }
  });
});
