/**
 * 清除玩家游戏数据脚本（保留账号，不删除 user）
 * ------------------------------------------------------------------
 * 作用：将指定 username 对应玩家的所有游戏进度重置为"未开始游玩"的初始状态，
 *       等同新建玩家首次进入（保留 user 账号，可重新登录 → 重新选使魔开始）。
 *
 * 说明：
 * - 只更新 Player 行字段，不删除 user（账号保留）。
 * - 初始结构对齐 PlayerService.getOrCreatePlayer 的新玩家初始化逻辑。
 *
 * 用法: npx ts-node prisma/reset-player-data.ts <username>
 * 例:   npx ts-node prisma/reset-player-data.ts 1592363624
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const DATA_DIR = path.resolve(__dirname, 'data');

/** 读取任务定义，为初始玩家还原"新手教程"任务（新格式 {name, requirements}） */
function loadTutorialTask(): Array<{ name: string; requirements: Array<{ name: string; count: number }> }> {
  const file = path.join(DATA_DIR, 'tasks.json');
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const t = (rows || []).find(r => r?.name === '新手教程');
    if (t) {
      const arr = JSON.parse(t.requirements || '[]');
      if (Array.isArray(arr) && arr.length) {
        return [{ name: '新手教程', requirements: arr }];
      }
    }
  } catch { /* 忽略，退回空任务 */ }
  return [];
}

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('用法: npx ts-node prisma/reset-player-data.ts <username>');
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    console.error(`未找到账号: ${username}`);
    process.exitCode = 1;
    return;
  }

  const player = await prisma.player.findUnique({ where: { userId: user.id } });
  if (!player) {
    console.log(`账号 ${username}(userId=${user.id}) 尚无玩家记录，无需重置。`);
    return;
  }

  // 初始背包（与新玩家一致）
  const initialBackpack = [
    { name: '石斧', type: '装备', quantity: 1, durability: 0, data: 'e' },
    { name: '皮帽', type: '装备', quantity: 1, durability: 0, data: 'e' },
    { name: '布衣', type: '装备', quantity: 1, durability: 0, data: 'e' },
    { name: '新手补给', type: '消耗品', quantity: 1, durability: 0, data: '' },
    { name: '面包', type: '消耗品', quantity: 3, durability: 0, data: '' },
  ];
  const initialWeapons = [{ name: '石斧', type: '武器', slot: 1, quantity: 1, durability: 0, data: 'e' }];
  const initialEquipment = [{ name: '布衣', type: '装备', slot: '身体', quantity: 1, durability: 0, data: 'e' }];
  const initialMarkers = { '指引': 0 };
  const initialTitles = ['新人'];

  // 初始任务：新手教程
  const initialTasks = loadTutorialTask();

  // 从起始地图（第一个可用地图）重算 id；无则退回 1
  const startMap = await prisma.gameMap.findFirst({ orderBy: { mapIndex: 'asc' } });
  const startMapId = startMap?.id ?? 1;
  const startMapName = startMap?.name ?? '';

  // 重置所有游戏进度字段（保留 id / userId / createdAt / updatedAt）
  await prisma.player.update({
    where: { id: player.id },
    data: {
      level: 1,
      exp: 0,
      upgradeExp: 100,
      name: '冒险者',
      type: '',
      specialSeq: 0,
      hp: 100,
      maxHp: 100,
      shield: 0,
      maxShield: 0,
      armor: 0,
      maxArmor: 0,
      attack: 10,
      defense: 0,
      speed: 100,
      dodge: 0,
      hit: 100,
      crit: 5,
      critDmg: 150,
      regenHp: 0,
      regenShield: 0,
      regenArmor: 0,
      mapId: startMapId,
      location: startMapName,
      houseName: '',
      backpack: JSON.stringify(initialBackpack),
      equipment: JSON.stringify(initialEquipment),
      weapons: JSON.stringify(initialWeapons),
      currentWeapon: 0,
      markers: JSON.stringify(initialMarkers),
      markers2: '[]',
      buffs: '[]',
      tasks: JSON.stringify(initialTasks),
      titles: JSON.stringify(initialTitles),
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
      lastOpTime: BigInt(0),
      readTime: BigInt(0),
    },
  });

  console.log(`✅ 已清空账号 ${username}(userId=${user.id}) 的全部游戏数据，已重置为"未开始游玩"初始状态。`);
  console.log(`   起始地图: ${startMapName || '(无)'} (id=${startMapId})`);
  console.log(`   该账号可重新登录后重新"选择使魔"开始游戏，账号本身未删除。`);
}

main()
  .catch((e) => { console.error('重置过程发生错误:', e.message); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); console.log('已断开数据库连接'); });