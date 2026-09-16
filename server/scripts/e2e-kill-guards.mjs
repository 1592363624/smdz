/**
 * 定点击杀遗迹守卫 → 验证波次推进/解封
 * 用法：node scripts/e2e-kill-guards.mjs
 */
const BASE = 'http://127.0.0.1:3333/api';
const USER = 'waketester';
const WRECK = '掩埋的幻影骑士';

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const json = JSON.parse(text);
  if (!res.ok) throw new Error(`${path} ${res.status} ${text.slice(0, 300)}`);
  return json;
}

async function cmd(token, command) {
  const resp = await api('/commands/execute', {
    method: 'POST',
    token,
    body: { command, channelId: 1 },
  });
  return String(resp?.data?.content ?? '');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const login = await api('/auth/dev/login', { method: 'POST', body: { username: USER } });
  const token = login.data.access_token;

  // 若尚未唤醒，先唤醒
  const view = await cmd(token, `查看载具 ${WRECK}`);
  if (/被封印/.test(view) && /需要「唤醒」/.test(view)) {
    console.log('先唤醒…');
    console.log(await cmd(token, `唤醒 ${WRECK}`));
  } else {
    console.log('状态:\n', view.split('\n').filter((l) => /封印|守卫|归属|主人/.test(l)).join('\n'));
  }

  // 定点打遗迹守卫，跳过冷却
  for (let i = 0; i < 40; i++) {
    await sleep(5200);
    const atk = await cmd(token, '攻击 遗迹守卫');
    const interesting = /击破|苏醒|解除|守卫|冷却|没有可以|史莱姆/.test(atk);
    if (interesting || i < 3 || /遗迹守卫/.test(atk)) {
      console.log(`\n--- 攻击#${i + 1} ---`);
      console.log(atk.split('\n').filter(Boolean).slice(0, 10).join('\n').slice(0, 400));
    }
    if (/封印解除了/.test(atk)) {
      console.log('\n✅ 解封成功');
      console.log(await cmd(token, `驾驶 ${WRECK}`));
      return;
    }
    if (/第2波|第3波/.test(atk)) {
      console.log('\n→ 波次推进');
    }
  }
  console.log('\n（未在 40 次内解封；查看当前状态）');
  console.log((await cmd(token, `查看载具 ${WRECK}`)).split('\n').filter((l) => /封印|守卫|主人|归属/.test(l)).join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
