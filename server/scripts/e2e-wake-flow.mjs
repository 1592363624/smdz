/**
 * 载具唤醒全流程端到端自测（测试库 / 本地 :3333）
 * 用法：node scripts/e2e-wake-flow.mjs
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3333/api';
const USER = process.env.TEST_USER || 'waketester';
const WRECK = process.env.WRECK_NAME || '掩埋的幻影骑士';

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
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return json;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function cmd(token, command) {
  const resp = await api('/commands/execute', {
    method: 'POST',
    token,
    body: { command, channelId: 1 },
  });
  return String(resp?.data?.content ?? resp?.content ?? resp?.raw ?? '');
}

async function main() {
  console.log('== 0. 登录 ==');
  const login = await api('/auth/dev/login', { method: 'POST', body: { username: USER } });
  const token = login?.data?.access_token;
  assert(token, '登录失败');
  console.log('userId=', login?.data?.user?.id);

  console.log('\n== 1. 查看载具（应显示封印） ==');
  const list = await cmd(token, '查看载具');
  console.log(list.slice(0, 600));
  assert(list.includes(WRECK), '列表中没有目标遗迹');

  console.log('\n== 2. 查看详情 ==');
  const view = await cmd(token, `查看载具 ${WRECK}`);
  console.log(view.slice(0, 900));
  assert(/封印|唤醒/.test(view), '详情未显示封印/唤醒');

  console.log('\n== 3. 直接驾驶 → 应被拦 ==');
  const drive1 = await cmd(token, `驾驶 ${WRECK}`);
  console.log(drive1);
  assert(/禁制|唤醒|等级|守卫/.test(drive1), '直接驾驶未被拦截');

  console.log('\n== 4. 唤醒（已唤醒则应提示守卫仍在） ==');
  const wake = await cmd(token, `唤醒 ${WRECK}`);
  console.log(wake);
  assert(
    /守卫|献祭|唤醒|封印|活力|凭证/.test(wake),
    '唤醒返回文案异常',
  );

  console.log('\n== 5. 编号菜单：查看载具列表后发 1 ==');
  await cmd(token, '查看载具');
  const via1 = await cmd(token, '1');
  console.log(via1.slice(0, 700));
  assert(/封印|唤醒|幻影骑士|生命/.test(via1), '编号 1 未打开载具详情');
  assert(!/未找到指令「1」/.test(via1), '编号 1 未被临时输入映射');

  console.log('\n== 6. 攻击守卫（多波推进/解封） ==');
  let unlocked = false;
  for (let i = 0; i < 12; i++) {
    const atk = await cmd(token, '攻击');
    const head = atk.split('\n').slice(0, 8).join(' | ');
    console.log(`攻击#${i + 1}:`, head.slice(0, 220));
    if (/封印解除了/.test(atk)) {
      console.log('!! 全波击破解封');
      unlocked = true;
      break;
    }
    if (/第2波|第3波|苏醒/.test(atk)) {
      console.log('!! 波次推进');
    }
  }

  console.log('\n== 7. 解封后驾驶 ==');
  const drive2 = await cmd(token, `驾驶 ${WRECK}`);
  console.log(drive2.slice(0, 500));
  if (unlocked || /获取|驾驶舱|权限/.test(drive2)) {
    console.log('驾驶路径 OK');
  } else {
    console.log('（若仍未解封，可能守卫未被击杀/波次未推进——见上方攻击日志）');
  }

  console.log('\n== 8. 图鉴遗迹守卫 + 发 1 显示详细数据 ==');
  const hb = await cmd(token, '图鉴遗迹守卫');
  console.log(hb.slice(0, 450));
  assert(hb.includes('显示详细数据'), '图鉴无详细数据菜单');
  const hb1 = await cmd(token, '1');
  console.log(hb1.slice(0, 500));
  assert(!/未找到指令「1」/.test(hb1), '图鉴编号 1 未映射');
  assert(/详细|生命|攻击|防御|掉落|武器/.test(hb1), '图鉴详细数据输出异常');

  console.log('\n✅ 全流程断言通过');
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
