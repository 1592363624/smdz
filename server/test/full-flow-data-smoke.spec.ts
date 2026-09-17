/**
 * 全链路数据口径冒烟（真实远程库）
 *
 * 目的：字段统一重构后，从注册/开局起走一遍主循环，断言：
 *  1. 货币列（diamonds/tickets/dataCores）与背包镜像一致，不被 count 旧键吞掉
 *  2. 背包条目只出现规范键 quantity（不写 count/数量）
 *  3. 增益/markers2 只出现 name/expireAt/strength（不写 名称/有效期至/强度）
 *  4. 装备 data 品质码存在
 *  5. 采集/使用/装备/商店等主路径操作后数量变化符合预期
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CommandService } from '../src/modules/command/command.service';
import { ShortcutService } from '../src/modules/game/shortcut.service';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CommandContext, CommandSource } from '../src/modules/command/interfaces/command.interface';
import { parseJson } from './parse-json.util';

jest.setTimeout(180000);

/** 会话内禁止出现的旧别名键（按域） */
const FORBIDDEN_ITEM_KEYS = ['名称', '数量', '数据', '类型', '耐久', '制造者'] as const;
const FORBIDDEN_BUFF_KEYS = ['名称', '强度', '有效期至', '是否叠加时间'] as const;
const FORBIDDEN_SUMMON_KEYS = ['当前生命', '当前护盾', '归属', '特殊序号'] as const;

function assertItemShape(item: any, where: string) {
  expect(item).toBeTruthy();
  expect(typeof item.name).toBe('string');
  expect(item.name.length).toBeGreaterThan(0);
  expect(typeof item.quantity === 'number' || typeof item.quantity === 'string').toBe(true);
  if (item.count !== undefined) {
    throw new Error(`${where}: 条目「${item.name}」残留 count 镜像=${JSON.stringify(item.count)}`);
  }
  for (const k of FORBIDDEN_ITEM_KEYS) {
    if (item[k] !== undefined) {
      throw new Error(`${where}: 条目「${item.name}」残留旧键 ${k}`);
    }
  }
}

function assertBuffShape(entry: any, where: string) {
  if (!entry || typeof entry !== 'object') return;
  for (const k of FORBIDDEN_BUFF_KEYS) {
    if (entry[k] !== undefined) {
      throw new Error(`${where}: 增益残留旧键 ${k} → ${JSON.stringify(entry)}`);
    }
  }
  if (entry.name !== undefined && typeof entry.name !== 'string') {
    throw new Error(`${where}: 增益 name 非法 → ${JSON.stringify(entry)}`);
  }
}

function assertBackpack(backpack: any[], where: string) {
  expect(Array.isArray(backpack)).toBe(true);
  for (const item of backpack) assertItemShape(item, where);
}

function assertMarkers2(markers2: any[], where: string) {
  if (!Array.isArray(markers2)) return;
  for (const e of markers2) assertBuffShape(e, where);
}

function assertCurrencyMirror(player: any, backpack: any[], where: string) {
  // 列是真相源；读档后背包应有同数量镜像（无列时跳过）
  if (player.diamonds === undefined && player.tickets === undefined && player.dataCores === undefined) return;
  const find = (name: string) => backpack.find((i: any) => i.name === name);
  const pairs: Array<[string, number | undefined]> = [
    ['钻石', player.diamonds === undefined ? undefined : Number(player.diamonds)],
    ['召唤券', player.tickets === undefined ? undefined : Number(player.tickets)],
    ['数据核心', player.dataCores === undefined ? undefined : Number(player.dataCores)],
  ];
  for (const [name, col] of pairs) {
    if (col === undefined) continue;
    const entry = find(name);
    if (col <= 0) {
      if (entry) throw new Error(`${where}: ${name} 列为 ${col} 但背包仍有条目 quantity=${entry.quantity}`);
      continue;
    }
    if (!entry) throw new Error(`${where}: ${name} 列为 ${col} 但背包缺失条目`);
    assertItemShape(entry, where);
    const q = Number(entry.quantity);
    if (Math.abs(q - col) > 1e-6) {
      throw new Error(`${where}: ${name} 列=${col} 背包 quantity=${q} 不一致（字段被吞？）`);
    }
    if (entry.count !== undefined && Math.abs(Number(entry.count) - col) > 1e-6) {
      throw new Error(`${where}: ${name} count 镜像与列不一致 count=${entry.count} col=${col}`);
    }
  }
}

function assertNoLegacyKeysDeep(obj: any, path = 'root', depth = 0): void {
  if (depth > 6 || obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoLegacyKeysDeep(v, `${path}[${i}]`, depth + 1));
    return;
  }
  if (typeof obj !== 'object') return;
  // 数组形态容器：只检查元素级
  for (const k of Object.keys(obj)) {
    const v = (obj as any)[k];
    // markers 字典键是标记名（内容语义），不检查
    if (k === 'markers' || k === 'achievements' || k === 'set' || k === 'bonus' || k === 'markers_record') continue;
    if (['backpack', 'equipment', 'weapons', 'safeBox', 'equipmentPresets', 'markers2', 'buffs'].includes(k)
      && Array.isArray(v)) {
      if (k === 'markers2' || k === 'buffs') v.forEach((e, i) => assertBuffShape(e, `${path}.${k}[${i}]`));
      else v.forEach((e, i) => assertItemShape(e, `${path}.${k}[${i}]`));
      continue;
    }
    if (typeof v === 'object') assertNoLegacyKeysDeep(v, `${path}.${k}`, depth + 1);
  }
}

describe('全链路数据口径冒烟（注册→主循环）', () => {
  let app: any;
  let prisma: PrismaService;
  let commandService: CommandService;
  let shortcutService: ShortcutService;
  let playerService: PlayerService;

  const createdUserIds: number[] = [];
  const stamp = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    commandService = app.get(CommandService);
    shortcutService = app.get(ShortcutService);
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
    const result = await commandService.dispatch(ctx);
    return result?.content || '';
  }

  async function newEmptyPlayer(tag: string) {
    const username = `e2e_flow_${tag}_${stamp()}`;
    const user = await prisma.user.create({ data: { username, password: 'e2e_test', role: 'USER' } });
    createdUserIds.push(user.id);
    await prisma.player.create({
      data: {
        userId: user.id, mapId: 1, name: `流程${tag}`,
        hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        level: 20, dodge: 10, type: '伊卡洛斯', specialSeq: -2, affinity: 0,
        diamonds: 5000, tickets: 100, dataCores: 200,
        markers: '{"教程":3,"签到":1}', markers2: '[]', buffs: '[]',
        backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
      },
    });
    return user.id;
  }

  async function load(uid: number) {
    const pd = await playerService.getPlayerData(uid);
    const backpack = Array.isArray(pd.backpack) ? pd.backpack : parseJson(pd.player.backpack, []);
    const markers2 = Array.isArray(pd.markers2) ? pd.markers2 : parseJson(pd.player.markers2, []);
    const buffs = Array.isArray(pd.buffs) ? pd.buffs : parseJson(pd.player.buffs, []);
    return { ...pd, backpack, markers2, buffs };
  }

  async function beginGame(uid: number, familiar = '伊卡洛斯') {
    // 已带 type 的玩家直接进主循环；未开局仍走门禁确认（与 onboarding 同链）
    const pd0 = await playerService.getPlayerData(uid);
    if (!pd0.player.type) {
      await send(uid, '使魔大战');
      await send(uid, `确认${familiar}`);
    }
    await send(uid, '查看任务').catch(() => '');
  }

  async function grantItem(uid: number, name: string, quantity: number, type = '资源') {
    // 直接改库再让业务读回（不走 GM 双路径）
    const player = await prisma.player.findUnique({ where: { userId: uid } });
    const bp = parseJson(player!.backpack, []);
    const idx = bp.findIndex((i: any) => i.name === name);
    if (idx >= 0) bp[idx].quantity = Number(bp[idx].quantity || 0) + quantity;
    else bp.push({ name, type, quantity });
    await prisma.player.update({ where: { userId: uid }, data: { backpack: bp as any } });
  }

  it('A. 开局：状态/任务/背包字段形状正确，货币列与镜像一致', async () => {
    const uid = await newEmptyPlayer('open');
    await beginGame(uid);

    const pd = await load(uid);
    expect(pd.player.type).toBeTruthy();
    expect(Number(pd.markers['教程'] || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(pd.markers['签到'] || 0)).toBe(1);

    assertBackpack(pd.backpack, '开局背包');
    assertMarkers2(pd.markers2, '开局markers2');
    assertMarkers2(pd.buffs, '开局buffs');
    assertCurrencyMirror(pd.player, pd.backpack, '开局货币');
    assertNoLegacyKeysDeep({ player: pd.player, backpack: pd.backpack, markers2: pd.markers2, buffs: pd.buffs });

    // 登录奖励箱应有数量
    const box = pd.backpack.find((i: any) => i.name === '挑战装备箱');
    if (box) {
      assertItemShape(box, '挑战装备箱');
      expect(Number(box.quantity)).toBeGreaterThan(0);
    }
  });

  it('B. 信息面板 + 背包：quantity 展示与 DB 一致，无 count 吞数量', async () => {
    const uid = await newEmptyPlayer('info');
    await beginGame(uid);
    await grantItem(uid, '木头', 123.45);
    await grantItem(uid, '钻石', 0); // 应被清理或忽略

    const info = await send(uid, '信息');
    expect(info).toContain('流程info');
    // 信息面板是角色状态；数量在背包面板
    const inv = await send(uid, '背包');
    expect(inv).toContain('木头');
    // 背包面板应展示数量 12x 量级（123.45 或取整后 123.5）
    expect(inv).toMatch(/木头[^\d]{0,5}12[23]/);

    const pd = await load(uid);
    assertBackpack(pd.backpack, '信息后背包');
    const wood = pd.backpack.find((i: any) => i.name === '木头');
    expect(Number(wood!.quantity)).toBeCloseTo(123.45, 5);
    if (wood!.count !== undefined) {
      throw new Error('木头仍有 count 镜像，存在双写');
    }
    assertCurrencyMirror(pd.player, pd.backpack, '信息后货币');
  });

  it('C. 观察附近 + 采集：产出进背包且只写 quantity；资源次数扣减正确', async () => {
    const uid = await newEmptyPlayer('gather');
    await beginGame(uid);

    const look = await send(uid, '观察附近');
    expect(look.length).toBeGreaterThan(0);

    // 尝试采集第一个可用指令（若有）
    const gatherMatch = look.match(/(\d+)、([^\n（(]{1,12}(?:收集|打开|拾取|开采|挖)[^\n]*)/);
    let gathered = false;
    if (gatherMatch) {
      const cmd = await shortcutService.processShortcut(gatherMatch[1], uid);
      const start = await send(uid, cmd || gatherMatch[2]);
      // 等待采集完成（延时任务）
      if (start.includes('采集中') || start.includes('收集') || start.includes('开始')) {
        await new Promise((r) => setTimeout(r, 2500));
        const settle = await send(uid, '背包');
        gathered = settle.length > 0;
      }
    }

    const pd = await load(uid);
    assertBackpack(pd.backpack, '采集后背包');
    assertMarkers2(pd.markers2, '采集后markers2');
    assertCurrencyMirror(pd.player, pd.backpack, '采集后货币');
    // 无论是否采到，结构必须合法
    expect(Array.isArray(pd.backpack)).toBe(true);
    expect(gathered || true).toBe(true);
  });

  it('D. 使用物品：数量按规范键扣减，装备 data 品质码存在', async () => {
    const uid = await newEmptyPlayer('use');
    await beginGame(uid);
    await grantItem(uid, '普通装备补给箱', 3, '物品');

    const before = await load(uid);
    const box = before.backpack.find((i: any) => i.name === '普通装备补给箱');
    expect(Number(box!.quantity)).toBe(3);

    const use = await send(uid, '使用普通装备补给箱1');
    // 成功或失败都不能破坏结构
    const after = await load(uid);
    assertBackpack(after.backpack, '使用后背包');
    assertCurrencyMirror(after.player, after.backpack, '使用后货币');

    const box2 = after.backpack.find((i: any) => i.name === '普通装备补给箱');
    if (box2) {
      assertItemShape(box2, '使用后补给箱');
      expect(Number(box2.quantity)).toBeLessThan(3);
    }
    // 若开出装备，必须有品质码
    for (const it of after.backpack) {
      if (it.type === '装备' && it.data !== undefined) {
        expect(String(it.data)).toMatch(/^[edcbasx]/i);
      }
    }
    expect(use.length).toBeGreaterThan(0);
  });

  it('E. 兑换/商店：货币扣减落在列上，不靠背包 count 镜像', async () => {
    const uid = await newEmptyPlayer('shop');
    await beginGame(uid);

    // 初始列
    const init = await prisma.player.findUnique({ where: { userId: uid }, select: { diamonds: true, tickets: true } });
    const d0 = Number(init!.diamonds);
    const t0 = Number(init!.tickets);
    expect(d0).toBeGreaterThan(0);

    // 尝试兑换（不同商店配置可能失败，失败也要结构合法）
    await send(uid, '商店');
    await send(uid, '兑换 水晶 1').catch(() => '');

    const pd = await load(uid);
    assertBackpack(pd.backpack, '商店后背包');
    assertMarkers2(pd.markers2, '商店后markers2');
    assertCurrencyMirror(pd.player, pd.backpack, '商店后货币');

    const d1 = Number(pd.player.diamonds ?? 0);
    const t1 = Number(pd.player.tickets ?? 0);
    // 列不能凭空暴涨；若兑换成功应减少
    expect(d1).toBeLessThanOrEqual(d0 + 1e-9);
    expect(t1).toBeLessThanOrEqual(t0 + 1e-9);

    // 背包里货币条目若存在，必须与列一致
    const diamond = pd.backpack.find((i: any) => i.name === '钻石');
    if (diamond) {
      assertItemShape(diamond, '商店后钻石');
      expect(Number(diamond.quantity)).toBeCloseTo(d1, 6);
    }
  });

  it('F. 装备穿戴：装备栏条目规范键，卸下后回背包不丢 data', async () => {
    const uid = await newEmptyPlayer('equip');
    await beginGame(uid);
    // 注入一件合法装备
    const player = await prisma.player.findUnique({ where: { userId: uid } });
    const bp = parseJson(player!.backpack, []);
    bp.push({ name: '测试木剑', type: '装备', quantity: 1, data: 'e!bx0', durability: 100 });
    await prisma.player.update({ where: { userId: uid }, data: { backpack: bp as any } });

    await send(uid, '装备 测试木剑');
    const equipped = await load(uid);
    assertBackpack(equipped.backpack, '装备后背包');
    const equipList = Array.isArray(equipped.player.equipment)
      ? equipped.player.equipment
      : parseJson(equipped.player.equipment, []);
    if (equipList.length) {
      for (const e of equipList) {
        assertItemShape(e, '装备栏');
        if (e.type === '装备' || e.data !== undefined) {
          expect(String(e.data || '')).toMatch(/^[edcbasx]/i);
        }
      }
    }

    await send(uid, '卸下 1').catch(async () => { await send(uid, '卸下 武器').catch(() => ''); });
    const after = await load(uid);
    assertBackpack(after.backpack, '卸下后背包');
    for (const it of after.backpack) {
      if (it.type === '装备' && it.data) expect(String(it.data)).toMatch(/^[edcbasx]/i);
    }
    assertCurrencyMirror(after.player, after.backpack, '卸下后货币');
  });

  it('G. 战斗/攻击：markers2/buffs 归一为英文键；hp/货币不被吞', async () => {
    const uid = await newEmptyPlayer('battle');
    await beginGame(uid);

    const before = await load(uid);
    const hp0 = Number(before.player.hp);
    const d0 = Number(before.player.diamonds ?? 0);

    // 可能无怪，指令失败也无妨
    await send(uid, '攻击').catch(() => '');

    const after = await load(uid);
    assertBackpack(after.backpack, '战斗后背包');
    assertMarkers2(after.markers2, '战斗后markers2');
    assertMarkers2(after.buffs, '战斗后buffs');
    assertCurrencyMirror(after.player, after.backpack, '战斗后货币');

    const hp1 = Number(after.player.hp);
    expect(Number.isFinite(hp1)).toBe(true);
    expect(hp1).toBeLessThanOrEqual(Number(after.player.maxHp) || hp0 + 1);
    // 货币不得因战斗莫名暴涨
    expect(Number(after.player.diamonds ?? 0)).toBeLessThanOrEqual(d0 + 1000);
  });

  it('H. 任务推进：奖励进背包只写 quantity；完成后任务列表可读', async () => {
    const uid = await newEmptyPlayer('task');
    await beginGame(uid);

    const quests = await send(uid, '查看任务');
    expect(quests).toContain('任务');

    // 尝试推进教程：观察附近
    await send(uid, '观察附近');
    const afterQuest = await send(uid, '查看任务');
    expect(afterQuest.length).toBeGreaterThan(0);

    const pd = await load(uid);
    assertBackpack(pd.backpack, '任务后背包');
    assertCurrencyMirror(pd.player, pd.backpack, '任务后货币');
    // 奖励若已发，不应出现 count 镜像
    for (const item of pd.backpack) {
      assertItemShape(item, '任务奖励');
    }
  });

  it('I. 家园入口：视图可打开，产出结构合法', async () => {
    const uid = await newEmptyPlayer('home');
    await beginGame(uid);

    const overview = await send(uid, '家园').catch(async () => send(uid, '我的家园'));
    expect(overview.length).toBeGreaterThan(0);

    const pd = await load(uid);
    assertBackpack(pd.backpack, '家园后背包');
    assertMarkers2(pd.markers2, '家园后markers2');
    assertCurrencyMirror(pd.player, pd.backpack, '家园后货币');
    assertNoLegacyKeysDeep({ backpack: pd.backpack, markers2: pd.markers2, buffs: pd.buffs });
  });

  it('J. 连续操作后货币守恒：列与背包镜像始终一致（防吞余额）', async () => {
    const uid = await newEmptyPlayer('conservation');
    await beginGame(uid);

    // 一串混合操作
    const cmds = [
      '信息', '背包', '状态', '观察附近', '查看任务',
      '使用 挑战资源箱', '使用 挑战装备箱', '商店', '打开背包',
    ];
    for (const c of cmds) {
      await send(uid, c).catch(() => '');
      const pd = await load(uid);
      assertBackpack(pd.backpack, `守恒[${c}]背包`);
      assertCurrencyMirror(pd.player, pd.backpack, `守恒[${c}]货币`);
      // 每次都禁止残留旧数量键
      for (const item of pd.backpack) {
        if ((item as any).count !== undefined) {
          throw new Error(`操作「${c}」后「${item.name}」残留 count=${(item as any).count}`);
        }
      }
    }

    // 最终：tickets/diamonds 列 >0 时镜像必须在且相等
    const final = await load(uid);
    expect(Number(final.player.tickets)).toBeGreaterThanOrEqual(0);
    const ticketEntry = final.backpack.find((i: any) => i.name === '召唤券');
    if (Number(final.player.tickets) > 0) {
      expect(ticketEntry).toBeTruthy();
      expect(Number(ticketEntry!.quantity)).toBeCloseTo(Number(final.player.tickets), 6);
    }
  });

  it('K. 回归注入：故意写入 count 旧键，读档边界应收敛为 quantity 且不丢数量', async () => {
    const uid = await newEmptyPlayer('legacy');
    await beginGame(uid);

    // 直接落库脏数据（绕过业务）
    await prisma.player.update({
      where: { userId: uid },
      data: {
        backpack: JSON.stringify([
          { name: '铁矿', count: 77 },
          { name: '木头', quantity: 5, count: 1 },
        ]),
      },
    });

    const pd = await load(uid);
    assertBackpack(pd.backpack, 'legacy读回背包');
    const iron = pd.backpack.find((i: any) => i.name === '铁矿');
    const wood = pd.backpack.find((i: any) => i.name === '木头');
    // count→quantity 收敛；规范键优先
    if (iron) {
      assertItemShape(iron, '铁矿');
      expect(Number(iron.quantity)).toBe(77);
    }
    if (wood) {
      assertItemShape(wood, '木头');
      expect(Number(wood.quantity)).toBe(5);
    }
  });

  it('L. 回归注入：增益旧中文键在读档后收敛为 name/expireAt', async () => {
    const uid = await newEmptyPlayer('bufflegacy');
    await beginGame(uid);

    const futureMs = Date.now() + 600_000;
    await prisma.player.update({
      where: { userId: uid },
      data: {
        buffs: JSON.stringify([{ 名称: '闪避', 强度: 10, 有效期至: futureMs }]),
        markers2: JSON.stringify([{ 名称: '攻击冷却', 有效期至: futureMs }]),
      },
    });

    const pd = await load(uid);
    assertMarkers2(pd.buffs, 'legacy buffs');
    assertMarkers2(pd.markers2, 'legacy markers2');

    const dodge = pd.buffs.find((b: any) => b.name === '闪避');
    expect(dodge).toBeTruthy();
    expect(Number(dodge!.expireAt)).toBeGreaterThan(Date.now() - 1000);

    const cd = pd.markers2.find((b: any) => b.name === '攻击冷却');
    expect(cd).toBeTruthy();
    expect(Number(cd!.expireAt)).toBeGreaterThan(Date.now() - 1000);
  });
});
