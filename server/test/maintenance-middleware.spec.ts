/**
 * 维护模式中间件单元测试（纯桩，无 DB 依赖）
 *
 * 中间件通过 process.cwd()/maintenance.flag 探测维护开关（jest 运行 cwd = server/ 根），
 * 且内置 2 秒 TTL 缓存；因此每个用例通过 jest.isolateModules 重新加载模块获得干净的
 * 缓存状态，并在用例结束后清理 flag 文件，避免污染其他套件。
 */

import * as fs from 'fs';
import * as path from 'path';

const FLAG_PATH = path.join(process.cwd(), 'maintenance.flag');

type MockRes = {
  statusCode: number;
  headers: Record<string, string>;
  body: any;
  status: jest.Mock;
  setHeader: jest.Mock;
  json: jest.Mock;
  send: jest.Mock;
};

function createMockRes(): MockRes {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined,
  };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.setHeader = jest.fn((name: string, value: string) => {
    res.headers[name.toLowerCase()] = value;
    return res;
  });
  res.json = jest.fn((payload: any) => {
    res.body = payload;
    return res;
  });
  res.send = jest.fn((payload: any) => {
    res.body = payload;
    return res;
  });
  return res as MockRes;
}

function loadMiddleware(): {
  maintenanceMiddleware: (req: any, res: any, next: () => void) => void;
} {
  let exported: any;
  jest.isolateModules(() => {
    exported = require('../src/maintenance/maintenance.middleware');
  });
  return exported;
}

function createFlag(): void {
  fs.writeFileSync(FLAG_PATH, new Date().toISOString(), 'utf8');
}

function removeFlag(): void {
  if (fs.existsSync(FLAG_PATH)) fs.unlinkSync(FLAG_PATH);
}

afterEach(() => {
  removeFlag();
});

describe('maintenance.middleware', () => {
  it('flag 不存在时直接放行（next 被调用）', () => {
    removeFlag();
    const { maintenanceMiddleware } = loadMiddleware();
    const next = jest.fn();
    const res = createMockRes();

    maintenanceMiddleware({ path: '/' } as any, res as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('维护激活时非 API 页面请求返回维护 HTML（200）', () => {
    createFlag();
    const { maintenanceMiddleware } = loadMiddleware();
    const next = jest.fn();
    const res = createMockRes();

    maintenanceMiddleware({ path: '/chat' } as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(String(res.body)).toContain('系统维护中');
    // 维护页必须包含恢复自检逻辑（轮询版本接口后自动刷新）
    expect(String(res.body)).toContain('/api/system/version');
  });

  it('维护激活时普通 API 请求返回 503 + code=MAINTENANCE', () => {
    createFlag();
    const { maintenanceMiddleware } = loadMiddleware();
    const next = jest.fn();
    const res = createMockRes();

    maintenanceMiddleware({ path: '/api/commands/execute' } as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toMatchObject({ code: 'MAINTENANCE' });
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('维护激活时 /api/system/version 同样返回 503（维护页据此判断恢复）', () => {
    createFlag();
    const { maintenanceMiddleware } = loadMiddleware();
    const res = createMockRes();

    maintenanceMiddleware({ path: '/api/system/version' } as any, res as any, jest.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toMatchObject({ code: 'MAINTENANCE' });
  });

  it('维护激活时 /api/docs 放行（部署健康检查依赖）', () => {
    createFlag();
    const { maintenanceMiddleware } = loadMiddleware();
    const next = jest.fn();
    const res = createMockRes();

    maintenanceMiddleware({ path: '/api/docs' } as any, res as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('维护激活时 /ws 路径的 HTTP 请求返回 503', () => {
    createFlag();
    const { maintenanceMiddleware } = loadMiddleware();
    const res = createMockRes();

    maintenanceMiddleware({ path: '/ws/socket.io/' } as any, res as any, jest.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toMatchObject({ code: 'MAINTENANCE' });
  });
});
