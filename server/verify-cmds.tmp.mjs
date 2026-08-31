const BASE = 'http://localhost:3333/api';
async function post(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  return r.json();
}
(async () => {
  const login = await post('/auth/dev/login', { username: '路人甲' });
  const token = login.data?.access_token || login.accessToken || login.access_token || login.data?.accessToken;
  if (!token) { console.log('LOGIN FAIL', JSON.stringify(login)); return; }
  for (const c of ['查看使魔', '使魔更多', '通用技能', '被动效果']) {
    const res = await post('/commands/execute', { command: c }, token);
    const txt = (res.content && String(res.content)) || JSON.stringify(res);
    console.log('===== [' + c + '] =====');
    console.log(txt);
    console.log('');
  }
})();