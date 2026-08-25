/* 临时诊断脚本6：检查 CommandLog 全部历史里 source=astrbot 的记录 + 检查是否有别的进程在写库 */
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

  // MySQL 当前进程列表：看有没有多个应用连接在跑
  try {
    const procs = await p.$queryRawUnsafe('SHOW PROCESSLIST');
    console.log(`=== MySQL PROCESSLIST (${procs.length}) ===`);
    for (const r of procs) {
      const info = String(r.Info || '').slice(0, 60).replace(/\s+/g, ' ');
      console.log(`id=${r.Id} db=${r.db} cmd=${r.Command} time=${r.Time}s | ${info}`);
    }
  } catch (e) {
    console.log('PROCESSLIST 失败(权限):', e.message);
  }

  // CommandLog 表里今天最后一条写入时间（确认写库的是哪个时段的实例）
  const lastLog = await p.commandLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true, command: true, source: true } });
  const fmt = (d) => d ? new Date(d).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-';
  console.log(`\nCommandLog 最后一条: ${fmt(lastLog?.createdAt)} ${lastLog?.source} ${lastLog?.command}`);

  // 系统消息表最后一条
  const lastMsg = await p.chatMessage.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true, type: true, content: true } });
  console.log(`ChatMessage 最后一条: ${fmt(lastMsg?.createdAt)} type=${lastMsg?.type} | ${(lastMsg?.content || '').slice(0, 50)}`);

  // 数据库当前时间 vs 本机时间
  const nowRow = await p.$queryRawUnsafe('SELECT NOW() as n');
  const dbNow = new Date(nowRow[0].n);
  console.log(`\nDB NOW()=${dbNow.toISOString()} | 本机=${new Date().toISOString()}`);

  await p.$disconnect();
}

main().catch((e) => { console.error('诊断失败:', e.message); process.exit(1); });
