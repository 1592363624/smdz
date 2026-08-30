import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve('src');
const EX = ['player-mutate.service.ts', 'player.service.ts'];

function walk(d) {
  let o = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) o.push(...walk(f));
    else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) o.push(f);
  }
  return o;
}

function countNonComment(file, re) {
  let n = 0;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const l = raw.trim();
    if (l.startsWith('//') || l.startsWith('*') || l.startsWith('/*')) continue;
    const m = l.match(re);
    if (m) n += m.length;
  }
  return n;
}

const files = walk(SRC).filter((f) => !EX.some((n) => f.endsWith(n)));
const agg = { savePlayer: new Map(), getPlayerData: new Map(), withUserLock: new Map(), mutate: new Map(), read: new Map() };
for (const f of files) {
  const rel = path.relative(SRC, f);
  for (const [k, re] of [
    ['savePlayer', /savePlayer\s*\(/g],
    ['getPlayerData', /getPlayerData\s*\(/g],
    ['withUserLock', /withUserLock\s*\(/g],
    ['mutate', /\.mutate\s*\(/g],
    ['read', /\.read\s*\(/g],
  ]) {
    const c = countNonComment(f, re);
    if (c > 0) agg[k].set(rel, c);
  }
}
function show(k) {
  const m = agg[k];
  const arr = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const total = arr.reduce((s, [, c]) => s + c, 0);
  console.log('\n=== ' + k + ' : total=' + total + ' across ' + arr.length + ' files ===');
  for (const [f, c] of arr) console.log('  ' + String(c).padStart(4) + '  ' + f);
}
['savePlayer', 'getPlayerData', 'withUserLock', 'mutate', 'read'].forEach(show);
