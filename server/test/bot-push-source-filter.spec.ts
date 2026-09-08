import { ChatService } from '../src/modules/chat/chat.service';
import { CommandSourceRegistry } from '../src/modules/command/command-source.registry';
import { CommandSource } from '../src/modules/command/interfaces/command.interface';

/**
 * bot:push 回推来源过滤回归（2026-09-08 Bug 修复）：
 * ChatService.broadcastSystem 此前仅凭「senderId 绑定了 QQ 号」就向 bot 房间推
 * bot:push，导致玩家在网页端操作的延时结果（移动到达/采集完成等）被 AstrBot
 * 错推到 QQ 群。修复约定：按「用户最后一次发指令的渠道」归属判定（无时间窗口）
 * ——QQ 发的指令延时结果永远推 QQ；切回网页端发指令后立即停止回推。
 * 本套用例锁定：
 * 1. QQ 来源指令后 → 推 bot:push；
 * 2. 网页来源指令后 → 不推；
 * 3. 无登记记录 → 不推（宁可漏推不错推）；
 * 4. 渠道翻转：QQ→网页 停推，网页→QQ 恢复推；
 * 5. registry 未注入（测试桩回落）→ 不推。
 */

function makeChatService(overrides: Partial<Record<string, any>> = {}, registry?: CommandSourceRegistry) {
  const pushed: any[] = [];
  const emitToBot = jest.fn((event: string, payload: any) => {
    if (event === 'bot:push') pushed.push(payload);
  });
  const prismaStub: any = {
    channel: {
      findUnique: jest.fn(async () => ({ id: 1, name: '世界频道' })),
    },
    chatMessage: {
      create: jest.fn(async ({ data }: any) => ({
        id: 101,
        ...data,
        createdAt: new Date('2026-09-08T12:00:00Z'),
        sender: { id: data.senderId, username: 'tester', nickname: 'tester' },
      })),
    },
    user: {
      findUnique: jest.fn(async () => ({ qqNumber: '10001' })),
      ...(overrides.user || {}),
    },
  };
  const statsStub: any = {};
  const svc = new ChatService(prismaStub, statsStub, registry as any);
  const serverStub: any = { to: jest.fn(() => ({ emit: emitToBot })) };
  svc.setServer(serverStub);
  return { svc, pushed, prismaStub };
}

describe('bot:push 回推来源过滤', () => {
  const uid = 2;

  test('QQ 来源指令后：延时结算消息推 bot:push', async () => {
    const registry = new CommandSourceRegistry();
    registry.mark(uid, CommandSource.ASTRBOT);
    const { svc, pushed } = makeChatService({}, registry);
    await svc.broadcastSystem('世界频道', '伊卡洛斯来到了火山', uid);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ qqNumber: '10001', senderId: uid });
  });

  test('网页来源指令后：不推 bot:push（公屏广播不受影响）', async () => {
    const registry = new CommandSourceRegistry();
    registry.mark(uid, CommandSource.WEB);
    const { svc, pushed } = makeChatService({}, registry);
    await svc.broadcastSystem('世界频道', '伊卡洛斯来到了火山', uid);
    expect(pushed).toHaveLength(0);
  });

  test('无登记记录（如进程重启后）：不推 bot:push', async () => {
    const registry = new CommandSourceRegistry();
    const { svc, pushed } = makeChatService({}, registry);
    await svc.broadcastSystem('世界频道', '伊卡洛斯采集完成', uid);
    expect(pushed).toHaveLength(0);
  });

  test('渠道翻转：QQ 发过再网页发 → 停推；再回 QQ 发 → 恢复推', async () => {
    const registry = new CommandSourceRegistry();
    registry.mark(uid, CommandSource.ASTRBOT);
    const { svc, pushed } = makeChatService({}, registry);

    await svc.broadcastSystem('世界频道', 'QQ 指令的延时结果', uid);
    expect(pushed).toHaveLength(1);

    registry.mark(uid, CommandSource.WEB);
    await svc.broadcastSystem('世界频道', '网页指令的延时结果', uid);
    expect(pushed).toHaveLength(1); // 未新增

    registry.mark(uid, CommandSource.ASTRBOT);
    await svc.broadcastSystem('世界频道', '又回 QQ 玩的延时结果', uid);
    expect(pushed).toHaveLength(2);
  });

  test('registry 未注入（测试桩回落）：不推 bot:push', async () => {
    const { svc, pushed } = makeChatService();
    await svc.broadcastSystem('世界频道', '伊卡洛斯来到了火山', uid);
    expect(pushed).toHaveLength(0);
  });

  test('未绑定 QQ 的玩家（即使 QQ 来源登记过）：不推 bot:push', async () => {
    const registry = new CommandSourceRegistry();
    registry.mark(uid, CommandSource.ASTRBOT);
    const { svc, pushed } = makeChatService({
      user: { findUnique: jest.fn(async () => ({ qqNumber: null })) },
    }, registry);
    await svc.broadcastSystem('世界频道', '伊卡洛斯来到了火山', uid);
    expect(pushed).toHaveLength(0);
  });
});
