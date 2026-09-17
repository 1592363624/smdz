/**
 * 从 jest 全量日志中提取失败用例的「用例名 + 断言差异 + 位置」精简报告。
 * 用法：node _extract-failures.js
 */
const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, '_jest-full.log');
const raw = fs.readFileSync(logPath, 'utf8');
const lines = raw.split(/\r?\n/);

const out = [];
let i = 0;
let currentSuite = '';
while (i < lines.length) {
  const line = lines[i];
  const failMatch = line.match(/^FAIL\s+(\S+)/);
  if (failMatch) {
    currentSuite = failMatch[1];
    i += 1;
    continue;
  }
  if (/^\s+●\s/.test(line) && !/Console|Cannot log after tests/.test(line)) {
    const title = line.trim().replace(/^●\s*/, '');
    const block = [title];
    // 收集后续 14 行中第一个断言差异块
    let j = i + 1;
    let grabbed = 0;
    while (j < lines.length && !/^\s+●\s/.test(lines[j]) && !/^FAIL\s/.test(lines[j])) {
      const l = lines[j];
      if (/Expected|Received|at Object\.<anonymous>|说|等待|TypeError|toContain|toBe|toEqual/.test(l) && grabbed < 8) {
        if (l.trim()) {
          block.push('    ' + l.trim());
          grabbed += 1;
        }
      }
      j += 1;
      if (grabbed >= 8) break;
    }
    out.push('[' + currentSuite + ']\n  ' + block.join('\n  '));
    i = j;
    continue;
  }
  i += 1;
}

fs.writeFileSync(path.join(__dirname, '_failures-report.txt'), out.join('\n\n'), 'utf8');
console.log('失败用例块数：', out.length);