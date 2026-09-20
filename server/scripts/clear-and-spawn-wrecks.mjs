/**
 * 一次性运维脚本：
 * 1) 清空正式/测试库地图 vehicles 中的无主废弃载具
 * 2) 各生成 1 个带封印字段的遗迹（验证等级门槛/唤醒）
 *
 * 注意：第 2 步不幂等，每跑一次都会多生成一个遗迹。
 *
 * 用法（在 server 目录）：
 *   node scripts/clear-and-spawn-wrecks.mjs            # 默认 test + prod 两库
 *   node scripts/clear-and-spawn-wrecks.mjs test|prod  # 只处理单库
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '../prisma/data');

function loadJson(name) {
  return JSON.parse(readFileSync(join(dataDir, name), 'utf8'));
}

function isOwnerless(v) {
  const owner = String(v?.归属 ?? v?.owner ?? '');
  return owner === '' || owner === '无主';
}

function parseVehicles(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rollWreck(wrecks) {
  const rollPass = () => {
    const total = wrecks.length;
    for (let a = 1; a <= total; a++) {
      const chance = Number(wrecks[total - a]?.chance ?? 0);
      if (Math.random() * 100 < chance) return a;
    }
    return 0;
  };
  let b = rollPass();
  for (let guard = 0; guard < 10000 && b === 0; guard++) b = rollPass();
  if (b === 0) return wrecks[0];
  return wrecks[b - 1];
}

function buildSealedWreck(wreck, levelOffset = 0) {
  const requireLevel = Math.max(1, (Number(wreck.requireLevel) || 100) + levelOffset);
  const guardWaves = Math.max(1, Math.trunc(Number(wreck.guardWaves ?? 1)) || 1);
  const cost = wreck.sealCost && typeof wreck.sealCost === 'object' ? wreck.sealCost : {};
  const vouchers = Math.max(1, Math.trunc(Number(cost.vouchers ?? 1)) || 1);
  const vitality = Math.max(2, Math.trunc(Number(cost.vitality ?? 2)) || 2);
  const seq = `${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const vehicleId = `V${seq}`;
  const name = String(wreck.name ?? '废弃载具').replace(/[0-9]/g, '');
  const parts = (wreck.parts ?? []).map((part) => {
    const partName = String(part?.name ?? '').trim();
    if (!partName) return null;
    // 零件数量规范键 quantity，count 仅作旧键兜底
    const qty = Number(part?.quantity ?? part?.count ?? 1) || 1;
    return {
      名称: partName,
      name: partName,
      类型: '资源',
      type: '资源',
      数量: qty,
      quantity: qty,
      耐久: 100,
      durability: 100,
    };
  }).filter(Boolean);

  // 简化生命：与常见残骸量级对齐（无完整 recalculate）
  const hp = 1000 + requireLevel * 10;

  return {
    名称: name,
    name,
    类型: name.replace(/废弃|损坏|坠毁|可疑|掩埋的?/g, '').trim() || '载具',
    type: name.replace(/废弃|损坏|坠毁|可疑|掩埋的?/g, '').trim() || '载具',
    编号: vehicleId,
    vehicleId,
    归属: '无主',
    owner: '无主',
    驾驶员: '',
    driver: '',
    需求等级: requireLevel,
    requireLevel,
    封印等级: requireLevel,
    sealLevel: requireLevel,
    守卫波数: guardWaves,
    guardWaves,
    献祭凭证: vouchers,
    sacrificeVouchers: vouchers,
    献祭活力: vitality,
    sacrificeVitality: vitality,
    封印中: true,
    sealed: true,
    当前生命: hp,
    currentHp: hp,
    生命: hp,
    maxHp: hp,
    上限: 0,
    slotStatus: 0,
    行走方式: 0,
    moveType: 0,
    零件: parts,
    parts,
    配方: [],
    recipes: [],
    加成: { 生命: hp },
    bonus: { 生命: hp },
    标记: {},
    markers: {},
    标记2: [],
    markers2: [],
    逆转力场: false,
    reverseField: false,
    发丝: false,
    hair: false,
    涂层: 0,
    coating: 0,
  };
}

async function processDb(label, url, { clear = true, spawn = true } = {}) {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$connect();
    const maps = await prisma.gameMap.findMany({
      select: { id: true, name: true, vehicles: true, isFrontier: true, isInstance: true, noTeleport: false },
    });

    let cleared = 0;
    const clearedByMap = [];
    for (const map of maps) {
      const vehicles = parseVehicles(map.vehicles);
      if (!vehicles.length) continue;
      const kept = vehicles.filter((v) => !isOwnerless(v));
      const removed = vehicles.length - kept.length;
      if (removed <= 0) continue;
      cleared += removed;
      clearedByMap.push(`${map.name}×${removed}`);
      await prisma.gameMap.update({
        where: { id: map.id },
        data: { vehicles: kept.length ? kept : [] },
      });
    }

    let spawnInfo = '未生成';
    if (spawn) {
      const wrecks = loadJson('wrecks.json');
      const wreck = rollWreck(wrecks);
      const candidates = maps.filter((m) =>
        Number(m.id) >= 3 && !m.isFrontier && !m.isInstance,
      );
      if (!candidates.length) {
        spawnInfo = '无合适地图可生成';
      } else {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        const runtime = buildSealedWreck(wreck, 0);
        const existing = parseVehicles(
          maps.find((m) => m.id === target.id)?.vehicles,
        );
        await prisma.gameMap.update({
          where: { id: target.id },
          data: { vehicles: [...existing, runtime] },
        });
        spawnInfo =
          `在「${target.name}」生成「${runtime.名称}」 ${runtime.vehicleId} ` +
          `Lv.${runtime.需求等级} 封印/波数${runtime.守卫波数}/凭证${runtime.献祭凭证}/活力${runtime.献祭活力}`;
      }
    }

    // 汇总当前全图无主数
    const mapsAfter = await prisma.gameMap.findMany({ select: { vehicles: true } });
    let ownerlessNow = 0;
    for (const map of mapsAfter) {
      for (const v of parseVehicles(map.vehicles)) {
        if (isOwnerless(v)) ownerlessNow += 1;
      }
    }

    console.log(`\n=== ${label} ===`);
    console.log(`清理无主载具: ${cleared} 个`);
    if (clearedByMap.length) console.log(`  明细: ${clearedByMap.join(', ')}`);
    console.log(`生成: ${spawnInfo}`);
    console.log(`清理后全图无主载具: ${ownerlessNow}`);
  } finally {
    await prisma.$disconnect();
  }
}

const TEST_URL =
  'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=100';
// 正式库优先走远程 52shell.ltd（本机 127.0.0.1 仅在服务器上可用）
const PRD_URL =
  process.env.PRD_DATABASE_URL ||
  'mysql://smdz:EDzCnyba6HYnx5MT@52shell.ltd:3306/smdz?charset=utf8mb4&connection_limit=100';

const mode = process.argv[2] || 'both';

async function main() {
  if (mode === 'test' || mode === 'both') {
    await processDb('测试库 smdztest', TEST_URL);
  }
  if (mode === 'prd' || mode === 'prod' || mode === 'both') {
    await processDb('正式库 smdz', PRD_URL);
  }
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
