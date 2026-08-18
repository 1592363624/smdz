/**
 * 一次性存量数据修复脚本：将已开局玩家重置为「新开局结构」(选使魔之前的状态)
 *
 * 背景：项目将 BonusData 全量迁移为「中文 key」后，存量库玩家数据需回退到未开始游玩态，
 * 以便重新按最新逻辑选使魔开局（方案A：全改中文 key + 存量数据重置为新开局结构）。
 *
 * 判定「已开局」依据：player.type 非空（门禁逻辑 player.type === '' 表示未开始游戏）。
 *
 * 重置目标态严格对齐 PlayerService.getOrCreatePlayer() 创建时的初始值：
 *   - 基础属性：level=1, exp=0, upgradeExp=calcUpgradeExp(1)=6, name='冒险者', type=''
 *   - 战斗属性：hp=100,maxHp=100,shield=0,maxShield=0,armor=0,maxArmor=0,
 *              attack=10,defense=0,speed=100,dodge=0,hit=100,crit=5,critDmg=150, regen*=0
 *   - 位置：出生地图(新手村/医疗室/首个地图)
 *   - 复杂字段：初始背包/武器/装备、markers={指引:0}、titles=['新人']、tasks=新手教程
 *             其余背包类字段回退 []/{}
 *   - 好感/活力：affinity=0, vitality=0
 *
 * 同时清理该玩家在地图 summon 中的「前线」召唤物（按 QQ==玩家qqNumber 过滤）。
 * 不删除公屏 ChatMessage / CommandLog（频道级数据，不影响玩家状态，保留无害）。
 *
 * 用法（务必先 dry-run 确认再 apply）：
 *   npx ts-node scripts/reset-players-to-newgame.ts            # 仅打印计划，不写库
 *   npx ts-node scripts/reset-players-to-newgame.ts --apply    # 真正写库
 */

// @ts-nocheck
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const APPLY = process.argv.includes('--apply');

/** 升级经验公式（对齐 player.service.calcUpgradeExp，加成=0 时 1级=6） */
function calcUpgradeExp(level: number): number {
  return (level * level + 5) * (1 + 0 / 100) * (1 - 0 / 100);
}

/** 读取 tasks.json 的「新手教程」requirements（字符串或数组兼容） */
function getTutorialRequirements(): Array<{ name: string; count: number }> {
  try {
    const fs = require('fs');
    const raw = fs.readFileSync(path.resolve(process.cwd(), 'prisma/data/tasks.json'), 'utf8');
    const t = JSON.parse(raw);
    const arr: any[] = Array.isArray(t) ? t : (t.tasks || []);
    const tutorial = arr.find((o: any) => o.name === '新手教程');
    if (!tutorial) return [];
    const reqs = typeof tutorial.requirements === 'string'
      ? JSON.parse(tutorial.requirements)
      : (tutorial.requirements || []);
    return Array.isArray(reqs) ? reqs : [];
  } catch {
    return [];
  }
}

async function main() {
  const prisma = new PrismaClient();
  await prisma.$connect();
  console.log(`[reset] mode=${APPLY ? 'APPLY (will write DB)' : 'DRY-RUN (no writes)'} env DATABASE_URL=${process.env.DATABASE_URL ? 'set' : 'MISSING'}`);

  // 所有用户（id -> qqNumber）
  const users = await prisma.user.findMany({ select: { id: true, qqNumber: true } });
  const qqByUserId: Record<number, string> = {};
  for (const u of users) qqByUserId[u.id] = u.qqNumber || '';

  // 解析出生地图
  const startMap =
    (await prisma.gameMap.findFirst({ where: { name: '新手村' } })) ||
    (await prisma.gameMap.findFirst({ where: { name: '医疗室' } })) ||
    (await prisma.gameMap.findFirst({ orderBy: { id: 'asc' } }));
  const startMapId = startMap?.id ?? 0;
  const startMapName = startMap?.name ?? '新手村';
  console.log(`[reset] startMap: id=${startMapId} name=${startMapName}`);

  const tutorialReqs = getTutorialRequirements();
  console.log(`[reset] tutorial requirements count=${tutorialReqs.length}`);

  const initialBackpack = [
    { name: '石斧', type: '装备', quantity: 1, durability: 0, data: 'e' },
    { name: '皮帽', type: '装备', quantity: 1, durability: 0, data: 'e' },
    { name: '布衣', type: '装备', quantity: 1, durability: 0, data: 'e' },
    { name: '新手补给', type: '消耗品', quantity: 1, durability: 0, data: '' },
    { name: '面包', type: '消耗品', quantity: 3, durability: 0, data: '' },
  ];
  const initialWeapons = [{ name: '石斧', type: '武器', slot: 1, quantity: 1, durability: 0, data: 'e' }];
  const initialEquipment = [{ name: '布衣', type: '装备', slot: '身体', quantity: 1, durability: 0, data: 'e' }];
  const initialTasks = tutorialReqs.length > 0 ? [{ name: '新手教程', requirements: JSON.parse(JSON.stringify(tutorialReqs)) }] : [];

  const players = await prisma.player.findMany();
  const toReset = players.filter((p: any) => p.type && p.type !== '');
  console.log(`[reset] total players=${players.length}, to reset (type!='')=${toReset.length}`);

  for (const p of toReset) {
    const qq = qqByUserId[p.userId] || '';
    const updateData = {
      level: 1,
      exp: 0,
      upgradeExp: calcUpgradeExp(1),
      name: '冒险者',
      type: '',
      hp: 100, maxHp: 100,
      shield: 0, maxShield: 0,
      armor: 0, maxArmor: 0,
      attack: 10, defense: 0, speed: 100, dodge: 0, hit: 100, crit: 5, critDmg: 150,
      regenHp: 0, regenShield: 0, regenArmor: 0,
      mapId: startMapId, location: startMapName,
      houseName: '',
      backpack: JSON.stringify(initialBackpack),
      equipment: JSON.stringify(initialEquipment),
      weapons: JSON.stringify(initialWeapons),
      currentWeapon: 0,
      markers: JSON.stringify({ 指引: 0 }),
      markers2: '[]',
      buffs: '[]',
      tasks: JSON.stringify(initialTasks),
      titles: JSON.stringify(['新人']),
      skills: '{}',
      sets: '{}',
      bonus: '{}',
      baseBonus: '{}',
      vehicle: '',
      safeBox: '[]',
      equipmentPresets: '[]',
      reverse: '[]',
      recipes: '[]',
      stats: '{}',
      affinity: 0,
      masterQQ: '',
      vitality: 0,
      lastOpTime: 0,
      readTime: 0,
    };

    console.log(`[reset] userId=${p.userId} qq=${qq || '(unknown)'} name=${p.name} type=${p.type} level=${p.level} -> newgame`);
    if (APPLY) {
      await prisma.player.update({ where: { id: p.id }, data: updateData });
      // 清理该玩家在地图 summon 中的前线召唤物（按 QQ 过滤）
      if (qq) {
        const maps = await prisma.gameMap.findMany({ select: { id: true, summons: true } });
        for (const m of maps) {
          let arr: any[] = [];
          try { arr = JSON.parse(m.summons || '[]'); } catch { arr = []; }
          const filtered = arr.filter((s: any) => String(s.QQ) !== String(qq));
          if (filtered.length !== arr.length) {
            await prisma.gameMap.update({ where: { id: m.id }, data: { summons: JSON.stringify(filtered) } });
            console.log(`[reset]   cleaned summons on map ${m.id}: ${arr.length} -> ${filtered.length}`);
          }
        }
      }
    }
  }

  console.log(`[reset] ${APPLY ? 'APPLIED' : 'DRY-RUN only'}: ${toReset.length} players reset.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('[reset] FATAL', e);
  process.exit(1);
});
