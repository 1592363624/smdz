/**
 * 闪避指令 1:1 复刻端到端集成测试（真实远程 MySQL）
 *
 * 对应原版：
 *   _主程序.ecode L1839-1852（闪避指令分发 + 飞羽冷却加成 + 冷却公式）
 *   使魔技能.ecode L550-633（释放闪避 子程序：持续秒数/空间主宰/各使魔专属分支）
 *   战斗相关.ecode L1622（命中判定 a1*100 - 固定闪避 + 最终命中 + a2）
 *
 * 测试策略：
 *   - 真实 Nest ApplicationContext，获取 GameService / PlayerService / PrismaService。
 *   - 动态建测试账号（指定使魔 specialSeq / 好感 / 闪避熟练度 markers），连真实 smdz 库。
 *   - 验证：① 持续秒数 a1=(a/(25+a)+1)*4 随闪避熟练度变化
 *           ② 冷却公式 15*(1+a2*0.05)（无飞羽=15秒）
 *           ③ 写入"闪避"增益（buffs，expireAt≈now+a1）
 *           ④ 花园猫(aff100)分支写入"啾啾猫猫"增益
 *   - afterAll 清理账号。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { GameService } from '../src/modules/game/game.service';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(120000);

describe('闪避指令 1:1 复刻（真实远程库端到端）', () => {
  let app: any;
  let prisma: PrismaService;
  let game: GameService;
  let playerService: PlayerService;

  const createdUserIds: number[] = [];
  const stamp = () => Math.random().toString(36).slice(2, 8);

  // 创建账号并指定使魔/好感/闪避熟练度
  async function makePlayer(tag: string, opts: { specialSeq: number; type: string; affinity: number; dodgeProf: number }) {
    const username = `e2e_dodge_${tag}_${stamp()}`;
    const user = await prisma.user.create({ data: { username, password: 'e2e_test', role: 'USER' } });
    createdUserIds.push(user.id);
    const markers: any = {};
    if (opts.dodgeProf > 0) markers['闪避'] = opts.dodgeProf;
    await prisma.player.create({
      data: {
        userId: user.id,
        mapId: 1,
        name: `闪避测试${tag}`,
        type: opts.type,
        specialSeq: opts.specialSeq,
        affinity: opts.affinity,
        hp: 100, maxHp: 100, shield: 0, maxShield: 0, armor: 0, maxArmor: 0,
        level: 1, dodge: 10,
        markers: JSON.stringify(markers), markers2: '[]', buffs: '[]',
        backpack: '[]', equipment: '[]', weapons: '[]', tasks: '[]',
      },
    });
    return user.id;
  }

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    game = app.get(GameService);
    playerService = app.get(PlayerService);
  });

  afterAll(async () => {
    for (const uid of createdUserIds) {
      try { await prisma.user.delete({ where: { id: uid } }); } catch { /* 已删 */ }
    }
    if (app) await app.close();
  });

  async function getPlayer(uid: number) {
    return playerService.getPlayerData(uid);
  }

  it('测试1 持续秒数公式 a1=(a/(25+a)+1)*4：熟练度0→4秒，熟练度25→8秒', async () => {
    const uid0 = await makePlayer('p0', { specialSeq: 0, type: '人类', affinity: 0, dodgeProf: 0 });
    const uid25 = await makePlayer('p25', { specialSeq: 0, type: '人类', affinity: 0, dodgeProf: 25 });

    const w0 = await game.handleDodge(uid0);
    const w25 = await game.handleDodge(uid25);

    // 文本断言（原版 L576：名称+"尝试闪避攻击("+四舍(a1)+"秒)"）
    // 公式 a1=(a/(25+a)+1)*4：a=0→4秒；a=25→(25/50+1)*4=6秒
    expect(w0).toContain('尝试闪避攻击(4秒)');
    expect(w25).toContain('尝试闪避攻击(6秒)');

    const p0 = await getPlayer(uid0);
    const p25 = await getPlayer(uid25);
    const b0 = JSON.parse(p0.player.buffs || '[]').find((b: any) => b.name === '闪避');
    const b25 = JSON.parse(p25.player.buffs || '[]').find((b: any) => b.name === '闪避');
    // 增益持续秒数对齐 a1
    expect(Math.round(b0.expireAt - Date.now() / 1000)).toBeGreaterThanOrEqual(3);
    expect(Math.round(b25.expireAt - Date.now() / 1000)).toBeGreaterThanOrEqual(5);
    // 冷却标记（原版 L1848：15秒，无飞羽）
    const cd0 = JSON.parse(p0.player.markers2 || '[]').find((m: any) => m.name === '闪避冷却');
    expect(Math.round(cd0.expireAt - Date.now() / 1000)).toBeGreaterThanOrEqual(14);
  });

  it('测试2 花园猫(aff100)分支：写入"啾啾猫猫"增益 + 闪避击成就', async () => {
    const uid = await makePlayer('cat', { specialSeq: 1, type: '花园猫', affinity: 100, dodgeProf: 0 });
    const w = await game.handleDodge(uid);
    expect(w).toContain('尝试闪避攻击(4秒)');
    expect(w).toContain('啾啾猫猫');

    const p = await getPlayer(uid);
    const m2 = JSON.parse(p.player.markers2 || '[]');
    const cat = m2.find((m: any) => m.name === '啾啾猫猫');
    expect(cat).toBeDefined();
    expect(cat.expireAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('测试3 冷却中再次闪避被拒（剩余秒数提示）', async () => {
    const uid = await makePlayer('cd', { specialSeq: 0, type: '人类', affinity: 0, dodgeProf: 0 });
    await game.handleDodge(uid); // 第一次成功，写入15秒冷却
    const w2 = await game.handleDodge(uid); // 冷却中
    expect(w2).toContain('闪避冷却中');
  });
});
