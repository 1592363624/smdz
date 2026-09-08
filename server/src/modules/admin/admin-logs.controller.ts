/**
 * 后台日志查看控制器（只读）
 *
 * 背景：生产环境由 pm2 守护（见 server/ecosystem.config.js），标准输出/错误分别落入
 * `server/logs/out.log` 与 `server/logs/error.log`。管理员此前只能登上远程服务器
 * 用终端 tail 查看，排障链路长。本控制器把日志以只读方式暴露给管理界面：
 *   - GET /admin/logs/files        列出可读日志文件（名称/大小/修改时间）
 *   - GET /admin/logs/tail         按「尾部 N 行 / 增量跟随 / 关键字 / 级别」读取
 *
 * 安全约束：
 *   1. 仅 ADMIN/SUPER_ADMIN 可访问（与其它管理接口同一套守卫）；
 *   2. 只读：不提供写、清、删、轮转能力，避免日志被篡改或误清；
 *   3. 目录白名单 + 路径穿越防护：只允许读取日志目录内的**普通文件**；
 *   4. 单次读取字节上限受控（默认 512KB，硬上限 4MB），防止大文件拖垮进程。
 */

import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { existsSync, promises as fs } from 'fs';
import { basename, extname, join, resolve, sep } from 'path';
import { homedir } from 'os';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/** 允许的日志扩展名（pm2 与常见日志轮转产物） */
const ALLOWED_EXT = new Set(['.log', '.txt', '.out', '.err']);

/** 单次读取字节数：默认 512KB，硬上限 4MB */
const DEFAULT_CHUNK = 512 * 1024;
const MAX_CHUNK = 4 * 1024 * 1024;

/** 候选日志目录：环境变量 > 进程 cwd/logs（pm2 生态配置） > pm2 默认目录 */
function candidateLogDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.LOG_DIR) dirs.push(process.env.LOG_DIR);
  dirs.push(join(process.cwd(), 'logs'));
  dirs.push(join(homedir(), '.pm2', 'logs'));
  return dirs.filter((d) => !!d && existsSync(d));
}

function resolveLogDir(): string {
  const dirs = candidateLogDirs();
  return dirs.length > 0 ? resolve(dirs[0]) : resolve(join(process.cwd(), 'logs'));
}

@ApiTags('管理员')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/logs')
export class AdminLogsController {
  /** 把用户传入的文件名安全地解析为日志目录内的绝对路径；越界返回 null。 */
  private safeResolve(name: string): string | null {
    if (!name) return null;
    // 只接受文件名（禁止任何目录分隔符，杜绝 ../ 穿越）
    if (name.includes('/') || name.includes('\\')) return null;
    const dir = resolveLogDir();
    const target = resolve(dir, basename(name));
    if (target !== dir && !target.startsWith(dir + sep)) return null;
    if (!ALLOWED_EXT.has(extname(target).toLowerCase())) return null;
    return target;
  }

  /**
   * 列出可查看的日志文件
   */
  @Get('files')
  @ApiOperation({ summary: '列出后台日志文件（只读）' })
  async listFiles() {
    const dir = resolveLogDir();
    if (!existsSync(dir)) {
      return { success: true, data: { dir, files: [] } };
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [] as Array<{ name: string; size: number; modifiedAt: string }>;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!ALLOWED_EXT.has(extname(entry.name).toLowerCase())) continue;
      try {
        const stat = await fs.stat(join(dir, entry.name));
        files.push({
          name: entry.name,
          size: stat.size,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
        });
      } catch {
        // 单文件 stat 失败（被轮转/占用）不影响其余文件
      }
    }
    files.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
    return { success: true, data: { dir, files } };
  }

  /**
   * 读取日志内容
   * - tail 模式（默认）：读文件尾部 chunk 字节，返回最后 limit 行
   * - 跟随模式（since>0）：从指定字节偏移读到文件末尾，配合返回的 offset 实现增量轮询
   */
  @Get('tail')
  @ApiOperation({ summary: '读取日志尾部/增量（只读，支持关键字与级别过滤）' })
  @ApiQuery({ name: 'file', required: false, description: '日志文件名，默认 out.log' })
  @ApiQuery({ name: 'lines', required: false, description: '返回行数上限，默认 200，最大 2000' })
  @ApiQuery({ name: 'keyword', required: false, description: '关键字过滤（忽略大小写）' })
  @ApiQuery({ name: 'level', required: false, description: '级别过滤：LOG/ERROR/WARN/DEBUG' })
  @ApiQuery({ name: 'since', required: false, description: '增量跟随起点（字节偏移），>0 时只返回新增内容' })
  async tail(
    @Query('file', new DefaultValuePipe('out.log')) file: string,
    @Query('lines', new DefaultValuePipe(200), ParseIntPipe) lines: number,
    @Query('keyword', new DefaultValuePipe('')) keyword: string,
    @Query('level', new DefaultValuePipe('')) level: string,
    @Query('since', new DefaultValuePipe(0), ParseIntPipe) since: number,
  ) {
    const target = this.safeResolve(file);
    if (!target || !existsSync(target)) {
      throw new BadRequestException(`日志文件不可读：${file}`);
    }
    const stat = await fs.stat(target);
    const limit = Math.min(Math.max(1, Number(lines) || 200), 2000);
    const kw = String(keyword || '').trim().toLowerCase();
    const lv = String(level || '').trim().toUpperCase();

    // 增量跟随：从 since 读到文件末尾；文件被轮转（size < since）时退回全量尾部读取
    let start = 0;
    let length = Math.min(Number(stat.size), DEFAULT_CHUNK);
    if (Number(since) > 0 && Number(since) < Number(stat.size)) {
      start = Number(since);
      length = Math.min(Number(stat.size) - start, MAX_CHUNK);
    } else {
      start = Math.max(0, Number(stat.size) - DEFAULT_CHUNK);
      length = Number(stat.size) - start;
    }

    const handle = await fs.open(target, 'r');
    let text = '';
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      text = buffer.toString('utf8');
    } finally {
      await handle.close();
    }

    let rows = text.split(/\r?\n/);
    // 首行可能是被截断的半行（非增量模式），丢弃
    if (rows.length > 1 && !(Number(since) > 0 && Number(since) < Number(stat.size))) rows.shift();
    if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();

    if (lv) rows = rows.filter((line) => line.toUpperCase().includes(lv));
    if (kw) rows = rows.filter((line) => line.toLowerCase().includes(kw));

    const sliced = rows.slice(Math.max(0, rows.length - limit));
    return {
      success: true,
      data: {
        file: basename(target),
        size: Number(stat.size),
        offset: Number(stat.size), // 下次轮询以此为 since
        truncated: rows.length > limit,
        matched: rows.length,
        lines: sliced,
      },
    };
  }
}
