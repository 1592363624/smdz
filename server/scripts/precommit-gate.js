/**
 * 提交前门禁：tsc 类型检查 + 全量 jest。
 * 全绿退出码 0；任何一步失败立即以非零码退出，用于 commit 前自检。
 * 用法：node scripts/precommit-gate.js
 *
 * 实现说明：直接用当前 node 可执行文件调用 typescript/jest 的 js 入口，
 * 避免 Windows 上 spawnSync 无 shell 时无法启动 .cmd（Node≥18 返回 EINVAL）的问题。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const serverDir = path.resolve(__dirname, '..');
const node = process.execPath;

function run(label, scriptJs, args) {
  console.log(`\n===== ${label} =====`);
  const r = spawnSync(node, [scriptJs, ...args], {
    cwd: serverDir,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env },
  });
  if (r.status !== 0 || r.error) {
    if (r.error) console.error(r.error);
    console.error(`\n[门禁失败] ${label} 退出码 ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

run(
  'TypeScript 类型检查',
  path.join(serverDir, 'node_modules', 'typescript', 'bin', 'tsc'),
  ['-p', 'tsconfig.build.json', '--noEmit'],
);
run(
  '全量单元/集成测试',
  path.join(serverDir, 'node_modules', 'jest', 'bin', 'jest.js'),
  ['--silent'],
);

console.log('\n✅ 门禁通过：类型检查与全量测试均绿，可以提交。');
