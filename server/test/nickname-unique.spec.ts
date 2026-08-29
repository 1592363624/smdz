/**
 * 昵称全局唯一：注册（uniquifyNickname 自动去重）与手动改名（updateNickname 拒绝占用）
 * 覆盖 用户昵称禁止重复 规则：
 * - 注册路径：QQ 昵称被占用时自动追加 #序号，不阻断注册；
 * - 手动路径：目标昵称被他人占用时抛 ConflictException，空昵称视为未设置不参与校验。
 */
import { ConflictException, BadRequestException } from '@nestjs/common';
import { UsersService } from '../src/modules/users/users.service';

/** 构造基于内存数组的 Prisma mock（仅覆盖 UsersService 用到的字段） */
function buildPrisma(users: any[]) {
  return {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where?.id !== undefined) return users.find((u) => u.id === where.id) || null;
        if (where?.username !== undefined) {
          return users.find((u) => u.username === where.username) || null;
        }
        return null;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        if (where?.nickname !== undefined) {
          return (
            users.find(
              (u) =>
                u.nickname === where.nickname &&
                (where?.id?.not === undefined || u.id !== where.id.not),
            ) || null
          );
        }
        return null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.find((x) => x.id === where.id);
        Object.assign(u, data);
        return u;
      }),
      create: jest.fn(async ({ data }: any) => {
        const u = { id: users.length + 1, ...data };
        users.push(u);
        return u;
      }),
    },
    player: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 1 })),
    },
  };
}

describe('updateNickname - 昵称禁止重复', () => {
  it('目标昵称被其他玩家占用时抛 ConflictException', async () => {
    const users: any[] = [
      { id: 1, nickname: 'Alice', username: 'u1' },
      { id: 2, nickname: 'Bob', username: 'u2' },
    ];
    const service = new UsersService(buildPrisma(users) as any);

    await expect(service.updateNickname(2, 'Alice')).rejects.toThrow(ConflictException);
  });

  it('设置自己的现有昵称不视为冲突', async () => {
    const users: any[] = [
      { id: 1, nickname: 'Alice', username: 'u1' },
      { id: 2, nickname: 'Ali', username: 'u2' },
    ];
    const service = new UsersService(buildPrisma(users) as any);

    const result = await service.updateNickname(1, 'Alice');
    expect(result.nickname).toBe('Alice');
  });

  it('昵称前后空白会被清理后落库', async () => {
    const users: any[] = [{ id: 1, nickname: 'Alice', username: 'u1' }];
    const service = new UsersService(buildPrisma(users) as any);

    const result = await service.updateNickname(1, '  新名字  ');
    expect(result.nickname).toBe('新名字');
    expect(users[0].nickname).toBe('新名字');
  });

  it('空白昵称抛 BadRequestException', async () => {
    const users: any[] = [{ id: 1, nickname: 'Alice', username: 'u1' }];
    const service = new UsersService(buildPrisma(users) as any);

    await expect(service.updateNickname(1, '   ')).rejects.toThrow(BadRequestException);
  });

  it('超长昵称抛 BadRequestException', async () => {
    const users: any[] = [{ id: 1, nickname: 'Alice', username: 'u1' }];
    const service = new UsersService(buildPrisma(users) as any);

    await expect(service.updateNickname(1, 'x'.repeat(21))).rejects.toThrow(BadRequestException);
  });
});

describe('uniquifyNickname - 注册自动去重', () => {
  it('基名空闲时原样返回', async () => {
    const users: any[] = [{ id: 1, nickname: 'Alice', username: 'u1' }];
    const service = new UsersService(buildPrisma(users) as any);

    await expect(service.uniquifyNickname('Charlie')).resolves.toBe('Charlie');
  });

  it('基名被占用时追加 #序号直到唯一', async () => {
    const users: any[] = [
      { id: 1, nickname: 'Alice', username: 'u1' },
      { id: 2, nickname: 'Alice#2', username: 'u2' },
    ];
    const service = new UsersService(buildPrisma(users) as any);

    await expect(service.uniquifyNickname('Alice')).resolves.toBe('Alice#3');
  });

  it('注册自动去重：重复 QQ 昵称也能成功创建（昵称不冲突）', async () => {
    const users: any[] = [{ id: 1, nickname: '小白', username: 'qq_a' }];
    const prisma = buildPrisma(users);
    const service = new UsersService(prisma as any);

    const unique = await service.uniquifyNickname('小白');
    expect(unique).toBe('小白#2');

    const created = await prisma.user.create({
      data: { username: 'qq_b', nickname: unique, password: 'x' },
    });
    // 同昵称仅一条
    const dup = users.filter((u) => u.nickname === '小白');
    expect(dup).toHaveLength(1);
    expect(created.nickname).toBe('小白#2');
  });
});