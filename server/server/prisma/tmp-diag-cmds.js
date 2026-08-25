/* 临时诊断脚本8：检查 Command 表里「观察附近」「收集木头」等指令的注册情况 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();

  // 指令表里有没有 数字 / 收集木头 等
  const cmds = await p.command.findMany({
    where: { enabled: true },
    select: { name: true, handlerKey: true },
  });
  console.log(`启用指令共 ${cmds.length} 条`);
  const interesting = cmds.filter((c) => /^\d+$/.test(c.name) || c.name.includes('收集') || ['1', '2', '3'].includes(c.name));
  console.log('数字/收集类指令:', JSON.stringify(interesting));

  // 玩家2的 markers 里 shortcut 数据（持久化快捷键）
  const player = await p.player.findFirst({ where: { userId: 2 }, select: { markers: true } });
  let m = {};
  try { m = typeof player.markers === 'string' ? JSON.parse(player.markers) : player.markers; } catch {}
  console.log('\nshortcuts 标记:', JSON.stringify(m['shortcuts'] ?? null).slice(0, 300));

  await p.$disconnect();
}

main().catch((e) => { console.error('诊断失败:', e.message); process.exit(1); });
