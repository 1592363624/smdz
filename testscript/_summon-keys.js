/**
 * 怪物 / 召唤物存量数据键名核对（一次性诊断）
 * 目的：确认 GameMonster 行与地图 summons 条目里实际出现的键名，
 *      判断「载具 / 编号 / 属性 / 套装」等中文键是否真的还有存量数据。
 */
const { PrismaClient } = require('../server/node_modules/@prisma/client');
require('../server/node_modules/dotenv').config({ path: 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/.env' });
const prisma = new PrismaClient();

const tally = (bag, obj) => { for (const k of Object.keys(obj || {})) bag.set(k, (bag.get(k) || 0) + 1); };

(async () => {
  const ms = await prisma.gameMonster.findMany({ take: 300 });
  const mb = new Map();
  for (const m of ms) tally(mb, m);
  console.log(`GameMonster 行数=${ms.length}`);
  console.log('行键:', [...mb.keys()].join(','));

  const maps = await prisma.gameMap.findMany({ take: 200 });
  const sb = new Map();
  const cn = new Map();
  let n = 0;
  for (const mp of maps) {
    for (const s of (Array.isArray(mp.summons) ? mp.summons : [])) {
      n++;
      tally(sb, s);
      for (const k of Object.keys(s || {})) if (/[\u4e00-\u9fa5]/.test(k)) cn.set(k, (cn.get(k) || 0) + 1);
      for (const inner of ['属性', '套装', '载具', '标记', '武器', '装备', '加成']) {
        if (s && s[inner] !== undefined) tally(cn, { [inner]: 1 });
      }
    }
  }
  console.log(`\n地图召唤物条目数=${n}`);
  console.log('条目键:', [...sb.entries()].map(([k, c]) => `${k}=${c}`).join('  '));
  console.log('中文键:', [...cn.entries()].map(([k, c]) => `${k}=${c}`).join('  '));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e.message); await prisma.$disconnect(); });