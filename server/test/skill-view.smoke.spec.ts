/**
 * 技能查看功能冒烟测试（真实库）
 *
 * 验证「查看使魔」「查看使魔详细」「使魔技能」「通用技能」「技能导航」
 * 输出彼此不同且与原版流程一致，不复刻为重复内容。
 *
 * 依赖：真实 smdz 库 + 账号 路人甲（若不存在则提示跳测试）。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { GameService } from '../src/modules/game/game.service';
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';

jest.setTimeout(120000);

describe('技能查看功能冒烟（真实库）', () => {
  let app: any;
  let prisma: PrismaService;
  let game: GameService;
  let familiarSystem: FamiliarSystemService;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    prisma = app.get(PrismaService);
    game = app.get(GameService);
    familiarSystem = app.get(FamiliarSystemService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('输出区分：查看使魔 / 查看使魔详细 / 使魔技能 / 通用技能 / 技能导航', async () => {
    // 复用 路人甲 账号；不存在则跳过（不影响其他用例）
    const user = await prisma.user.findFirst({ where: { username: '路人甲' }, select: { id: true } });
    if (!user) {
      console.log('[skip] 未找到 路人甲 账号，跳过冒烟输出校验');
      return;
    }
    const uid = user.id;
    const player = await prisma.player.findUnique({ where: { userId: uid }, select: { type: true } });
    if (!player?.type) {
      console.log('[skip] 路人甲尚无使魔类型，跳过');
      return;
    }

    const basic = await familiarSystem.viewFamiliarData(uid, false);
    const detail = await familiarSystem.viewFamiliarData(uid, true);
    const famSkills = await game.handleFamiliarSkills(uid);
    const common = await game.handleCommonSkills(uid);
    // 导航流程：查看使魔 →「1、更多」→ 更多子菜单 → 查看技能 导航
    const viewFamiliar = await game.handleViewFamiliar(uid);
    const familiarMore = await game.handleFamiliarMore(uid);
    const familData = await game.handleFamiliarData(uid);
    const viewSkills = await game.handleViewSkills(uid);

    console.log('\n========== 查看使魔(基础) ==========\n' + basic);
    console.log('\n========== 查看使魔详细 ==========\n' + detail);
    console.log('\n========== 使魔技能 ==========\n' + famSkills);
    console.log('\n========== 通用技能 ==========\n' + common);
    console.log('\n========== 查看使魔(含更多) ==========\n' + viewFamiliar);
    console.log('\n========== 更多子菜单 ==========\n' + familiarMore);
    console.log('\n========== 使魔数据 ==========\n' + familData);
    console.log('\n========== 查看技能导航 ==========\n' + viewSkills);

    // 基础视图不应包含「使魔技能」的技能说明/好感解锁 以示区分
    expect(basic).not.toContain('技能说明');
    // 基础视图（详细=false）不应出现详细抗性块
    expect(basic).not.toContain('◆');
    // 详细视图同样不重复技能说明
    expect(detail).not.toContain('技能说明');
    // 使魔技能应包含技能说明与好感解锁
    expect(famSkills).toContain('技能等级:');

    // 原版复刻：查看使魔 末尾只带「1、更多」，进入「更多」后再出现四个子项
    expect(viewFamiliar).toContain('1、更多');
    expect(viewFamiliar).not.toContain('查看技能'); // 查看使魔本身不直接展开子菜单
    // 更多 子菜单四个子项与顺序对齐原版 L4110-L4112
    for (const item of ['使魔数据', '查看技能', '查看使魔详细', '被动效果']) {
      expect(familiarMore).toContain(item);
    }
    // 使魔数据 = 基础数据展示（无更多子菜单）
    expect(familData).toBe(basic);
    // 查看技能 导航菜单五个子项对齐原版 L5550
    for (const item of ['通用技能', '使魔技能', '查看成就', '查看标记', '查看标记2']) {
      expect(viewSkills).toContain(item);
    }

    // 四个核心视图两两不同
    const outputs = [basic, detail, famSkills, common];
    for (let i = 0; i < outputs.length; i++) {
      for (let j = i + 1; j < outputs.length; j++) {
        expect(outputs[i]).not.toEqual(outputs[j]);
      }
    }
    // 查看使魔/详细 应与 使魔技能/通用技能 不同
    expect(viewFamiliar).not.toEqual(famSkills);
    expect(viewFamiliar).not.toEqual(common);

    // ===== 被动效果：原版复刻「来自装备/武器的被动效果」分层 + 召唤物/套装 =====
    const passive = await game.handlePassiveEffects(uid);
    console.log('\n========== 被动效果 ==========\n' + passive);
    expect(passive).toContain('当前拥有的被动效果');
    expect(passive).toContain('来自装备的被动效果');
    expect(passive).toContain('来自武器的被动效果');

    // ===== 通用技能：采集等级必须与真实玩家标记「采集熟练度」对齐 =====
    // 读取玩家真实 markers 中的「采集熟练度」，按原版公式推算出等级，再与通用技能输出比对。
    const raw = await prisma.player.findUnique({ where: { userId: uid }, select: { markers: true } });
    const markersObj = typeof raw?.markers === 'string' ? JSON.parse(raw.markers || '{}') : (raw?.markers || {});
    const prof = Math.max(0, Number(markersObj['采集熟练度']) || 0);
    let lvl = 1;
    while (prof >= lvl * lvl) lvl += 1;
    const expText = `采集等级:${lvl}(${Math.round(prof * 100) / 100}/${lvl * lvl})`;
    console.log('\n[对齐校验] 真实「采集熟练度」标记 → ' + expText);
    expect(common).toContain(expText);
  });
});