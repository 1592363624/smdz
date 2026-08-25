/* 临时诊断脚本7：用正确字段名读 PROCESSLIST */
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

  try {
    const procs = await p.$queryRawUnsafe('SELECT Id, db, Command, Time, State, Info FROM information_schema.PROCESSLIST ORDER BY Time DESC');
    console.log(`=== PROCESSLIST (${procs.length}) ===`);
    for (const r of procs) {
      const info = String(r.Info || '').slice(0, 70).replace(/\s+/g, ' ');
      console.log(`id=${r.Id} cmd=${r.Command} time=${r.Time}s state=${r.State} | ${info}`);
    }
  } catch (e) {
    console.log('PROCESSLIST 失败:', e.message);
  }

  await p.$disconnect();
}

main().catch((e) => { console.error('诊断失败:', e.message); process.exit(1); });
