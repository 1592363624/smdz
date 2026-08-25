/* 临时诊断脚本4：检查 CommandLog 里今天的完整分布 + 系统消息时间线 */
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

  const dayStart = new Date('2026-08-25T00:00:00+08:00');
  const now = new Date();

  // 今天所有指令日志
  const logs = await p.commandLog.findMany({
    where: { createdAt: { gte: dayStart } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, command: true, source: true, senderId: true },
  });
  console.log(`=== 今日 CommandLog 共 ${logs.length} 条 ===`);
  for (const l of logs) {
    const t = l.createdAt.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log(`${t} | ${l.source} | sender=${l.senderId} | ${l.command}`);
  }

  // 系统消息里"收集到了"的最早与最晚
  const first = await p.chatMessage.findFirst({
    where: { content: { contains: '收集到了' }, createdAt: { gte: dayStart } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, type: true, senderId: true, content: true },
  });
  const last = await p.chatMessage.findFirst({
    where: { content: { contains: '收集到了' }, createdAt: { gte: dayStart } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, type: true, senderId: true, content: true },
  });
  const fmt = (d) => d ? new Date(d).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-';
  console.log(`\n第一条收集消息: ${fmt(first?.createdAt)} type=${first?.type} senderId=${first?.senderId}`);
  console.log(`最后一条收集消息: ${fmt(last?.createdAt)} type=${last?.type} senderId=${last?.senderId}`);
  console.log(`最后一条内容: ${(last?.content || '').slice(0, 80).replace(/\n/g, ' | ')}`);

  // 13:02 之后该玩家还有没有其他系统消息（比如"采集完成"）
  const after = await p.chatMessage.findMany({
    where: { createdAt: { gt: new Date('2026-08-25T13:01:30+08:00') }, senderId: 2 },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, type: true, content: true },
  });
  console.log(`\n=== 13:01:30 后 userId=2 相关消息 ${after.length} 条 ===`);
  for (const m of after.slice(0, 15)) {
    console.log(`${fmt(m.createdAt)} | ${m.type} | ${m.content.slice(0, 60).replace(/\n/g, ' | ')}`);
  }

  await p.$disconnect();
}

main().catch((e) => { console.error('诊断失败:', e.message); process.exit(1); });
