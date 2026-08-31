const base = 'http://localhost:3333/api';
const user = 'lrtest' + Math.floor(Math.random() * 9999);
async function post(path, body, headers = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: res.status, json: j };
}
async function cmd(c, H) {
  const r = await post('/commands/execute', { command: c }, H);
  return r.json.data && (r.json.data.content !== undefined ? r.json.data.content : JSON.stringify(r.json.data));
}
(async () => {
  const login = await post('/auth/dev/login', { username: user });
  const H = { Authorization: 'Bearer ' + (login.json.data?.access_token || '') };
  await cmd('选择使魔确认花园猫', H);
  console.log('[第1次] 查看使魔（应显示新手引导）');
  console.log(await cmd('查看使魔', H));
  console.log('\n[第2次] 查看使魔（应显示数据+更多菜单）');
  console.log(await cmd('查看使魔', H));
  console.log('\n[按1] 触发「更多」子菜单（临时快捷 1@使魔更多）');
  console.log(await cmd('1', H));
})().catch(e => { console.error('FATAL', e); process.exit(1); });