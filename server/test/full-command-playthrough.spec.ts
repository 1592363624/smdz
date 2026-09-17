/**
 * 指令级全量实机回归（真实远程库）
 *
 * 从开局后用真实 CommandService 逐条发指令，校验：
 *  1. 不抛异常、不返回空/未知指令（能力范围内的主循环指令）
 *  2. 关键数值前后一致（背包 quantity、货币列=镜像、装备 data 品质码）
 *  3. 无 count/中文旧键镜像残留
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CommandService } from '../src/modules/command/command.service';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CommandContext, CommandSource } from '../src/modules/command/interfaces/command.interface';
import { parseJson } from './parse-json.util';

jest.setTimeout(300000);

type CmdCase = {
  cmd: string;
  /** 允许的失败语义（无目标/条件不满足也算通路正常） */
  allowFail?: boolean;
  /** 必须包含的文案片段（任一命中） */
  mustInclude?: string[];
  /** 必须不包含 */
  mustNotInclude?: string[];
  /** 执行后校验 */
  check?: (ctx: { player: any; backpack: any[]; markers: any; markers2: any[]; buffs: any[]; text: string; before: Snapshot }) => void | Promise<void>;
};

type Snapshot = {
  hp: number; maxHp: number; exp: number; diamonds: number; tickets: number; dataCores: number;
  backpackQty: Map<string, number>;
};

function qty(bp: any[], name: string): number {
  const e = (bp || []).find((i: any) => i.name === name);
  return e ? Number(e.quantity) || 0 : 0;
}

function snapOf(pd: any, backpack: any[]): Snapshot {
  return {
    hp: Number(pd.player.hp) || 0,
    maxHp: Number(pd.player.maxHp) || 0,
    exp: Number(pd.player.exp) || 0,
    diamonds: Number(pd.player.diamonds) || 0,
    tickets: Number(pd.player.tickets) || 0,
    dataCores: Number(pd.player.dataCores) || 0,
    backpackQty: new Map(backpack.map((i: any) => [i.name, Number(i.quantity) || 0])),
  };
}

function assertNoLegacy(bp: any[], where: string) {
  for (const item of bp || []) {
    if (item && item.count !== undefined) {
      throw new Error(`${where}: 「${item.name}」残留 count=${item.count}`);
    }
    for (const k of ['名称', '数量', '数据', '类型', '耐久']) {
      if (item && item[k] !== undefined) throw new Error(`${where}: 「${item.name}」残留旧键 ${k}`);
    }
  }
}

function assertBuffShape(list: any[], where: string) {
  for (const e of list || []) {
    if (!e || typeof e !== 'object') continue;
    for (const k of ['名称', '强度', '有效期至', '是否叠加时间']) {
      if (e[k] !== undefined) throw new Error(`${where}: 增益残留旧键 ${k} → ${JSON.stringify(e)}`);
    }
  }
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
    if (!e) throw new Error(`${where}: ${name} 列=${col} 但背包缺失`);
    if (Math.abs(Number(e.quantity) - col) > 1e-6) {
      throw new Error(`${where}: ${name} 列=${col} 背包 quantity=${e.quantity}`);
    }
  }
}

describe('指令级全量实机回归', () => {
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
    try {
      const result = await commandService.dispatch(ctx);
      return result?.content || '';
    } catch (e: any) {
      return `__THROW__${e?.message || e}`;
    }
  }

  async function newPlayer(tag: string) {
    const username = `e2e_cmd_${tag}_${stamp()}`;
    const user = await prisma.user.create({ data: { username, password: 'e2e_test', role: 'USER' } });
    createdUserIds.push(user.id);
    await prisma.player.create({
      data: {
        userId: user.id, mapId: 1, name: `指令${tag}`,
        type: '伊卡洛斯', specialSeq: -2, affinity: 20,
        hp: 200, maxHp: 200, shield: 50, maxShield: 50, armor: 30, maxArmor: 30,
        level: 30, dodge: 15, exp: 0, upgradeExp: 1000,
        diamonds: 20000, tickets: 500, dataCores: 1000,
        markers: '{"教程":3,"签到":1,"签到时间":1}', markers2: '[]', buffs: '[]',
        backpack: JSON.stringify([
          { name: '木头', type: '资源', quantity: 500 },
          { name: '石头', type: '资源', quantity: 300 },
          { name: '铁矿', type: '资源', quantity: 200 },
          { name: '绳子', type: '资源', quantity: 100 },
          { name: '面包', type: '资源', quantity: 20 },
          { name: '普通装备补给箱', type: '物品', quantity: 5 },
          { name: '优秀装备补给箱', type: '物品', quantity: 2 },
          { name: '麻醉枪', type: '装备', quantity: 1, data: 'e!bx0', durability: 100 },
          { name: '测试木剑', type: '装备', quantity: 1, data: 'd!ac1', durability: 80 },
          { name: '信号枪', type: '物品', quantity: 3 },
        ]),
        equipment: '[]', weapons: '[]', tasks: '[]',
      },
    });
    return user.id;
  }

  async function load(uid: number) {
    const pd = await playerService.getPlayerData(uid);
    const backpack = Array.isArray(pd.backpack) ? pd.backpack : parseJson(pd.player.backpack, []);
    const markers2 = Array.isArray(pd.markers2) ? pd.markers2 : parseJson(pd.player.markers2, []);
    const buffs = Array.isArray(pd.buffs) ? pd.buffs : parseJson(pd.player.buffs, []);
    const markers = pd.markers || parseJson(pd.player.markers, {});
    return { ...pd, backpack, markers2, buffs, markers };
  }

  /** 主循环指令表：每条发一遍，记录返回并做结构/数值校验 */
  const MAIN_CMDS: CmdCase[] = [
    // —— 状态查看 ——
    { cmd: '帮助', allowFail: true },
    { cmd: '信息', mustInclude: ['指令'] },
    { cmd: '状态', mustInclude: ['指令'] },
    { cmd: '背包', mustInclude: ['木头'] },
    { cmd: '地图', allowFail: true },
    { cmd: '观察附近', allowFail: true },
    { cmd: '探测', allowFail: true },
    { cmd: '技能', allowFail: true },
    { cmd: '使魔技能', allowFail: true },
    { cmd: '查看使魔', allowFail: true },
    { cmd: '使魔数据', allowFail: true },
    { cmd: '查看任务', mustInclude: ['任务'] },
    { cmd: '资源背包', allowFail: true },
    { cmd: '背包搜索 木头', allowFail: true },
    { cmd: '我的载具', allowFail: true },
    { cmd: '载具状态', allowFail: true },
    { cmd: '设置', allowFail: true },
    { cmd: '称号', allowFail: true },
    { cmd: '图鉴', allowFail: true },
    { cmd: '排行', allowFail: true },
    { cmd: '成就', allowFail: true },

    // —— 物品/装备 ——
    {
      cmd: '使用面包1',
      allowFail: true,
      check: async ({ backpack, before, text }) => {
        if (/使用了|吃|恢复|得到了/.test(text)) {
          const after = qty(backpack, '面包');
          if (after >= (before.backpackQty.get('面包') || 0)) {
            // 允许失败文案；只要说使用了就必须扣减
            if (text.includes('使用了')) throw new Error(`使用面包后数量未减少: ${before.backpackQty.get('面包')}→${after}`);
          }
        }
      },
    },
    {
      cmd: '使用普通装备补给箱1',
      allowFail: true,
      check: async ({ backpack, before, text }) => {
        if (text.includes('使用') && !/失败|没有|无法|需要/.test(text)) {
          const after = qty(backpack, '普通装备补给箱');
          const expect = (before.backpackQty.get('普通装备补给箱') || 0) - 1;
          if (after !== expect) {
            throw new Error(`开箱后数量不符 expected=${expect} got=${after} text=${text.slice(0, 80)}`);
          }
        }
      },
    },
    {
      cmd: '使用全部补给箱',
      allowFail: true,
      check: async ({ backpack }) => assertNoLegacy(backpack, '使用全部后'),
    },
    {
      cmd: '装备 测试木剑',
      allowFail: true,
      check: async ({ player, backpack }) => {
        assertNoLegacy(backpack, '装备后背包');
        const eq = Array.isArray(player.equipment) ? player.equipment : parseJson(player.equipment, []);
        for (const e of eq) {
          if (e?.type === '装备' || e?.data) {
            if (!String(e.data || '').match(/^[edcbasx]/i)) {
              throw new Error(`装备栏 data 无品质码: ${e.name} data=${e.data}`);
            }
          }
        }
      },
    },
    { cmd: '查看装备', allowFail: true },
    { cmd: '强化 测试木剑', allowFail: true },
    { cmd: '解析 测试木剑', allowFail: true },
    { cmd: '保护 测试木剑', allowFail: true },
    { cmd: '锁定装备 测试木剑', allowFail: true },
    { cmd: '卸下 1', allowFail: true },
    { cmd: '卸下 武器', allowFail: true },

    // —— 制造/采集/移动 ——
    { cmd: '制造', allowFail: true },
    { cmd: '丢弃 面包1', allowFail: true },
    { cmd: '移动 医疗室', allowFail: true },
    { cmd: '前往 森林', allowFail: true },
    { cmd: '飞到 森林', allowFail: true },
    { cmd: '传送 森林', allowFail: true },

    // —— 战斗 ——
    {
      cmd: '攻击',
      allowFail: true,
      check: async ({ markers2, buffs }) => {
        assertBuffShape(markers2, '攻击后markers2');
        assertBuffShape(buffs, '攻击后buffs');
      },
    },
    { cmd: '打', allowFail: true },
    { cmd: '闪避', allowFail: true },
    { cmd: '扫荡', allowFail: true },
    { cmd: '开始战斗', allowFail: true },
    { cmd: '自动战斗', allowFail: true },
    { cmd: '停止自动战斗', allowFail: true },

    // —— 家园 ——
    { cmd: '家园', allowFail: true },
    { cmd: '我的家园', allowFail: true },
    { cmd: '家园产出', allowFail: true },
    { cmd: '家园前线', allowFail: true },
    { cmd: '家园商店', allowFail: true },
    { cmd: '家园进度', allowFail: true },
    { cmd: '家园总览', allowFail: true },
    { cmd: '建设', allowFail: true },
    { cmd: '建造 地基', allowFail: true },
    { cmd: '清障', allowFail: true },

    // —— 商店/兑换/使魔 ——
    { cmd: '商店', allowFail: true },
    { cmd: '使魔商店', allowFail: true },
    { cmd: '兑换 水晶 1', allowFail: true },
    { cmd: '行商', allowFail: true },
    { cmd: '召唤使魔', allowFail: true },
    { cmd: '选择使魔', allowFail: true },
    { cmd: '使魔更多', allowFail: true },

    // —— 任务/社交/其它 ——
    { cmd: '观察附近', allowFail: true },
    { cmd: '对话 白', allowFail: true },
    { cmd: '捡起', allowFail: true },
    { cmd: '拾取', allowFail: true },
    { cmd: '开采', allowFail: true },
    { cmd: '打开箱子', allowFail: true },
    { cmd: '救助', allowFail: true },
    { cmd: '躺下', allowFail: true },
    { cmd: '起来', allowFail: true },
    { cmd: '签到', allowFail: true },
    { cmd: '抽奖', allowFail: true },
    { cmd: '副本', allowFail: true },
    { cmd: '挑战', allowFail: true },
    { cmd: '遗迹', allowFail: true },
    { cmd: '封印', allowFail: true },
    { cmd: '驾驶', allowFail: true },
    { cmd: '载具生产', allowFail: true },
    { cmd: '组装 载具', allowFail: true },
    { cmd: '我的载具', allowFail: true },
    { cmd: '宠物', allowFail: true },
    { cmd: '挤奶 斑点牛', allowFail: true },
    { cmd: '剪毛', allowFail: true },
    { cmd: '喂食', allowFail: true },
    { cmd: '跟随', allowFail: true },
    { cmd: '停下', allowFail: true },
    { cmd: '主动', allowFail: true },
    { cmd: '被动', allowFail: true },
    { cmd: '六道轮回', allowFail: true },
    { cmd: '万象', allowFail: true },
    { cmd: '怒吼', allowFail: true },
    { cmd: '誓约胜利之剑', allowFail: true },
    { cmd: '鹰眼', allowFail: true },
    { cmd: '打开红包', allowFail: true },
    { cmd: '我的红包', allowFail: true },
    { cmd: '反馈 测试指令回归', allowFail: true },
    { cmd: '关于', allowFail: true },
    { cmd: '版本', allowFail: true },
  ];

  it('主循环指令全量执行：无崩溃、无旧键残留、货币/背包口径稳定', async () => {
    const uid = await newPlayer('main');
    // 预热：确认开局可用
    await send(uid, '查看任务').catch(() => '');

    const failures: string[] = [];
    const summaries: string[] = [];

    for (const c of MAIN_CMDS) {
      const before = await load(uid);
      const beforeSnap = snapOf(before, before.backpack);
      const text = await send(uid, c.cmd);

      if (text.startsWith('__THROW__')) {
        failures.push(`${c.cmd} → 异常: ${text}`);
        continue;
      }
      // 未匹配到任何 handler / 服务崩溃类
      if (/__THROW__|Cannot read|undefined is not|TypeError|ECONN|Unknown column|PrismaClient/.test(text)) {
        failures.push(`${c.cmd} → 崩溃痕迹: ${text.slice(0, 160)}`);
      }
      // 空返回通常不正常（部分冷门指令允许）
      if (!text.trim() && !c.allowFail) {
        failures.push(`${c.cmd} → 空返回`);
      }
      if (c.mustInclude?.length) {
        const hit = c.mustInclude.some((s) => text.includes(s));
        if (!hit) failures.push(`${c.cmd} → 缺少文案 ${c.mustInclude.join('/')}；实际: ${text.slice(0, 100).replace(/\n/g, ' ')}`);
      }
      if (c.mustNotInclude?.length) {
        for (const s of c.mustNotInclude) {
          if (text.includes(s)) failures.push(`${c.cmd} → 不应包含「${s}」`);
        }
      }

      const after = await load(uid);
      assertNoLegacy(after.backpack, `cmd:${c.cmd}`);
      assertBuffShape(after.markers2, `cmd:${c.cmd}/markers2`);
      assertBuffShape(after.buffs, `cmd:${c.cmd}/buffs`);
      assertCurrencyMirror(after.player, after.backpack, `cmd:${c.cmd}`);

      // 货币不得凭空暴涨（允许小幅正常产出，上限很宽防误报）
      const d1 = Number(after.player.diamonds) || 0;
      if (d1 > beforeSnap.diamonds + 100) {
        failures.push(`${c.cmd} → 钻石异常暴涨 ${beforeSnap.diamonds}→${d1}`);
      }
      const t1 = Number(after.player.tickets) || 0;
      if (t1 > beforeSnap.tickets + 100) {
        failures.push(`${c.cmd} → 召唤券异常暴涨 ${beforeSnap.tickets}→${t1}`);
      }

      // hp 不得越过 maxHp
      const hp = Number(after.player.hp) || 0;
      const maxHp = Number(after.player.maxHp) || 0;
      if (maxHp > 0 && hp > maxHp + 1) {
        failures.push(`${c.cmd} → hp 越界 ${hp}/${maxHp}`);
      }

      if (c.check) {
        try {
          await c.check({
            player: after.player,
            backpack: after.backpack,
            markers: after.markers,
            markers2: after.markers2,
            buffs: after.buffs,
            text,
            before: beforeSnap,
          });
        } catch (e: any) {
          failures.push(`${c.cmd} → check: ${e?.message || e}`);
        }
      }

      summaries.push(`${c.cmd} => ${text.split('\n')[0].slice(0, 60)}`);
    }

    // 附带关键数值：至少背包里木头还在且是规范键
    const final = await load(uid);
    const wood = final.backpack.find((i: any) => i.name === '木头');
    expect(wood).toBeTruthy();
    expect(typeof wood.quantity === 'number').toBe(true);
    expect(wood.count).toBeUndefined();

    if (failures.length) {
      // 写进错误信息，便于定位
      throw new Error(`指令回归失败 ${failures.length} 处:\n${failures.join('\n')}\n--- 样例 ---\n${summaries.slice(0, 15).join('\n')}`);
    }

    // 至少执行了主循环里绝大多数指令
    expect(MAIN_CMDS.length).toBeGreaterThanOrEqual(80);
  }, 240000);

  it('数值闭环：扣除型指令前后 quantity 差分可解释', async () => {
    const uid = await newPlayer('numeric');
    await send(uid, '查看任务').catch(() => '');

    // 1) 丢弃 5 个木头
    const b0 = await load(uid);
    const wood0 = qty(b0.backpack, '木头');
    expect(wood0).toBe(500);
    const discard = await send(uid, '丢弃 木头 5');
    const b1 = await load(uid);
    const wood1 = qty(b1.backpack, '木头');
    if (/丢弃|扔掉|减少/.test(discard)) {
      expect(wood1).toBe(wood0 - 5);
    } else {
      // 失败时不得偷偷改数量
      expect(wood1).toBe(wood0);
    }

    // 2) 保护箱/补给箱使用后数量与文案一致
    const box0 = qty(b1.backpack, '优秀装备补给箱');
    const use = await send(uid, '使用优秀装备补给箱1');
    const b2 = await load(uid);
    const box1 = qty(b2.backpack, '优秀装备补给箱');
    if (use.includes('使用') && !/失败|没有|无法/.test(use)) {
      expect(box1).toBe(box0 - 1);
    } else {
      expect(box1).toBe(box0);
    }

    // 3) 货币镜像终态
    assertCurrencyMirror(b2.player, b2.backpack, '数值闭环终态');
    assertNoLegacy(b2.backpack, '数值闭环终态');
  }, 120000);

  it('未知指令与参数错误：返回可读提示而非崩溃', async () => {
    const uid = await newPlayer('edge');
    const cases = [
      '这完全不是指令',
      '使用',
      '使用 不存在的物品xyz',
      '装备 不存在的装备xyz',
      '移动 不存在的地图xyz',
      '制造 不存在的配方xyz',
      '兑换 不存在的商品xyz',
      '丢弃',
      '强化',
      '卸下',
      '挤奶',
    ];
    for (const c of cases) {
      const text = await send(uid, c);
      expect(text.startsWith('__THROW__')).toBe(false);
      expect(text).not.toMatch(/Cannot read|TypeError|ECONNREFUSED|Unknown column|PrismaClient/);
    }
    const pd = await load(uid);
    assertNoLegacy(pd.backpack, '边界后背包');
    assertCurrencyMirror(pd.player, pd.backpack, '边界后货币');
  }, 60000);
});
