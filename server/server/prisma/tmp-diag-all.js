/* 临时诊断脚本10：检查 CommandLog 里 senderId=2 在12:55~13:05 的所有记录（不限指令名）+ 检查 chat gateway 是否有自动重发 */
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

  // 12:55 之后 senderId=2 的全部 command log
  const logs = await p.commandLog.findMany({
    where: { createdAt: { gte: new Date('2026-08-25T12:55:00+08:00') }, senderId: 2 },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, command: true, source: true },
  });
  const fmt = (d) => new Date(d).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  console.log(`=== 12:55 后 sender=2 指令日志 共 ${logs.length} 条 ===`);
  for (const l of logs) {
    console.log(`${fmt(l.createdAt)} | ${l.source} | ${l.command}`);
  }

  // 系统消息：12:56 后 senderId=2 的全部类型统计
  const msgs = await p.chatMessage.findMany({
    where: { createdAt: { gte: new Date('2026-08-25T12:56:00+08:00') } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, type: true, senderId: true, content: true },
  });
  console.log(`\n=== 12:56 后全部频道消息 ${msgs.length} 条 ===`);
  for (const m of msgs) {
    if (m.type !== 'system') continue;
    console.log(`${fmt(m.createdAt)} | ${m.type} | sender=${m.senderId} | ${m.content.slice(0, 50).replace(/\n/g, ' | ')}`);
  }

  await p.$disconnect();
}

main().catch((e) => { console.error('诊断失败:', e.message); process.exit(1); });
