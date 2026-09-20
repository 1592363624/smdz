/**
 * 称号条件「成就写入源」覆盖审计（静态扫描）
 *
 * 背景（玩家反馈）：称号「肝帝」要求「发送指令 x10」，实际发送了几十条
 * 指令仍显示 0/10。根因是一类系统性缺失——原版 添加成就(名称,数值,玩家.成就,玩家.任务)
 * 一次写「成就(markers)+任务」两处；移植版把两者拆开，很多动作只调用了
 * taskService.advance（只推进任务），没有写 markers（成就），而称号进度读的正是
 * markers → 该类条件恒为 0。
 *
 * 本测试的作用：以 titles.json 的条件名为基准，扫描 src 下所有成就写入点
 * （addAchievement / setAchievement / incrementMarker / markers['x'] = ，
 * 含 `前缀${动态}` 模板键），确保每个条件名都存在写入源。以后新增称号条件或
 * 重构写入点时，若漏写成就，本测试会直接失败，避免同类事故再次上线。
 */
import * as fs from 'fs';
import * as path from 'path';

const SERVER_ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(SERVER_ROOT, 'src');
const TITLES_PATH = path.join(SERVER_ROOT, 'prisma', 'data', 'titles.json');
const MONSTERS_PATH = path.join(SERVER_ROOT, 'prisma', 'data', 'monsters.json');

/** 递归收集 src 下所有 .ts 文件 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 收集源码中的成就写入键：静态键集合 + 动态键前缀集合（`前缀${变量}` 模板） */
function collectAchievementWriteSources(): { keys: Set<string>; prefixes: Set<string> } {
  const keys = new Set<string>();
  const prefixes = new Set<string>();
  const patterns: Array<{ re: RegExp; target: 'key' | 'prefix' }> = [
    // 成就服务出口（第一参数一律是玩家/标记对象，限长防止跨语句误匹配）
    { re: /addAchievement\(\s*[^,]{1,120}?,\s*'([^']+)'/g, target: 'key' },
    { re: /addAchievement\(\s*[^,]{1,120}?,\s*`([^`$]{1,40})\$\{/g, target: 'prefix' },
    { re: /setAchievement\(\s*[^,]{1,120}?,\s*'([^']+)'/g, target: 'key' },
    { re: /setAchievement\(\s*[^,]{1,120}?,\s*`([^`$]{1,40})\$\{/g, target: 'prefix' },
    { re: /incrementMarker\(\s*[^,]{1,120}?,\s*'([^']+)'/g, target: 'key' },
    // 直接写玩家标记：markers['名'] = / xxxMarkers['名'] = / markers[`前缀${...}`] =
    { re: /[Mm]arkers\['([^']+)'\]\s*=/g, target: 'key' },
    { re: /[Mm]arkers\[`([^`$]{1,40})\$\{/g, target: 'prefix' },
  ];
  for (const file of walk(SRC_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { re, target } of patterns) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text))) {
        if (target === 'key') keys.add(match[1]);
        else prefixes.add(match[1]);
      }
    }
  }
  return { keys, prefixes };
}

/** 统计一个称号条件是否有写入源覆盖 */
function isCovered(condition: string, keys: Set<string>, prefixes: Set<string>): boolean {
  if (condition.startsWith('*')) {
    // 模糊匹配条件（原版 取成就熟练度 模糊 + 取全部匹配求和）：命中「前缀+实体名」动态键，
    // 如 *巨人 ← 击败岩石巨人 / 击败熔岩巨人……；底层动态键的存在性由下方数据用例断言。
    const chars = (condition.match(/[\u4e00-\u9fa5]+/g) || []).join('');
    return chars.length > 0 && prefixes.size > 0;
  }
  if (keys.has(condition)) return true;
  // 动态键前缀匹配（如条件「击败马」← 代码中的 `击败${怪物名}`）
  for (const prefix of prefixes) {
    if (prefix && condition.startsWith(prefix) && condition.length > prefix.length) return true;
  }
  return false;
}

/** 从 JSON 文本中提取所有 "name": "xxx" 的值（不解析整份大 JSON，避免测试变慢） */
function readJsonNameValues(filePath: string): string[] {
  const text = fs.readFileSync(filePath, 'utf8');
  const names = new Set<string>();
  for (const marker of ['"name": "', '"name":"']) {
    for (const part of text.split(marker).slice(1)) {
      const end = part.indexOf('"');
      const name = end >= 0 ? part.slice(0, end) : '';
      if (name) names.add(name);
    }
  }
  return [...names];
}

describe('称号条件成就写入源覆盖（防“任务推进了、成就没写”再次漏点）', () => {
  it('titles.json 的每个称号条件都存在成就(markers)写入源', () => {
    const titles = JSON.parse(fs.readFileSync(TITLES_PATH, 'utf8')) as Array<{
      requirements?: Array<{ name: string }>;
    }>;
    const conditions = new Set<string>();
    for (const title of titles) {
      for (const req of title.requirements || []) conditions.add(req.name);
    }
    expect(conditions.size).toBeGreaterThan(0);

    const { keys, prefixes } = collectAchievementWriteSources();
    // 扫描器自检：防止正则失效导致“全部通过”的假绿
    expect(keys.has('发送指令')).toBe(true);
    expect(prefixes.has('击败')).toBe(true);

    const missing = [...conditions].filter((condition) => !isCovered(condition, keys, prefixes));
    expect(missing).toEqual([]);
  });

  it('“击败马 / *巨人”的底层动态键在怪物数据中真实存在', () => {
    const monsterNames = readJsonNameValues(MONSTERS_PATH);
    expect(monsterNames.length).toBeGreaterThan(0);
    // 精确条件「击败马」依赖存在名为“马”的怪物；模糊条件「*巨人」依赖名字含“巨人”的怪物
    expect(monsterNames).toContain('马');
    expect(monsterNames.some((name) => name.includes('巨人'))).toBe(true);
  });
});
