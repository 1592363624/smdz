/**
 * 新玩家开局流程 端到端集成测试（真实远程 MySQL）
 * 复刻原版游玩链路：门禁列表 → 数字选择预览 → 1 确认开局（提示链） → 查看任务。
 * 对应原版 _主程序.ecode：门禁 L11464-11480、预览 L786-792、确认 L676-760、
 * 每条消息结算段 L11686-11821（登录奖励/教程领取）。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CommandService } from '../src/modules/command/command.service';
import { ShortcutService } from '../src/modules/game/shortcut.service';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CommandContext, CommandSource } from '../src/modules/command/interfaces/command.interface';

jest.setTimeout(120000);

describe('新玩家开局流程（真实远程库端到端）', () => {
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
      try { await prisma.user.delete({ where: { id: uid } }); } catch { /* 已删 */ }
    }
    if (app) await app.close();
  });

  async function newEmptyPlayer(tag: string) {
    const username = `e2e_onboard_${tag}_${stamp()}`;
    const user = await prisma.user.create({ data: { username, password: 'e2e_test', role: 'USER' } });
    createdUserIds.push(user.id);
    await prisma.player.create({
      data: {
        userId: user.id, mapId: 1, name: `开局测试${tag}`,
        hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        level: 1, dodge: 10,
        markers: '{}', markers2: '[]', buffs: '[]',
        backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
      },
    });
    return user.id;
  }

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

  it('门禁列表：两列编号菜单 + 数字临时输入', async () => {
    const uid = await newEmptyPlayer('gate');
    const w = await send(uid, '使魔大战');
    expect(w).toContain('选择你的第一个使魔来开始游戏：');
    expect(w).toContain('发送数字来进行选择');
    expect(w).toContain('1、花园猫');
    expect(w).toContain('21、军姬X');
    // 数字 13 → 选择使魔伊卡洛斯（临时输入替换）
    const replaced = await shortcutService.processShortcut('13', uid);
    expect(replaced).toBe('选择使魔伊卡洛斯');
  });

  it('完整开局链：预览 → 确认(登录奖励+教程+开局正文+提示+升级) → 查看任务', async () => {
    const uid = await newEmptyPlayer('chain');

    // 1) 门禁
    await send(uid, '使魔大战');
    // 2) 发数字 → 预览（原版 L786-792）
    const replaced = await shortcutService.processShortcut('13', uid);
    expect(replaced).toBe('选择使魔伊卡洛斯');
    const preview = await send(uid, replaced);
    expect(preview).toContain('伊卡洛斯(好感0)');
    expect(preview).toContain('技能等级:1(0/1)');
    expect(preview).toContain('定位:输出    专精:冰冻');
    expect(preview).toContain('1、选择\t\t2、返回');

    // 3) 发 1 → 选择使魔确认伊卡洛斯（完整提示链）
    const confirmCmd = await shortcutService.processShortcut('1', uid);
    expect(confirmCmd).toBe('选择使魔确认伊卡洛斯');
    const confirmed = await send(uid, confirmCmd);

    // 登录奖励块在最上（首次结算=加入游戏第1天 + 挑战三箱）
    expect(confirmed).toContain('使魔挑战第1层每日奖励:1的挑战装备箱和挑战物资箱、资源箱加入游戏第1天');
    expect(confirmed).toContain('今日登陆奖励:');
    expect(confirmed).toContain('5史诗强化券、10活力');
    // 教程领取提示（进阶在上、新手在下）
    expect(confirmed).toContain('领取了进阶教程，可以发送“查看任务”来查看');
    expect(confirmed).toContain('领取了新手教程，可以发送“查看任务”来查看');
    expect(confirmed.indexOf('领取了进阶教程')).toBeLessThan(confirmed.indexOf('领取了新手教程'));
    // 开局正文
    expect(confirmed).toContain('选择为伊卡洛斯开始游戏');
    expect(confirmed).toContain(' 1、查看任务');
    // 功能提示 + 等级提升
    expect(confirmed).toContain('【你的训练器现在可以使用了】');
    expect(confirmed).toContain('【你现在可以使用凭证了】');
    expect(confirmed).toContain('等级提升了！');
    // 顺序：正文 < 训练器提示 < 凭证提示 < 等级提升
    expect(confirmed.indexOf('选择为伊卡洛斯开始游戏'))
      .toBeLessThan(confirmed.indexOf('【你的训练器现在可以使用了】'));
    expect(confirmed.indexOf('【你的训练器现在可以使用了】'))
      .toBeLessThan(confirmed.indexOf('【你现在可以使用凭证了】'));
    expect(confirmed.indexOf('【你现在可以使用凭证了】'))
      .toBeLessThan(confirmed.indexOf('等级提升了！'));

    // 玩家状态：已开局、教程=3、签到计数=1、背包有三箱
    const data = await playerService.getPlayerData(uid);
    expect(data.player.type).toBe('伊卡洛斯');
    expect(Number(data.markers['教程'] || 0)).toBe(3);
    expect(Number(data.markers['签到'] || 0)).toBe(1);
    expect(data.markers['签到时间']).toBeTruthy();
    const names = data.backpack.map((i: any) => i.name);
    expect(names).toContain('挑战装备箱');
    expect(names).toContain('挑战资源箱');
    expect(names).toContain('史诗强化券');

    // 4) 发 1 → 查看任务（临时输入），列表为原版“你现在接受了以下任务”格式
    const viewCmd = await shortcutService.processShortcut('1', uid);
    expect(viewCmd).toBe('查看任务');
    const questView = await send(uid, viewCmd);
    expect(questView).toContain('你现在接受了以下任务');
    expect(questView).toContain('1、新手教程');
    expect(questView).toContain('2、进阶教程');

    // 5) 发 1 → 查看任务1，详情为原版 显示任务 格式（玩家名/任务名/说明/要求/奖励）
    const detailCmd = await shortcutService.processShortcut('1', uid);
    expect(detailCmd).toBe('查看任务1');
    const questDetail = await send(uid, detailCmd);
    expect(questDetail).toContain('新手教程');
    expect(questDetail).toContain('跟随教程指引了解游戏，现在发送“观察附近”来查看自己所处位置。');
    expect(questDetail).toContain('◆需要发送“观察附近”');
    expect(questDetail).toContain('·完成可获得:优秀装备补给箱x1.01、麻醉枪x101');
    expect(questDetail).toContain('·完成任务后奖励自动发放。');
    expect(questDetail).not.toContain('📋');
  });

  it('同日第二次指令不重复发登录奖励；提示冷却600秒内不重复', async () => {
    const uid = await newEmptyPlayer('cooldown');
    await send(uid, '使魔大战');
    await send(uid, '确认伊卡洛斯');
    const first = await send(uid, '查看任务');
    // 登录奖励只发一次
    expect(first).not.toContain('今日登陆奖励');
    // 训练器/凭证提示进入600秒冷却
    expect(first).not.toContain('【你的训练器现在可以使用了】');
    expect(first).not.toContain('【你现在可以使用凭证了】');
  });
});
