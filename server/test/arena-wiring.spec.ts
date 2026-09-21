/**
 * 竞技场接线冒烟测试（不连库、不起服务）。
 *
 * 三件事都是「跑起来才会炸」的问题，这里提前用静态方式钉住：
 * 1. **DI 元数据完整**：本项目的 CommonJS 循环加载会让被 import 的类变成 undefined
 *    （service-tokens.ts 记录过同类事故）。构造参数类型解析不出来时 Nest 启动才报错，
 *    这里用 design:paramtypes 直接验；
 * 2. **指令已注册**：handlerKey 必须在 handlerProviders 里存在，否则指令分发报「未找到指令」；
 * 3. **配置项都有人读**：系统配置页只放真设置——任何 arena.* 键若在代码里无人读取，
 *    就是给后台留了个假开关（与 checkin/lottery 的既有口径一致，用源码静态扫描兜底）。
 */
import * as fs from 'fs';
import * as path from 'path';
import 'reflect-metadata';
import { ARENA_CONFIG_KEYS, ARENA_DEFAULT_CONFIGS } from '../src/config/arena.config';
import { ArenaHandler } from '../src/modules/command/handlers/arena.handler';
import { handlerProviders } from '../src/modules/command/handlers';
import { ArenaService } from '../src/modules/game/arena/arena.service';
import { ArenaBattleService } from '../src/modules/game/arena/arena-battle.service';
import { ArenaSeasonService } from '../src/modules/game/arena/arena-season.service';
import { EntitlementService } from '../src/modules/game/entitlement.service';
import { CheckinRewardService } from '../src/modules/game/checkin-reward.service';

const SERVER_ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(SERVER_ROOT, 'src');

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

describe('竞技场接线冒烟', () => {
  it('新增服务的构造参数类型都能解析（循环加载不会把它们打成 undefined）', () => {
    const targets: Array<[string, any, number]> = [
      ['ArenaBattleService', ArenaBattleService, 1],
      ['EntitlementService', EntitlementService, 4],
      ['ArenaService', ArenaService, 8],
      ['ArenaSeasonService', ArenaSeasonService, 7],
      ['CheckinRewardService', CheckinRewardService, 4],
      ['ArenaHandler', ArenaHandler, 2],
    ];
    for (const [name, ctor, expected] of targets) {
      const types = Reflect.getMetadata('design:paramtypes', ctor) as any[] | undefined;
      // 断言里带上类名：失败时一眼看出是哪个依赖被循环加载打成了 undefined
      expect({ name, hasMeta: Array.isArray(types), count: types?.length ?? -1 }).toEqual({
        name, hasMeta: true, count: expected,
      });
      expect(types!.every((t) => !!t)).toBe(true);
    }
  });

  it('ArenaHandler 已进注册表，key 与 Command.handlerKey 对应', () => {
    expect(handlerProviders).toContain(ArenaHandler);
    const instance = new ArenaHandler({} as any, {} as any);
    expect(instance.key).toBe('arena');
    expect(instance.module).toBe('game');
  });

  it('seed 里注册的 arena 指令都能被分发到（handlerKey 已在注册表，且指令名/别名不自称冲突）', () => {
    const seedPath = path.join(SERVER_ROOT, 'prisma', 'seed.ts');
    const seed = fs.readFileSync(seedPath, 'utf8');
    const arenaRows = [...seed.matchAll(/\{ name: '([^']+)', alias: '([^']*)', description: '[^']*', handlerKey: 'arena'/g)];
    expect(arenaRows.length).toBeGreaterThanOrEqual(7);
    // handlerKey='arena' 必须能命中注册表里的 handler（上面一条已断言 ArenaHandler.key）
    expect(new ArenaHandler({} as any, {} as any).key).toBe('arena');
    const seenNames = new Set<string>();
    const seenAliases = new Set<string>();
    for (const [, name, alias] of arenaRows) {
      // 指令名/别名不得自我重复（分发按精确匹配，重复行只会让 help 列表出现两条）
      expect(seenNames.has(name)).toBe(false);
      seenNames.add(name);
      for (const one of alias.split(',').map((x) => x.trim()).filter(Boolean)) {
        expect(seenAliases.has(one)).toBe(false);
        seenAliases.add(one);
      }
    }
  });

  it('每个 arena.* 配置键都有代码读取点（系统配置页不放假开关）', () => {
    // 默认表所在文件本身不算读取点
    const files = walk(SRC_ROOT).filter((f) => !f.endsWith(path.join('config', 'arena.config.ts')));
    const texts = files.map((f) => fs.readFileSync(f, 'utf8'));
    const fields = Object.keys(ARENA_CONFIG_KEYS) as Array<keyof typeof ARENA_CONFIG_KEYS>;
    expect(fields.length).toBe(ARENA_DEFAULT_CONFIGS.length);
    const unread: string[] = [];
    for (const field of fields) {
      const usage = new RegExp(`ARENA_CONFIG_KEYS\\.${field}\\b`).source;
      const re = new RegExp(usage);
      if (!texts.some((text) => re.test(text))) unread.push(`${field} (${ARENA_CONFIG_KEYS[field]})`);
    }
    expect(unread).toEqual([]);
  });

  it('ARENA_DEFAULT_CONFIGS 的键与 ARENA_CONFIG_KEYS 一一对应（无孤儿键、无重复行）', () => {
    const declared: Set<string> = new Set(Object.values(ARENA_CONFIG_KEYS));
    const seen = new Set<string>();
    for (const entry of ARENA_DEFAULT_CONFIGS) {
      expect({ key: entry.key, declared: declared.has(entry.key), duplicated: seen.has(entry.key) })
        .toEqual({ key: entry.key, declared: true, duplicated: false });
      seen.add(entry.key);
      expect(entry.group).toBe('arena');
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.description.trim().length).toBeGreaterThan(0);
    }
    expect(seen.size).toBe(declared.size);
  });
});
